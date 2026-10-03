import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ifcToThreePoint, threeWorldToIfc, type ModelExtraTransform } from "../ifc/georef";
import { DEFAULT_JIB_LENGTH, DEFAULT_MAST_HEIGHT, type PlanNote, type PlanPath, type PlanPoint, type PlanTerrain, type SitePlan } from "../planning/sitePlan";
import { catalogSlot, catalogUrl, DUMP_TRUCK_ID, TOWER_CRANE_ID } from "../site/catalogModels";
import type { SimulationStateBuckets } from "../schedule/simulation";

interface BoundModel {
  object: THREE.Object3D;
  group: THREE.Group;
}

/** Vista gerada dos parâmetros. A malha não entra no `.vtwin` nem no IFC. */
export class SitePlanLayer {
  private readonly models = new Map<string, BoundModel>();
  private readonly meshes = new Map<string, THREE.Object3D>();
  private selectedId = "";
  private plan: SitePlan | null = null;
  private applied = false;
  private lastBuckets: SimulationStateBuckets | null = null;
  private lastPreview = true;

  bind(modelId: string, object: THREE.Object3D): void {
    const previous = this.models.get(modelId);
    previous?.group.removeFromParent();
    const group = new THREE.Group();
    group.name = "site-plan";
    object.add(group);
    this.models.set(modelId, { object, group });
    if (this.plan) this.sync(this.plan);
  }

  unbind(modelId: string): void {
    const bound = this.models.get(modelId);
    if (!bound) return;
    bound.group.removeFromParent();
    this.models.delete(modelId);
    if (this.plan) this.sync(this.plan);
  }

  sync(plan: SitePlan): void {
    this.plan = plan;
    const live = new Set<string>();
    const place = (id: string, modelId: string | undefined, build: () => THREE.Object3D, at: PlanPoint, yaw = 0) => {
      const bound = this.boundFor(modelId);
      if (!bound) return;
      live.add(id);
      const previous = this.meshes.get(id);
      previous?.removeFromParent();
      if (previous) disposeObject(previous);
      const mesh = build();
      mesh.name = id;
      bound.group.add(mesh);
      this.meshes.set(id, mesh);
      const point = ifcToThreePoint(at);
      mesh.position.set(point.x, point.y, point.z);
      mesh.rotation.y = -yaw;
      mesh.visible = true;
    };

    for (const crane of plan.cranes) {
      this.ensureCatalog(crane.id, crane.modelId, crane, crane.yaw, crane.catalogId || TOWER_CRANE_ID, (visual) =>
        fitTowerCrane(visual, crane.mastHeight, crane.jibLength),
      );
      live.add(crane.id);
    }
    for (const truck of plan.trucks) {
      this.ensureCatalog(truck.id, truck.modelId, truck, truck.yaw, truck.catalogId || DUMP_TRUCK_ID, () => {});
      live.add(truck.id);
    }
    for (const path of plan.paths) {
      const origin = path.points[0];
      if (!origin) continue;
      place(path.id, path.modelId, () => buildPath(path, origin), origin, 0);
    }
    for (const terrain of plan.terrains) {
      const origin = terrain.contour[0];
      if (!origin || terrain.contour.length < 3) continue;
      place(terrain.id, terrain.modelId, () => buildTerrain(terrain, origin), origin, 0);
    }
    for (const note of plan.notes) {
      place(note.id, note.modelId, () => buildNote(note), note, 0);
    }

    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      mesh.removeFromParent();
      disposeObject(mesh);
      this.meshes.delete(id);
    }
    if (this.applied) this.apply(this.lastBuckets, this.lastPreview);
    else this.paintSelection();
  }

  select(id: string): void {
    this.selectedId = id;
    this.paintSelection();
  }

  selected(): string {
    return this.selectedId;
  }

  groundIfc(
    camera: THREE.Camera,
    event: PointerEvent | MouseEvent,
    dom: HTMLElement,
    modelId: string,
    extra: ModelExtraTransform,
  ): PlanPoint | null {
    const bound = this.models.get(modelId);
    if (!bound) return null;
    const rect = dom.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const origin = new THREE.Vector3();
    bound.object.getWorldPosition(origin);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -origin.y), hit)) return null;
    return threeWorldToIfc(hit, extra);
  }

  pickItem(camera: THREE.Camera, event: PointerEvent | MouseEvent, dom: HTMLElement): string | null {
    const groups = [...this.models.values()].map((bound) => bound.group);
    const rect = dom.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(groups, true).find((item) => item.object.visible);
    let node: THREE.Object3D | null = hit?.object ?? null;
    while (node) {
      if (this.meshes.has(node.name)) return node.name;
      node = node.parent;
    }
    return null;
  }

  apply(buckets: SimulationStateBuckets | null, previewAll: boolean): void {
    this.applied = true;
    this.lastBuckets = buckets;
    this.lastPreview = previewAll;
    for (const [id, mesh] of this.meshes) {
      if (!buckets || previewAll) {
        mesh.visible = true;
        continue;
      }
      const pending = buckets.pending.has(id);
      mesh.visible = !pending;
    }
    this.paintSelection();
  }

  private ensureCatalog(
    id: string,
    modelId: string | undefined,
    at: PlanPoint,
    yaw: number,
    catalogId: string,
    fit: (visual: THREE.Object3D) => void,
  ): void {
    const bound = this.boundFor(modelId);
    if (!bound) return;
    const slot = catalogSlot(catalogId, catalogId);
    let root = this.meshes.get(id);
    if (!root || root.userData.catalogId !== slot.id) {
      if (root) {
        root.removeFromParent();
        disposeObject(root);
      }
      root = new THREE.Group();
      root.name = id;
      root.userData.catalogId = slot.id;
      bound.group.add(root);
      this.meshes.set(id, root);
      const fallback = slot.kind === "crane" ? fallbackCrane() : fallbackTruck();
      fallback.name = "fallback";
      root.add(fallback);
      const generation = (root.userData.generation = Number(root.userData.generation ?? 0) + 1);
      const host = root;
      void loadCatalogTemplate(catalogUrl(slot.file))
        .then((template) => {
          if (host.userData.generation !== generation || !host.parent) return;
          fallback.removeFromParent();
          disposeObject(fallback);
          const visual = template.clone(true);
          visual.name = "catalog-visual";
          ownGeometry(visual);
          host.add(visual);
          fit(visual);
          this.paintSelection();
        })
        .catch(() => {});
    }
    const point = ifcToThreePoint(at);
    root.position.set(point.x, point.y, point.z);
    root.rotation.y = -yaw;
    const visual = root.getObjectByName("catalog-visual");
    if (visual) fit(visual);
  }

  private boundFor(modelId?: string): BoundModel | null {
    if (modelId && this.models.has(modelId)) return this.models.get(modelId) ?? null;
    return this.models.values().next().value ?? null;
  }

  private paintSelection(): void {
    for (const [id, mesh] of this.meshes) paint(mesh, id === this.selectedId ? 0x2fd6bf : null);
  }
}

const templates = new Map<string, Promise<THREE.Object3D>>();

function loadCatalogTemplate(url: string): Promise<THREE.Object3D> {
  const cached = templates.get(url);
  if (cached) return cached;
  const pending = new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().load(url, (gltf) => resolve(gltf.scene), undefined, reject);
  });
  templates.set(url, pending);
  return pending;
}

/** O GLB está modelado no mastro e na lança nominais. Estes nós é que mudam. */
function fitTowerCrane(root: THREE.Object3D, mastHeight: number, jibLength: number): void {
  const mast = root.getObjectByName("mast");
  if (mast) mast.scale.y = Math.max(2, mastHeight) / DEFAULT_MAST_HEIGHT;
  const crown = root.getObjectByName("crown");
  if (crown) {
    const baseY = typeof crown.userData.baseY === "number" ? crown.userData.baseY : crown.position.y;
    crown.userData.baseY = baseY;
    crown.position.y = baseY + (mastHeight - DEFAULT_MAST_HEIGHT);
  }
  const jib = root.getObjectByName("jib");
  if (jib) jib.scale.x = Math.max(2, jibLength) / DEFAULT_JIB_LENGTH;
  const trolley = root.getObjectByName("trolley");
  if (trolley) {
    const baseX = typeof trolley.userData.baseX === "number" ? trolley.userData.baseX : trolley.position.x;
    trolley.userData.baseX = baseX;
    trolley.position.x = baseX + (jibLength - DEFAULT_JIB_LENGTH);
  }
}

function ownGeometry(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry = mesh.geometry.clone();
    const material = mesh.material;
    mesh.material = Array.isArray(material) ? material.map((item) => item.clone()) : material.clone();
  });
}

function fallbackCrane(): THREE.Group {
  const group = new THREE.Group();
  box(group, 2.2, 0.4, 2.2, 0, 0.2, 0, 0x44403c);
  box(group, 0.7, DEFAULT_MAST_HEIGHT, 0.7, 0, DEFAULT_MAST_HEIGHT / 2, 0, 0xf0b429);
  box(group, DEFAULT_JIB_LENGTH, 0.35, 0.35, DEFAULT_JIB_LENGTH / 2, DEFAULT_MAST_HEIGHT, 0, 0x243038);
  return group;
}

function fallbackTruck(): THREE.Group {
  const group = new THREE.Group();
  box(group, 7.2, 1.4, 2.4, 0, 1.3, 0, 0xf0b429);
  box(group, 2.2, 1.3, 2.2, 1.8, 2.1, 0, 0xf0b429);
  box(group, 0.5, 0.5, 0.3, 2.6, 0.35, 0.9, 0x161616);
  box(group, 0.5, 0.5, 0.3, 2.6, 0.35, -0.9, 0x161616);
  box(group, 0.5, 0.5, 0.3, -1.6, 0.35, 0.9, 0x161616);
  box(group, 0.5, 0.5, 0.3, -1.6, 0.35, -0.9, 0x161616);
  return group;
}

function buildPath(path: PlanPath, origin: PlanPoint): THREE.Group {
  const group = new THREE.Group();
  const base = ifcToThreePoint(origin);
  for (let i = 1; i < path.points.length; i++) {
    const a = ifcToThreePoint(path.points[i - 1]!);
    const b = ifcToThreePoint(path.points[i]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.05) continue;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(length, 0.12, 1.6),
      new THREE.MeshLambertMaterial({ color: 0x748891 }),
    );
    mesh.position.set((a.x + b.x) / 2 - base.x, (a.y + b.y) / 2 - base.y + 0.08, (a.z + b.z) / 2 - base.z);
    mesh.rotation.y = Math.atan2(dz, dx);
    group.add(mesh);
  }
  return group;
}

function buildTerrain(terrain: PlanTerrain, origin: PlanPoint): THREE.Group {
  const group = new THREE.Group();
  const base = ifcToThreePoint(origin);
  const shape = new THREE.Shape();
  terrain.contour.forEach((point, index) => {
    const at = ifcToThreePoint(point);
    const x = at.x - base.x;
    const y = at.z - base.z;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();
  const depth = Math.max(0.2, terrain.depth);
  const geom = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: terrain.operation === "cut" ? 0x9b3a2a : 0x087f72 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = terrain.operation === "cut" ? -depth : 0;
  group.add(mesh);
  return group;
}

function buildNote(note: PlanNote): THREE.Group {
  const group = new THREE.Group();
  const pin = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 12, 8),
    new THREE.MeshLambertMaterial({ color: 0x2fd6bf }),
  );
  pin.position.y = 0.4;
  group.add(pin);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#071820";
    ctx.fillRect(0, 8, canvas.width, 48);
    ctx.fillStyle = "#f8fbfa";
    ctx.font = "600 28px 'IBM Plex Sans', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(note.text.slice(0, 22), 12, 32);
  }
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }),
  );
  sprite.position.set(0, 2.2, 0);
  sprite.scale.set(4.2, 1.05, 1);
  group.add(sprite);
  return group;
}

function box(
  group: THREE.Group,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  mesh.position.set(x, y, z);
  group.add(mesh);
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const list = Array.isArray(material) ? material : material ? [material] : [];
    for (const item of list) {
      const mapped = item as THREE.MeshLambertMaterial;
      mapped.map?.dispose();
      item.dispose();
    }
  });
}

function paint(root: THREE.Object3D, hex: number | null): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const material = mesh.material as THREE.MeshLambertMaterial | undefined;
    if (!material || !material.emissive) return;
    if (hex == null) {
      material.emissive.setHex(0x000000);
      material.emissiveIntensity = 0;
      return;
    }
    material.emissive.setHex(hex);
    material.emissiveIntensity = 0.28;
  });
}
