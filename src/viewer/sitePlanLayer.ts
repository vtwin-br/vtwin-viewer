import * as THREE from "three";
import { ifcToThreePoint, threeWorldToIfc, type ModelExtraTransform } from "../ifc/georef";
import type { PlanCrane, PlanNote, PlanPath, PlanPoint, PlanTerrain, SitePlan } from "../planning/sitePlan";
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
      place(crane.id, crane.modelId, () => buildCrane(crane), crane, crane.yaw);
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

  private boundFor(modelId?: string): BoundModel | null {
    if (modelId && this.models.has(modelId)) return this.models.get(modelId) ?? null;
    return this.models.values().next().value ?? null;
  }

  private paintSelection(): void {
    for (const [id, mesh] of this.meshes) paint(mesh, id === this.selectedId ? 0x2fd6bf : null);
  }
}

function buildCrane(crane: PlanCrane): THREE.Group {
  const group = new THREE.Group();
  const mast = Math.max(2, crane.mastHeight);
  const jib = Math.max(2, crane.jibLength);
  box(group, 2.2, 0.4, 2.2, 0, 0.2, 0, 0x44403c);
  box(group, 0.7, mast, 0.7, 0, mast / 2, 0, 0xf59e0b);
  box(group, jib, 0.4, 0.4, jib / 2 - 1, mast - 0.4, 0, 0x111827);
  box(group, 1.4, 0.8, 1.4, -1.1, mast - 0.7, 0, 0x78350f);
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
