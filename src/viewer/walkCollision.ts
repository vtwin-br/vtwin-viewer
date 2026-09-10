import * as THREE from "three";
import * as FRAGS from "@thatopen/fragments";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { GoogleEarthLayer } from "./earthTiles";

/** Camada que a câmara não desenha; o raycaster de caminhada sim. */
export const WALK_COLLIDER_LAYER = 2;

/**
 * Tipos IFC que se atravessam (vão de porta, espaço, vazio).
 * O resto com geometria vira bloqueio físico.
 */
const PASSABLE_CATEGORY =
  /IFCDOOR|IFCOPENINGELEMENT|IFCOPENING\b|IFCSPACE|IFCZONE|IFCVIRTUALELEMENT|IFCANNOTATION|IFCGRID|IFCVOIDINGFEATURE|IFCPROJECT\b|IFCBUILDINGSTOREY/i;

const PASSABLE_NAME = /\b(door|porta|portão|portao|opening|vão|vao)\b/i;

const identity = new THREE.Matrix4();

export interface WalkHit {
  point: THREE.Vector3;
  distance: number;
  normal: THREE.Vector3;
  source: "ifc" | "earth";
}

/**
 * Colisão para 1ª pessoa: malha IFC (sem portas/vãos) + Photorealistic 3D Tiles.
 */
export class WalkCollider {
  private group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private invMat = new THREE.Matrix4();
  private localRay = new THREE.Ray();
  private worldNormal = new THREE.Vector3();
  private model: FRAGS.FragmentsModel | null = null;
  private earth: GoogleEarthLayer | null = null;
  private gen = 0;
  ready = false;

  constructor() {
    this.group.name = "walk-collider";
    this.group.matrixAutoUpdate = true;
    this.raycaster.layers.enable(0);
    this.raycaster.layers.enable(WALK_COLLIDER_LAYER);
  }

  setEarth(earth: GoogleEarthLayer | null): void {
    this.earth = earth;
  }

  async attach(model: FRAGS.FragmentsModel): Promise<void> {
    this.detach();
    const token = this.gen;
    this.model = model;
    model.object.add(this.group);
    try {
      await this.rebuild(model, token);
    } catch (err) {
      console.warn("Colisão IFC incompleta:", err);
    }
    if (token !== this.gen) return;
    this.ready = true;
  }

  detach(): void {
    this.gen++;
    this.disposeMeshes();
    this.group.removeFromParent();
    this.model = null;
    this.ready = false;
  }

  /**
   * Hit mais próximo ao longo do raio, entre IFC e terreno Google.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, far: number): WalkHit | null {
    const ndir = dir.lengthSq() > 0 ? dir.clone().normalize() : dir;
    let best: WalkHit | null = null;

    this.raycaster.near = 0;
    this.raycaster.far = far;
    this.raycaster.firstHitOnly = true;
    this.raycaster.set(origin, ndir);

    for (const mesh of this.meshes) {
      const bvh = mesh.geometry.boundsTree as MeshBVH | undefined;
      if (!bvh) continue;
      mesh.updateWorldMatrix(true, false);
      this.invMat.copy(mesh.matrixWorld).invert();
      this.localRay.copy(this.raycaster.ray).applyMatrix4(this.invMat);
      const hit = bvh.raycastFirst(this.localRay, THREE.DoubleSide, 0, far);
      if (!hit || hit.distance > far) continue;
      const point = hit.point.clone().applyMatrix4(mesh.matrixWorld);
      const distance = origin.distanceTo(point);
      if (distance > far) continue;
      const normal = (hit.face?.normal ?? this.worldNormal.set(0, 1, 0)).clone();
      normal.transformDirection(mesh.matrixWorld).normalize();
      if (!best || distance < best.distance) {
        best = { point, distance, normal, source: "ifc" };
      }
    }

    const earthHit = this.earth?.enabled ? this.earth.raycast(origin, ndir, far) : null;
    if (earthHit && Number.isFinite(earthHit.distance) && earthHit.distance <= far) {
      if (!best || earthHit.distance < best.distance) {
        const normal = earthHit.face?.normal
          ? earthHit.face.normal.clone().transformDirection(earthHit.object.matrixWorld).normalize()
          : new THREE.Vector3(0, 1, 0);
        best = {
          point: earthHit.point.clone(),
          distance: earthHit.distance,
          normal,
          source: "earth",
        };
      }
    }

    return best;
  }

  private async rebuild(model: FRAGS.FragmentsModel, token: number): Promise<void> {
    const ids = await this.collectSolidIds(model);
    if (token !== this.gen) return;

    const geos: THREE.BufferGeometry[] = [];
    let verts = 0;
    const chunk = 80;
    for (let i = 0; i < ids.length; i += chunk) {
      if (token !== this.gen) break;
      const slice = ids.slice(i, i + chunk);
      let packed: FRAGS.MeshData[][] = [];
      try {
        packed = await model.getItemsGeometry(slice);
      } catch (err) {
        console.warn("getItemsGeometry falhou num lote:", err);
        continue;
      }
      for (const item of packed) {
        for (const data of item) {
          const geo = meshDataToGeometry(data);
          if (!geo) continue;
          const count = geo.getAttribute("position")?.count ?? 0;
          if (verts + count > 2_400_000) {
            geo.dispose();
            continue;
          }
          verts += count;
          geos.push(geo);
        }
      }
      if (i + chunk < ids.length) await yieldFrame();
    }
    if (token !== this.gen) {
      for (const g of geos) g.dispose();
      return;
    }

    const batches = geos.length > 0 ? mergeInBatches(geos, 250) : [];
    const mat = new THREE.MeshBasicMaterial({
      visible: true,
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const geo of batches) this.pushMesh(geo, mat);
    if (this.meshes.length === 0) this.addFallbackFloor(model, mat);
  }

  private addFallbackFloor(model: FRAGS.FragmentsModel, mat: THREE.Material): void {
    const box = model.box;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const span = Math.max(80, size.x, size.z) * 1.4;
    const geo = new THREE.PlaneGeometry(span, span, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(center.x, box.min.y, center.z);
    this.pushMesh(geo, mat);
  }

  private pushMesh(geo: THREE.BufferGeometry, mat: THREE.Material): void {
    geo.computeBoundingBox();
    geo.boundsTree = new MeshBVH(geo, { maxLeafSize: 16 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "walk-ifc";
    mesh.frustumCulled = false;
    mesh.layers.set(WALK_COLLIDER_LAYER);
    mesh.raycast = acceleratedRaycast;
    this.group.add(mesh);
    this.meshes.push(mesh);
  }

  private async collectSolidIds(model: FRAGS.FragmentsModel): Promise<number[]> {
    const cats = (await model.getCategories()).filter((c): c is string => !!c);
    const collideCats = cats.filter((c) => !PASSABLE_CATEGORY.test(c));
    if (collideCats.length === 0) return [];
    const map = await model.getItemsOfCategories(
      collideCats.map((c) => new RegExp(`^${escapeRe(c)}$`, "i")),
    );
    let ids = uniqueIds(Object.values(map).flat());
    const namedSkip = await this.idsWithPassableName(model, ids);
    if (namedSkip.size > 0) ids = ids.filter((id) => !namedSkip.has(id));
    return ids;
  }

  private async idsWithPassableName(model: FRAGS.FragmentsModel, ids: number[]): Promise<Set<number>> {
    const skip = new Set<number>();
    const chunk = 400;
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      let rows: FRAGS.ItemData[] = [];
      try {
        rows = await model.getItemsData(slice, {
          attributesDefault: false,
          attributes: ["Name", "ObjectType"],
          relationsDefault: { attributes: false, relations: false },
        });
      } catch {
        continue;
      }
      for (let k = 0; k < slice.length; k++) {
        const label = `${itemString(rows[k], "Name")} ${itemString(rows[k], "ObjectType")}`;
        if (PASSABLE_NAME.test(label)) skip.add(slice[k]);
      }
    }
    return skip;
  }

  private disposeMeshes(): void {
    const mat = this.meshes[0]?.material;
    if (mat && !Array.isArray(mat)) mat.dispose();
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    this.meshes = [];
    while (this.group.children.length) this.group.remove(this.group.children[0]);
  }
}

function meshDataToGeometry(data: FRAGS.MeshData): THREE.BufferGeometry | null {
  if (!data.positions || data.positions.length < 9) return null;
  const geo = new THREE.BufferGeometry();
  const src = data.positions;
  const pos = src instanceof Float32Array ? src.slice() : Float32Array.from(src);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (data.indices && data.indices.length >= 3) {
    const idx = data.indices;
    if (idx instanceof Uint32Array) geo.setIndex(new THREE.BufferAttribute(idx.slice(), 1));
    else if (idx instanceof Uint16Array) geo.setIndex(new THREE.BufferAttribute(idx.slice(), 1));
    else if (idx instanceof Uint8Array) geo.setIndex(new THREE.BufferAttribute(Uint16Array.from(idx), 1));
    else geo.setIndex(Array.from(idx));
  } else {
    const n = pos.length / 3;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const m = toMatrix(data.transform);
  if (!m.equals(identity)) geo.applyMatrix4(m);
  return geo;
}

function toMatrix(t: THREE.Matrix4 | { elements?: ArrayLike<number> } | ArrayLike<number> | undefined): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!t) return m;
  if (t instanceof THREE.Matrix4) return m.copy(t);
  if (typeof (t as THREE.Matrix4).elements !== "undefined" && !Array.isArray(t) && !ArrayBuffer.isView(t)) {
    return m.fromArray(Array.from((t as THREE.Matrix4).elements));
  }
  if (Array.isArray(t) || ArrayBuffer.isView(t)) return m.fromArray(Array.from(t as ArrayLike<number>));
  return m;
}

function mergeInBatches(geos: THREE.BufferGeometry[], size: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < geos.length; i += size) {
    const slice = geos.slice(i, i + size);
    const merged = mergeGeometries(slice, false);
    if (merged) {
      for (const g of slice) g.dispose();
      out.push(merged);
    } else {
      out.push(...slice);
    }
  }
  return out;
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isFinite(id)))];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function itemString(row: FRAGS.ItemData | undefined, key: string): string {
  if (!row) return "";
  const raw = row[key];
  return unwrapAttr(raw);
}

function unwrapAttr(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  if (Array.isArray(raw)) return raw.map(unwrapAttr).join(" ");
  if (typeof raw === "object" && raw && "value" in raw) return unwrapAttr((raw as { value: unknown }).value);
  return "";
}

function yieldFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
