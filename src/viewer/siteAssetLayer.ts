import * as THREE from "three";
import type { IfcSession } from "../ifc/ifcSession";
import { ifcToThreePoint, threeWorldToIfc, type ModelExtraTransform } from "../ifc/georef";
import { libraryItem } from "../site/library";
import type { SiteAsset } from "../site/types";
import type { SimulationStateBuckets } from "../schedule/simulation";

interface BoundModel {
  object: THREE.Object3D;
  session: IfcSession;
  group: THREE.Group;
}

/** Malhas leves dos equipamentos. A caixa no STEP é a geometria gravada; isto é a vista. */
export class SiteAssetLayer {
  private readonly models = new Map<string, BoundModel>();
  private readonly meshes = new Map<string, THREE.Object3D>();
  private selectedGuid = "";

  bind(modelId: string, object: THREE.Object3D, session: IfcSession): void {
    const previous = this.models.get(modelId);
    previous?.group.removeFromParent();
    const group = new THREE.Group();
    group.name = "site-assets";
    object.add(group);
    this.models.set(modelId, { object, session, group });
  }

  unbind(modelId: string): void {
    const bound = this.models.get(modelId);
    if (!bound) return;
    bound.group.removeFromParent();
    this.models.delete(modelId);
  }

  sync(): void {
    const live = new Set<string>();
    for (const bound of this.models.values()) {
      for (const asset of bound.session.listSiteAssets()) {
        live.add(asset.globalId);
        let mesh = this.meshes.get(asset.globalId);
        if (!mesh || mesh.parent !== bound.group) {
          mesh?.removeFromParent();
          mesh = buildEquipment(asset);
          mesh.name = asset.globalId;
          bound.group.add(mesh);
          this.meshes.set(asset.globalId, mesh);
        }
        const at = ifcToThreePoint(asset);
        mesh.position.set(at.x, at.y, at.z);
        mesh.rotation.y = -asset.yaw;
        mesh.visible = true;
        paint(mesh, this.selectedGuid === asset.globalId ? 0xf59e0b : null);
      }
    }
    for (const [guid, mesh] of this.meshes) {
      if (live.has(guid)) continue;
      mesh.removeFromParent();
      this.meshes.delete(guid);
    }
  }

  select(guid: string): void {
    this.selectedGuid = guid;
    this.sync();
  }

  selected(): string {
    return this.selectedGuid;
  }

  /**
   * Ponto IFC no plano horizontal da origem do modelo.
   * Só serve quando o clique não acerta a geometria do Fragments.
   */
  groundIfc(
    camera: THREE.Camera,
    event: PointerEvent | MouseEvent,
    dom: HTMLElement,
    modelId: string,
    extra: ModelExtraTransform,
  ): { x: number; y: number; z: number } | null {
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

  pickAsset(camera: THREE.Camera, event: PointerEvent | MouseEvent, dom: HTMLElement): string | null {
    const groups = [...this.models.values()].map((bound) => bound.group);
    const hit = this.raycast(camera, event, dom, groups);
    let node: THREE.Object3D | null = hit?.object ?? null;
    while (node) {
      if (this.meshes.has(node.name)) return node.name;
      node = node.parent;
    }
    return null;
  }

  apply(buckets: SimulationStateBuckets | null, previewAll: boolean): void {
    for (const [guid, mesh] of this.meshes) {
      if (!buckets || previewAll) {
        mesh.visible = true;
        paint(mesh, this.selectedGuid === guid ? 0xf59e0b : null);
        continue;
      }
      const active = buckets.active.has(guid);
      const pending = buckets.pending.has(guid);
      const done = buckets.done.has(guid);
      mesh.visible = !pending;
      paint(mesh, active ? 0xf59e0b : this.selectedGuid === guid ? 0x087f72 : null);
      if (done) mesh.visible = true;
    }
  }

  private raycast(
    camera: THREE.Camera,
    event: PointerEvent | MouseEvent,
    dom: HTMLElement,
    roots: THREE.Object3D[],
    keep: (obj: THREE.Object3D) => boolean = () => true,
  ): THREE.Intersection | null {
    const rect = dom.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(roots, true).filter((hit) => keep(hit.object) && hit.object.visible);
    return hits[0] ?? null;
  }
}

function buildEquipment(asset: SiteAsset): THREE.Group {
  const item = libraryItem(asset.libraryKey);
  const group = new THREE.Group();
  const color = item?.color ?? 0x94a3b8;
  const mat = new THREE.MeshLambertMaterial({ color });
  const width = item?.width ?? 1;
  const depth = item?.depth ?? 1;
  const height = item?.height ?? 1;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex = color) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat.clone());
    (mesh.material as THREE.MeshLambertMaterial).color.setHex(hex);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };
  if (asset.libraryKey === "grua") {
    box(0.7, height, 0.7, 0, height / 2, 0);
    box(8, 0.45, 0.45, 2.6, height - 0.5, 0, 0x111827);
    box(1.6, 0.9, 1.6, -1.2, height - 0.7, 0, 0x78350f);
    box(2.2, 0.5, 2.2, 0, 0.25, 0, 0x44403c);
  } else if (asset.libraryKey === "camiao") {
    box(4.6, 1.3, 2.3, -0.8, 1.15, 0);
    box(2.2, 1.5, 2.2, 2.5, 2.15, 0, 0x1e3a8a);
    wheel(group, -2.2, 0.45, 1);
    wheel(group, -2.2, 0.45, -1);
    wheel(group, 2.4, 0.45, 1);
    wheel(group, 2.4, 0.45, -1);
  } else if (asset.libraryKey === "betoneira") {
    box(3.2, 1.2, 2.3, -1.2, 1.2, 0, 0x1d4ed8);
    box(2.2, 1.6, 2.2, 2.1, 2.1, 0, 0xf8fafc);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 2.4, 16), mat.clone());
    (drum.material as THREE.MeshLambertMaterial).color.setHex(0xe2e8f0);
    drum.rotation.z = Math.PI / 2.4;
    drum.position.set(-0.4, 2.5, 0);
    group.add(drum);
  } else if (asset.libraryKey === "vedacao") {
    box(width, 0.08, depth, 0, height, 0, 0x334155);
    box(width, 0.08, depth, 0, height * 0.55, 0, 0x334155);
    for (let i = 0; i <= 4; i++) box(0.12, height, depth, -width / 2 + (width * i) / 4, height / 2, 0, 0x475569);
  } else if (asset.libraryKey === "andaime") {
    for (const x of [-width / 2 + 0.1, width / 2 - 0.1]) {
      for (const z of [-depth / 2 + 0.1, depth / 2 - 0.1]) box(0.12, height, 0.12, x, height / 2, z, 0xd97706);
    }
    for (let level = 1; level <= 3; level++) box(width, 0.08, depth, 0, (height * level) / 3, 0, 0xfbbf24);
  } else {
    box(width, height, depth, 0, height / 2, 0);
    if (asset.libraryKey === "contentor") box(width * 0.9, height * 0.7, 0.05, 0, height * 0.45, depth / 2 + 0.01, 0x7c2d12);
  }
  group.traverse((obj) => {
    obj.userData.siteAsset = asset.globalId;
  });
  return group;
}

function wheel(group: THREE.Group, x: number, y: number, z: number): void {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.45, 0.35, 12),
    new THREE.MeshLambertMaterial({ color: 0x111827 }),
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  group.add(mesh);
}

function paint(root: THREE.Object3D, hex: number | null): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const material = mesh.material as THREE.MeshLambertMaterial | undefined;
    if (!material || !material.emissive) return;
    if (hex == null) {
      material.emissive.setHex(0x000000);
      return;
    }
    material.emissive.setHex(hex);
    material.emissiveIntensity = 0.35;
  });
}
