import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ifcToThreePoint, threeWorldToIfc, type ModelExtraTransform } from "../ifc/georef";
import { frameFromPairs } from "../planning/pdfFrame";
import { type MotionPose } from "../planning/playback";
import { offsetPolygon, slopeRun } from "../planning/polygon";
import {
  DEFAULT_COUNTER_JIB,
  DEFAULT_JIB_LENGTH,
  DEFAULT_MAST_HEIGHT,
  DEFAULT_SWING,
  poseOf,
  type PlanDrill,
  type PlanFence,
  type PlanMass,
  type PlanNote,
  type PlanPath,
  type PlanPoint,
  type PlanTerrain,
  type SitePlan,
} from "../planning/sitePlan";
import type { MarkupDoc, MarkupItem, PdfOverlay, PourItem } from "../project/viewerPack";
import { catalogSlot, catalogUrl, DUMP_TRUCK_ID, TOWER_CRANE_ID } from "../site/catalogModels";
import type { SimulationStateBuckets } from "../schedule/simulation";
import { renderPdfSheet } from "./pdfSheet";

interface BoundModel {
  object: THREE.Object3D;
  group: THREE.Group;
}

export interface SiteHit {
  id: string;
  part: "body" | "x" | "y" | "z" | "vertex" | "edge" | "resize" | "scale" | "sheet";
  index?: number;
  uv?: { u: number; v: number };
}

export interface SiteView {
  markups?: MarkupDoc;
  motions?: MotionPose[];
  pours?: PourItem[];
  pourTimes?: Record<string, number>;
}

const CUT = "#9b3a2a";
const FILL = "#087f72";
const SLOPE = "#c4a882";
const PATH = "#748891";

/** Vista gerada dos parâmetros. A malha não entra no `.vtwin` nem no IFC. */
export class SitePlanLayer {
  private readonly models = new Map<string, BoundModel>();
  private readonly meshes = new Map<string, THREE.Object3D>();
  private selectedId = "";
  private plan: SitePlan | null = null;
  private markups: MarkupDoc | null = null;
  private motions: MotionPose[] = [];
  private pours: PourItem[] = [];
  private pourTimes: Record<string, number> = {};
  private applied = false;
  private lastBuckets: SimulationStateBuckets | null = null;
  private lastPreview = true;
  private viewCamera: THREE.Camera | null = null;

  bind(modelId: string, object: THREE.Object3D): void {
    const previous = this.models.get(modelId);
    previous?.group.removeFromParent();
    const group = new THREE.Group();
    group.name = "site-plan";
    object.add(group);
    this.models.set(modelId, { object, group });
    if (this.plan) this.sync(this.plan, { markups: this.markups ?? undefined, motions: this.motions });
  }

  unbind(modelId: string): void {
    const bound = this.models.get(modelId);
    if (!bound) return;
    bound.group.removeFromParent();
    this.models.delete(modelId);
    if (this.plan) this.sync(this.plan, { markups: this.markups ?? undefined, motions: this.motions });
  }

  bindGround(scene: THREE.Object3D): void {
    if (this.models.has("ground")) return;
    const group = new THREE.Group();
    group.name = "site-plan";
    scene.add(group);
    this.models.set("ground", { object: scene, group });
    if (this.plan) this.sync(this.plan, { markups: this.markups ?? undefined, motions: this.motions, pours: this.pours });
  }

  walkObject(): THREE.Object3D | null {
    return this.models.get("ground")?.group ?? this.models.values().next().value?.group ?? null;
  }

  setViewCamera(camera: THREE.Camera): void {
    this.viewCamera = camera;
  }

  spin(seconds: number): void {
    if (!this.plan) return;
    for (const drill of this.plan.drills) {
      const bit = this.meshes.get(drill.id)?.getObjectByName("bit");
      if (bit) bit.rotation.y = seconds * 3;
    }
    this.faceBillboards();
  }

  /** Canto da caixa de texto, em píxeis do ecrã. */
  resizeScreen(camera: THREE.Camera, dom: HTMLElement): { x: number; y: number } | null {
    const rect = dom.getBoundingClientRect();
    const world = new THREE.Vector3();
    for (const mesh of this.meshes.values()) {
      const handle = mesh.getObjectByName("resize");
      if (!handle) continue;
      handle.getWorldPosition(world);
      const clip = world.clone().project(camera);
      if (clip.z < -1 || clip.z > 1) continue;
      return {
        x: rect.left + (clip.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-clip.y * 0.5 + 0.5) * rect.height,
      };
    }
    return null;
  }

  /** Metros de largura e altura que acompanham o arrasto do cursor. */
  pointerScale(id: string, dx: number, dy: number, camera: THREE.Camera, dom: HTMLElement): { dw: number; dh: number } {
    const mesh = this.meshes.get(id);
    const rect = dom.getBoundingClientRect();
    if (!mesh || rect.width < 2 || rect.height < 2) return { dw: dx * 0.08, dh: -dy * 0.08 };
    const origin = mesh.localToWorld(new THREE.Vector3());
    const xTip = mesh.localToWorld(new THREE.Vector3(1, 0, 0));
    const yTip = mesh.localToWorld(new THREE.Vector3(0, 1, 0));
    const project = (point: THREE.Vector3) => {
      const clip = point.clone().project(camera);
      return new THREE.Vector2(
        (clip.x * 0.5 + 0.5) * rect.width,
        (-clip.y * 0.5 + 0.5) * rect.height,
      );
    };
    const start = project(origin);
    const sx = project(xTip).sub(start);
    const sy = project(yTip).sub(start);
    const det = sx.x * sy.y - sx.y * sy.x;
    if (Math.abs(det) < 6) return { dw: dx * 0.08, dh: -dy * 0.08 };
    return {
      dw: (dx * sy.y - dy * sx.y) / det,
      dh: (sx.x * dy - sy.x * dx) / det,
    };
  }

  sync(plan: SitePlan, view?: SiteView): void {
    this.plan = plan;
    if (view?.markups) this.markups = view.markups;
    if (view?.motions) this.motions = view.motions;
    if (view?.pours) this.pours = view.pours;
    if (view?.pourTimes) this.pourTimes = view.pourTimes;
    const live = new Set<string>();
    for (const crane of plan.cranes) {
      this.ensureCatalog(crane.id, crane.modelId, crane, crane.catalogId || TOWER_CRANE_ID, (visual) =>
        fitTowerCrane(visual, crane.mastHeight, crane.jibLength),
      );
      this.tint(crane.id, crane.color);
      this.cable(crane.id, crane.hook ?? 4);
      this.counterJib(crane.id, crane.counterJib ?? DEFAULT_COUNTER_JIB, crane.mastHeight);
      this.swingZone(crane.id, crane.jibLength, crane.swing ?? DEFAULT_SWING);
      this.gizmo(crane.id, "xyz");
      live.add(crane.id);
    }
    for (const truck of plan.trucks) {
      this.ensureCatalog(truck.id, truck.modelId, truck, truck.catalogId || DUMP_TRUCK_ID, () => {});
      this.tint(truck.id, truck.color);
      this.gizmo(truck.id, "xyz");
      live.add(truck.id);
    }
    for (const path of plan.paths) {
      const origin = path.points[0];
      if (!origin) continue;
      this.place(path.id, path.modelId, () => buildPath(path, origin), origin, 0, 0, 0);
      if (path.id === this.selectedId) this.handles(path.id, path.points, origin, false);
      live.add(path.id);
    }
    for (const terrain of plan.terrains) {
      const origin = terrain.contour[0];
      if (!origin) continue;
      const pose = poseOf({ yaw: terrain.rz ?? 0, rz: terrain.rz });
      this.place(terrain.id, terrain.modelId, () => buildTerrain(terrain, origin), origin, pose.rx, pose.ry, pose.rz);
      const terrainMesh = this.meshes.get(terrain.id);
      if (terrainMesh) {
        terrainMesh.userData.kind = "terrain";
        terrainMesh.userData.fullDepth = Math.max(0.2, terrain.depth);
      }
      if (terrain.id === this.selectedId) this.handles(terrain.id, terrain.contour, origin, true);
      this.gizmo(terrain.id, "z");
      live.add(terrain.id);
    }
    for (const fence of plan.fences) {
      const pose = poseOf(fence);
      this.place(fence.id, fence.modelId, () => buildFence(fence), fence, pose.rx, pose.ry, pose.rz);
      this.gizmo(fence.id, "z");
      live.add(fence.id);
    }
    for (const drill of plan.drills) {
      const pose = poseOf(drill);
      this.place(drill.id, drill.modelId, () => buildDrill(drill), drill, pose.rx, pose.ry, pose.rz);
      this.gizmo(drill.id, "xyz");
      live.add(drill.id);
    }
    for (const mass of plan.masses) {
      const pose = poseOf(mass);
      this.place(mass.id, mass.modelId, () => buildMass(mass), mass, pose.rx, pose.ry, pose.rz);
      this.gizmo(mass.id, "xyz");
      live.add(mass.id);
    }
    for (const note of plan.notes) {
      this.place(note.id, note.modelId, () => buildPin(note.text, note.color || "#163540", false), note, 0, 0, 0);
      live.add(note.id);
    }
    const markups = this.markups;
    if (markups) {
      for (const item of markups.items) this.drawMarkup(item, live);
      for (const pdf of markups.pdfs) {
        this.drawPdf(pdf);
        live.add(pdf.id);
      }
    }
    this.drawPours(this.pours, live);
    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      mesh.removeFromParent();
      disposeObject(mesh);
      this.meshes.delete(id);
    }
    this.applyMotions();
    this.faceBillboards();
    if (this.applied) this.apply(this.lastBuckets, this.lastPreview);
    else this.paintSelection();
  }

  setMotions(motions: MotionPose[], pourTimes?: Record<string, number>): void {
    this.motions = motions;
    if (pourTimes) this.pourTimes = pourTimes;
    this.applyMotions();
    this.applyPourScales();
    this.paintSelection();
  }

  select(id: string): void {
    this.selectedId = id;
    if (this.plan) this.sync(this.plan);
    else this.paintSelection();
  }

  selected(): string {
    return this.selectedId;
  }

  hit(camera: THREE.Camera, event: PointerEvent | MouseEvent, dom: HTMLElement): SiteHit | null {
    const groups = [...this.models.values()].map((bound) => bound.group);
    const rect = dom.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(groups, true).filter((item) => item.object.visible);
    let best: { distance: number; found: SiteHit } | null = null;
    let handle: { distance: number; found: SiteHit } | null = null;
    for (const item of hits) {
      const found = this.describeHit(item);
      if (!found) continue;
      if (!best || item.distance < best.distance) best = { distance: item.distance, found };
      if (isHandle(found.part) && (!handle || item.distance < handle.distance)) {
        handle = { distance: item.distance, found };
      }
    }
    const grabbed = this.grabHandle(camera, event, rect);
    if (grabbed) return grabbed;
    if (!best) return null;
    if (handle && handle.distance <= best.distance + 1.2) return handle.found;
    return best.found;
  }

  /** A alça ganha se o cursor está em cima dela, mesmo com a malha do terreno à frente. */
  private grabHandle(camera: THREE.Camera, event: PointerEvent | MouseEvent, rect: DOMRect): SiteHit | null {
    const best: { dist: number; found: SiteHit | null } = { dist: Number.POSITIVE_INFINITY, found: null };
    const world = new THREE.Vector3();
    for (const mesh of this.meshes.values()) {
      mesh.traverse((obj) => {
        if (!obj.visible || !handleName(obj.name)) return;
        obj.getWorldPosition(world);
        const clip = world.clone().project(camera);
        if (clip.z < -1 || clip.z > 1) return;
        const x = rect.left + (clip.x * 0.5 + 0.5) * rect.width;
        const y = rect.top + (-clip.y * 0.5 + 0.5) * rect.height;
        const dist = Math.hypot(event.clientX - x, event.clientY - y);
        const reach = obj.name === "resize" ? 72 : 52;
        if (dist > reach || dist >= best.dist) return;
        const found = this.hitFromObject(obj);
        if (!found) return;
        best.dist = dist;
        best.found = found;
      });
    }
    return best.found;
  }

  private hitFromObject(object: THREE.Object3D): SiteHit | null {
    let part: SiteHit["part"] = "body";
    let index: number | undefined;
    let node: THREE.Object3D | null = object;
    while (node) {
      if (node.name === "axis-x") part = "x";
      else if (node.name === "axis-y") part = "y";
      else if (node.name === "axis-z") part = "z";
      else if (node.name === "resize") part = "resize";
      else if (node.name === "scale") part = "scale";
      else if (node.name.startsWith("vertex-")) {
        part = "vertex";
        index = Number(node.name.slice(7));
      } else if (node.name.startsWith("edge-")) {
        part = "edge";
        index = Number(node.name.slice(5));
      }
      if (this.meshes.has(node.name)) {
        if (node.name.startsWith("pour:")) return null;
        return { id: node.name, part, index };
      }
      node = node.parent;
    }
    return null;
  }

  private describeHit(hit: THREE.Intersection): SiteHit | null {
    let part: SiteHit["part"] = "body";
    let index: number | undefined;
    let node: THREE.Object3D | null = hit.object;
    let sheet: THREE.Object3D | null = null;
    while (node) {
      if (node.name === "axis-x") part = "x";
      else if (node.name === "axis-y") part = "y";
      else if (node.name === "axis-z") part = "z";
      else if (node.name === "resize") part = "resize";
      else if (node.name === "scale") part = "scale";
      else if (node.name === "sheet") {
        part = "sheet";
        sheet = node;
      } else if (node.name.startsWith("vertex-")) {
        part = "vertex";
        index = Number(node.name.slice(7));
      } else if (node.name.startsWith("edge-")) {
        part = "edge";
        index = Number(node.name.slice(5));
      }
      if (this.meshes.has(node.name)) {
        if (node.name.startsWith("pour:")) return null;
        const found: SiteHit = { id: node.name, part, index };
        if (part === "sheet" && sheet) {
          const local = sheet.worldToLocal(hit.point.clone());
          const width = Number(sheet.userData.width) || 1;
          const height = Number(sheet.userData.height) || 1;
          found.uv = { u: local.x / width, v: local.y / height };
        }
        return found;
      }
      node = node.parent;
    }
    return null;
  }

  screenPoint(id: string, camera: THREE.Camera, dom: HTMLElement): { x: number; y: number } | null {
    const mesh = this.meshes.get(id);
    if (!mesh) return null;
    const world = new THREE.Vector3();
    mesh.getWorldPosition(world);
    world.project(camera);
    const rect = dom.getBoundingClientRect();
    return {
      x: rect.left + (world.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-world.y * 0.5 + 0.5) * rect.height,
    };
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

  apply(buckets: SimulationStateBuckets | null, previewAll: boolean): void {
    this.applied = true;
    this.lastBuckets = buckets;
    this.lastPreview = previewAll;
    for (const [id, mesh] of this.meshes) {
      if (id.startsWith("pour:")) {
        const fraction = this.pourTimes[String(mesh.userData.guid)] ?? 0;
        mesh.visible = !previewAll && fraction > 0.001 && fraction < 0.999;
        continue;
      }
      if (!buckets || previewAll) {
        mesh.visible = true;
        continue;
      }
      mesh.visible = !buckets.pending.has(id);
    }
    this.applyPourScales();
    this.paintSelection();
  }

  private applyMotions(): void {
    for (const motion of this.motions) {
      const mesh = this.meshes.get(motion.id);
      if (!mesh) continue;
      applyIfcRotation(mesh, motion.rx, motion.ry, motion.rz);
      if (motion.at) {
        const point = ifcToThreePoint(motion.at);
        mesh.position.set(point.x, point.y, point.z);
      }
      const visual = mesh.getObjectByName("catalog-visual");
      if (visual && motion.mastHeight != null && motion.jibLength != null) fitTowerCrane(visual, motion.mastHeight, motion.jibLength);
      const crown = mesh.getObjectByName("crown");
      if (crown) crown.rotation.y = motion.slew ?? 0;
      const arm = mesh.getObjectByName("counter-jib");
      if (arm) arm.rotation.y = motion.slew ?? 0;
      if (arm && motion.mastHeight != null) arm.position.y = motion.mastHeight;
      if (motion.hook != null) this.cable(motion.id, motion.hook);
      if (motion.depth != null) {
        const bit = mesh.getObjectByName("bit");
        if (bit) bit.scale.y = Math.max(0.2, motion.depth);
        if (mesh.userData.kind === "terrain") {
          const full = Number(mesh.userData.fullDepth) || motion.depth || 1;
          mesh.scale.y = Math.max(0.05, motion.depth / full);
        }
      }
      if (motion.grow != null) scaleSections(mesh, motion.grow, true);
    }
  }

  private drawMarkup(item: MarkupItem, live: Set<string>): void {
    if (item.kind === "hatch" || item.kind === "polygon") {
      const origin = item.points?.[0];
      if (!origin) return;
      const pose = poseOf({ yaw: 0 });
      this.place(item.id, item.modelId, () => buildHatch(item, origin), origin, pose.rx, pose.ry, pose.rz);
      if (item.id === this.selectedId && item.points) this.handles(item.id, item.points, origin, item.kind === "hatch" || item.kind === "polygon");
      if (item.id === this.selectedId) this.scaleHandle(item.id);
      live.add(item.id);
      return;
    }
    if (item.x == null || item.y == null || item.z == null) return;
    const at = { x: item.x, y: item.y, z: item.z };
    const mesh =
      item.kind === "pin"
        ? buildPin(item.text, item.color, true)
        : buildCard(item.text, item.color, item.width ?? 6, item.height ?? 2.4, item.kind === "balloon");
    this.place(item.id, item.modelId, () => mesh, at, 0, 0, 0);
    if (item.id === this.selectedId && item.kind !== "pin") this.resizeHandle(item.id, item.width ?? 6, item.height ?? 2.4);
    live.add(item.id);
  }

  private drawPdf(pdf: PdfOverlay): void {
    const frame = pdfFrame(pdf);
    const bound = this.boundFor(pdf.modelId);
    if (!bound || !frame) return;
    let root = this.meshes.get(pdf.id);
    const texKey = `${pdf.sheet}|${pdf.removeWhite}|${pdf.pdf.length}|${pdf.color}`;
    if (!root || root.userData.texKey !== texKey) {
      if (root) {
        root.removeFromParent();
        disposeObject(root);
      }
      root = new THREE.Group();
      root.name = pdf.id;
      root.userData.texKey = texKey;
      bound.group.add(root);
      this.meshes.set(pdf.id, root);
      root.add(blankSheet(frame.width, frame.height, pdf.opacity, pdf.color));
      const generation = (root.userData.generation = Number(root.userData.generation ?? 0) + 1);
      const host = root;
      void renderPdfSheet(pdf.pdf, pdf.sheet, pdf.removeWhite)
        .then((page) => {
          if (host.userData.generation !== generation || !host.parent) return;
          pdf.aspect = page.aspect;
          pdf.pageCount = page.pageCount;
          host.userData.aspect = page.aspect;
          const placed = pdfFrame({ ...pdf, aspect: page.aspect });
          const size = placed ?? frame;
          const sheet = sheetMesh(size.width, size.height, page.canvas, pdf.opacity, pdf.color);
          host.clear();
          host.add(sheet);
          host.userData.pageCount = page.pageCount;
        })
        .catch(() => {});
    }
    const sheet = root.getObjectByName("sheet") as THREE.Mesh | undefined;
    if (sheet) {
      const material = sheet.material as THREE.MeshBasicMaterial;
      material.opacity = pdf.opacity;
      material.color.set(pdf.color || "#ffffff");
      const baseW = Number(sheet.userData.baseWidth) || Number(sheet.userData.width) || frame.width;
      const baseH = Number(sheet.userData.baseHeight) || Number(sheet.userData.height) || frame.height;
      sheet.userData.baseWidth = baseW;
      sheet.userData.baseHeight = baseH;
      if (baseW > 0.05 && baseH > 0.05) sheet.scale.set(frame.width / baseW, frame.height / baseH, 1);
    }
    const point = ifcToThreePoint(frame.origin);
    root.position.set(point.x, point.y + 0.05, point.z);
    applyIfcRotation(root, -Math.PI / 2, 0, frame.yaw);
  }

  private place(
    id: string,
    modelId: string | undefined,
    build: () => THREE.Object3D,
    at: PlanPoint,
    rx: number,
    ry: number,
    rz: number,
  ): void {
    const bound = this.boundFor(modelId);
    if (!bound) return;
    const previous = this.meshes.get(id);
    previous?.removeFromParent();
    if (previous) disposeObject(previous);
    const mesh = build();
    mesh.name = id;
    bound.group.add(mesh);
    this.meshes.set(id, mesh);
    const point = ifcToThreePoint(at);
    mesh.position.set(point.x, point.y, point.z);
    applyIfcRotation(mesh, rx, ry, rz);
  }

  private ensureCatalog(
    id: string,
    modelId: string | undefined,
    at: PlanPoint & { yaw: number; rx?: number; ry?: number; rz?: number; color?: string },
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
          this.tint(id, host.userData.tint as string | undefined);
          this.paintSelection();
        })
        .catch(() => {});
    }
    const pose = poseOf(at);
    const point = ifcToThreePoint(at);
    root.position.set(point.x, point.y, point.z);
    applyIfcRotation(root, pose.rx, pose.ry, pose.rz);
    root.userData.tint = (at as { color?: string }).color;
    const visual = root.getObjectByName("catalog-visual");
    if (visual) fit(visual);
  }

  private tint(id: string, color: string | undefined): void {
    const root = this.meshes.get(id);
    if (!root) return;
    root.traverse((obj) => {
      if (obj.userData.ui) return;
      const mesh = obj as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | undefined;
      if (!material || !("color" in material) || material.map) return;
      const base = material.userData.baseColor as string | undefined;
      if (color) material.color.set(color);
      else if (base) material.color.set(base);
    });
  }

  private cable(id: string, hook: number): void {
    const root = this.meshes.get(id);
    if (!root) return;
    let cable = root.getObjectByName("cable") as THREE.Mesh | null;
    if (!cable) {
      const geom = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
      geom.translate(0, -0.5, 0);
      cable = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0x1c1c1c, metalness: 0.7, roughness: 0.35 }));
      cable.name = "cable";
      cable.userData.ui = true;
      root.add(cable);
    }
    const trolley = root.getObjectByName("trolley");
    if (trolley) {
      const pos = new THREE.Vector3();
      trolley.getWorldPosition(pos);
      root.worldToLocal(pos);
      cable.position.copy(pos);
    } else {
      cable.position.set(DEFAULT_JIB_LENGTH - 1.6, DEFAULT_MAST_HEIGHT + 0.4, 0);
    }
    cable.scale.y = Math.max(0.4, hook);
  }

  private gizmo(id: string, axes: "xyz" | "z"): void {
    const root = this.meshes.get(id);
    if (!root || id !== this.selectedId) {
      root?.getObjectByName("gizmo")?.removeFromParent();
      return;
    }
    let gizmo = root.getObjectByName("gizmo");
    gizmo?.removeFromParent();
    gizmo = new THREE.Group();
    gizmo.name = "gizmo";
    gizmo.userData.ui = true;
    const radius = 3.2;
    if (axes === "xyz") {
      gizmo.add(disc("axis-x", 0xc23b3b, radius, "x"));
      gizmo.add(disc("axis-y", 0x2f8f4e, radius, "y"));
    }
    gizmo.add(disc("axis-z", 0x2f5fa7, radius, "z"));
    root.add(gizmo);
  }

  private handles(id: string, points: PlanPoint[], origin: PlanPoint, edges: boolean): void {
    const root = this.meshes.get(id);
    if (!root) return;
    const group = new THREE.Group();
    group.name = "handles";
    group.userData.ui = true;
    const base = ifcToThreePoint(origin);
    const ring: THREE.Vector3[] = [];
    points.forEach((point, index) => {
      const at = ifcToThreePoint(point);
      const local = new THREE.Vector3(at.x - base.x, at.y - base.y + 0.4, at.z - base.z);
      ring.push(local);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(1.05, 16, 12),
        new THREE.MeshLambertMaterial({ color: edges ? 0x2fd6bf : 0xf8fbfa, depthTest: false }),
      );
      sphere.name = `vertex-${index}`;
      sphere.userData.ui = true;
      sphere.position.copy(local);
      sphere.renderOrder = 6;
      if (edges) sphere.add(vertexLetter(index < 26 ? String.fromCharCode(65 + index) : String(index + 1)));
      group.add(sphere);
      if (!edges) return;
      const next = points[(index + 1) % points.length];
      if (!next || (index === points.length - 1 && points.length < 3)) return;
      const b = ifcToThreePoint(next);
      const mid = new THREE.Mesh(
        new THREE.SphereGeometry(0.4, 10, 8),
        new THREE.MeshLambertMaterial({ color: 0x748891, depthTest: false }),
      );
      mid.name = `edge-${index}`;
      mid.userData.ui = true;
      mid.position.set((at.x + b.x) / 2 - base.x, (at.y + b.y) / 2 - base.y + 0.35, (at.z + b.z) / 2 - base.z);
      mid.renderOrder = 6;
      group.add(mid);
    });
    if (edges && ring.length > 1) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points.length >= 3 ? [...ring, ring[0]!] : ring),
        new THREE.LineBasicMaterial({ color: 0x2fd6bf, depthTest: false }),
      );
      line.userData.ui = true;
      line.renderOrder = 5;
      group.add(line);
    }
    root.add(group);
  }

  private faceBillboards(): void {
    const camera = this.viewCamera;
    if (!camera) return;
    for (const mesh of this.meshes.values()) {
      if (!mesh.userData.billboard) continue;
      const world = new THREE.Vector3();
      mesh.getWorldPosition(world);
      const flat = new THREE.Vector3(camera.position.x - world.x, 0, camera.position.z - world.z);
      if (flat.lengthSq() < 1e-4) continue;
      flat.normalize();
      const parentQ = new THREE.Quaternion();
      mesh.parent?.getWorldQuaternion(parentQ);
      parentQ.invert();
      flat.applyQuaternion(parentQ);
      mesh.rotation.y = Math.atan2(flat.x, flat.z);
    }
  }

  private resizeHandle(id: string, width: number, height: number): void {
    const root = this.meshes.get(id);
    if (!root) return;
    const depth = Number(root.userData.cardDepth) || 0.7;
    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 1.15, 1.15),
      new THREE.MeshLambertMaterial({ color: 0x2fd6bf, depthTest: false }),
    );
    handle.name = "resize";
    handle.userData.ui = true;
    handle.renderOrder = 6;
    handle.position.set(width / 2, height + 0.2, depth / 2 + 0.2);
    root.add(handle);
  }

  private scaleHandle(id: string): void {
    const root = this.meshes.get(id);
    if (!root) return;
    const box = new THREE.Box3().setFromObject(root);
    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.72, 0.72),
      new THREE.MeshLambertMaterial({ color: 0xf8fbfa, depthTest: false }),
    );
    handle.name = "scale";
    handle.userData.ui = true;
    handle.renderOrder = 6;
    const corner = new THREE.Vector3(box.max.x, box.max.y, box.max.z);
    root.worldToLocal(corner);
    handle.position.copy(corner);
    root.add(handle);
  }

  private counterJib(id: string, length: number, mastHeight: number): void {
    const root = this.meshes.get(id);
    if (!root) return;
    const catalog = root.getObjectByName("counterjib");
    const extra = root.getObjectByName("counter-jib");
    if (catalog) {
      catalog.scale.x = Math.max(0.4, length) / 5.4;
      extra?.removeFromParent();
      return;
    }
    let arm = extra as THREE.Mesh | null;
    if (!arm) {
      const geom = new THREE.BoxGeometry(DEFAULT_COUNTER_JIB, 0.45, 0.45);
      geom.translate(-DEFAULT_COUNTER_JIB / 2, 0, 0);
      arm = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: 0xf0b429 }));
      arm.name = "counter-jib";
      root.add(arm);
    }
    arm.scale.x = Math.max(1, length) / DEFAULT_COUNTER_JIB;
    arm.position.y = mastHeight;
  }

  private swingZone(id: string, radius: number, degrees: number): void {
    const root = this.meshes.get(id);
    if (!root) return;
    const key = `${Math.round(radius * 10)}|${Math.round(degrees)}`;
    let zone = root.getObjectByName("swing-zone");
    if (zone?.userData.swingKey === key) return;
    zone?.removeFromParent();
    if (zone) disposeObject(zone);
    zone = swingMesh(Math.max(2, radius), degrees);
    zone.name = "swing-zone";
    zone.userData.ui = true;
    zone.userData.swingKey = key;
    root.add(zone);
  }

  private drawPours(pours: PourItem[], live: Set<string>): void {
    for (const pour of pours) {
      const bound = this.boundFor(pour.modelId);
      if (!bound) continue;
      const name = `pour:${pour.id}`;
      const key = `${pour.sections}|${pour.minX}|${pour.minY}|${pour.minZ}|${pour.maxX}|${pour.maxY}|${pour.maxZ}`;
      let root = this.meshes.get(name);
      if (!root || root.userData.pourKey !== key) {
        root?.removeFromParent();
        if (root) disposeObject(root);
        root = buildPour(pour);
        root.name = name;
        root.userData.pourKey = key;
        root.userData.guid = pour.guid;
        root.userData.ui = true;
        bound.group.add(root);
        this.meshes.set(name, root);
      }
      live.add(name);
    }
  }

  private applyPourScales(): void {
    for (const [id, mesh] of this.meshes) {
      if (!id.startsWith("pour:")) continue;
      const fraction = this.pourTimes[String(mesh.userData.guid)] ?? 0;
      scaleSections(mesh, fraction, true);
    }
  }

  private boundFor(modelId?: string): BoundModel | null {
    if (modelId && this.models.has(modelId)) return this.models.get(modelId) ?? null;
    for (const [id, bound] of this.models) {
      if (id !== "ground") return bound;
    }
    return this.models.get("ground") ?? null;
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

function applyIfcRotation(object: THREE.Object3D, rx: number, ry: number, rz: number): void {
  const q = new THREE.Quaternion();
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -rz));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), ry));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rx));
  object.quaternion.copy(q);
}

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
    const clone = (item: THREE.Material) => {
      const next = item.clone();
      const colored = next as THREE.MeshStandardMaterial;
      if (colored.color) next.userData.baseColor = `#${colored.color.getHexString()}`;
      return next;
    };
    mesh.material = Array.isArray(material) ? material.map(clone) : clone(material);
  });
}

function pdfFrame(pdf: PdfOverlay): { origin: PlanPoint; yaw: number; width: number; height: number } | null {
  const aspect = pdf.aspect && pdf.aspect > 0.05 ? pdf.aspect : 1.4;
  if (pdf.pairs.length >= 2) {
    const framed = frameFromPairs(pdf.pairs[0]!, pdf.pairs[1]!, aspect);
    if (framed) return framed;
  }
  if (!pdf.origin) return null;
  const width = pdf.width && pdf.width > 1 ? pdf.width : 24;
  return { origin: pdf.origin, yaw: 0, width, height: width / aspect };
}

function blankSheet(width: number, height: number, opacity: number, color: string): THREE.Mesh {
  const geom = new THREE.PlaneGeometry(width, height);
  geom.translate(width / 2, height / 2, 0);
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({
      color: 0xd7ece8,
      transparent: true,
      opacity: Math.min(1, Math.max(0.05, opacity)),
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.name = "sheet";
  mesh.userData.ui = true;
  mesh.userData.width = width;
  mesh.userData.height = height;
  mesh.userData.baseWidth = width;
  mesh.userData.baseHeight = height;
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom),
    new THREE.LineBasicMaterial({ color: color || "#163540" }),
  );
  frame.userData.ui = true;
  mesh.add(frame);
  return mesh;
}

function handleName(name: string): boolean {
  return (
    name === "resize" ||
    name === "scale" ||
    name === "axis-x" ||
    name === "axis-y" ||
    name === "axis-z" ||
    name.startsWith("vertex-") ||
    name.startsWith("edge-")
  );
}

function isHandle(part: SiteHit["part"]): boolean {
  return part === "vertex" || part === "edge" || part === "resize" || part === "scale" || part === "x" || part === "y" || part === "z";
}

function sheetMesh(width: number, height: number, canvas: HTMLCanvasElement, opacity: number, color: string): THREE.Mesh {
  const geom = new THREE.PlaneGeometry(width, height);
  geom.translate(width / 2, height / 2, 0);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map,
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.name = "sheet";
  mesh.userData.ui = true;
  mesh.userData.width = width;
  mesh.userData.height = height;
  mesh.userData.baseWidth = width;
  mesh.userData.baseHeight = height;
  return mesh;
}

function disc(name: string, color: number, radius: number, axis: "x" | "y" | "z"): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.08, 8, 48),
    new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  mesh.name = name;
  mesh.userData.ui = true;
  mesh.renderOrder = 4;
  if (axis === "x") mesh.rotation.y = Math.PI / 2;
  if (axis === "z") mesh.rotation.x = Math.PI / 2;
  return mesh;
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
  return group;
}

function buildPath(path: PlanPath, origin: PlanPoint): THREE.Group {
  const group = new THREE.Group();
  const base = ifcToThreePoint(origin);
  const color = new THREE.Color(path.color || PATH);
  for (let i = 1; i < path.points.length; i++) {
    const a = ifcToThreePoint(path.points[i - 1]!);
    const b = ifcToThreePoint(path.points[i]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.05) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, 0.12, 1.6), new THREE.MeshLambertMaterial({ color }));
    mesh.position.set((a.x + b.x) / 2 - base.x, (a.y + b.y) / 2 - base.y + 0.08, (a.z + b.z) / 2 - base.z);
    mesh.rotation.y = Math.atan2(dz, dx);
    group.add(mesh);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.35, 8), new THREE.MeshLambertMaterial({ color: 0xd64545 }));
    arrow.userData.ui = true;
    arrow.position.set(a.x + dx * 0.72 - base.x, a.y + dy * 0.72 - base.y + 0.35, a.z + dz * 0.72 - base.z);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
    group.add(arrow);
  }
  return group;
}

function buildTerrain(terrain: PlanTerrain, origin: PlanPoint): THREE.Group {
  const group = new THREE.Group();
  const base = ifcToThreePoint(origin);
  if (terrain.contour.length < 3) {
    terrain.contour.forEach((point) => {
      const at = ifcToThreePoint(point);
      const pin = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshLambertMaterial({ color: 0xf8fbfa }));
      pin.position.set(at.x - base.x, 0.3, at.z - base.z);
      group.add(pin);
    });
    return group;
  }
  const bodyColor = new THREE.Color(terrain.color || (terrain.operation === "cut" ? CUT : FILL));
  const slopeColor = new THREE.Color(terrain.slopeColor || SLOPE);
  const inner = terrain.contour.map((point) => ({ x: point.x, y: point.y }));
  const outer = offsetPolygon(inner, slopeRun(terrain.depth, terrain.slope));
  const depth = Math.max(0.2, terrain.depth);
  const top = terrain.operation === "fill" ? depth : 0;
  const bottom = terrain.operation === "cut" ? -depth : 0;
  const toLocal = (x: number, y: number, h: number) => {
    const at = ifcToThreePoint({ x, y, z: origin.z });
    return new THREE.Vector3(at.x - base.x, h, at.z - base.z);
  };
  const capShape = new THREE.Shape();
  inner.forEach((point, index) => {
    const at = toLocal(point.x, point.y, 0);
    if (index === 0) capShape.moveTo(at.x, at.z);
    else capShape.lineTo(at.x, at.z);
  });
  capShape.closePath();
  const cap = new THREE.Mesh(new THREE.ShapeGeometry(capShape), new THREE.MeshLambertMaterial({ color: bodyColor, side: THREE.DoubleSide }));
  cap.rotation.x = -Math.PI / 2;
  cap.position.y = terrain.operation === "cut" ? bottom : top;
  group.add(cap);
  const positions: number[] = [];
  const push = (v: THREE.Vector3) => positions.push(v.x, v.y, v.z);
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i]!;
    const b = inner[(i + 1) % inner.length]!;
    const c = outer[i] ?? a;
    const d = outer[(i + 1) % outer.length] ?? b;
    const aTop = toLocal(a.x, a.y, terrain.operation === "cut" ? bottom : top);
    const bTop = toLocal(b.x, b.y, terrain.operation === "cut" ? bottom : top);
    const cGround = toLocal(c.x, c.y, 0);
    const dGround = toLocal(d.x, d.y, 0);
    push(aTop); push(bTop); push(dGround);
    push(aTop); push(dGround); push(cGround);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  group.add(new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: slopeColor, side: THREE.DoubleSide })));
  return group;
}

function buildHatch(item: MarkupItem, origin: PlanPoint): THREE.Group {
  const group = new THREE.Group();
  const points = item.points ?? [];
  const base = ifcToThreePoint(origin);
  if (points.length < 3) return group;
  const scale = item.scale && item.scale > 0.1 ? item.scale : 1;
  const centroid = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  centroid.x /= points.length;
  centroid.y /= points.length;
  const shape = new THREE.Shape();
  points.forEach((point, index) => {
    const scaled = { x: centroid.x + (point.x - centroid.x) * scale, y: centroid.y + (point.y - centroid.y) * scale };
    const at = ifcToThreePoint({ ...scaled, z: point.z });
    const x = at.x - base.x;
    const y = at.z - base.z;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();
  const mesh = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshLambertMaterial({
      color: item.color || "#8aa4ad",
      map: item.kind === "polygon" || item.pattern === "solid" ? null : hatchTexture(item.pattern || "diagonal"),
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.08;
  group.add(mesh);
  if (item.text) group.add(label(item.text, item.color || "#071820"));
  return group;
}

function buildPin(text: string, color: string, markup: boolean): THREE.Group {
  const group = new THREE.Group();
  const pin = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 10), new THREE.MeshLambertMaterial({ color }));
  pin.position.y = markup ? 1.6 : 0.4;
  group.add(pin);
  if (markup) {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), new THREE.MeshLambertMaterial({ color }));
    stem.position.y = 0.8;
    group.add(stem);
  }
  if (text) group.add(label(text, "#071820"));
  return group;
}

function buildCard(text: string, color: string, width: number, height: number, balloon: boolean): THREE.Group {
  const group = new THREE.Group();
  const depth = Math.max(1.4, Math.min(width, height) * 0.28);
  group.userData.billboard = true;
  group.userData.cardDepth = depth;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshBasicMaterial({ color }),
  );
  body.position.y = height / 2 + 0.08;
  group.add(body);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(body.geometry),
    new THREE.LineBasicMaterial({ color: 0xf8fbfa }),
  );
  edges.position.copy(body.position);
  group.add(edges);
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = Math.max(128, Math.round(512 * (height / Math.max(width, 0.2))));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    roundRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 28);
    ctx.fill();
    ctx.fillStyle = luminance(color) > 0.6 ? "#071820" : "#f8fbfa";
    ctx.font = "600 42px 'IBM Plex Sans', sans-serif";
    ctx.textBaseline = "top";
    wrapText(ctx, text || " ", 36, 40, canvas.width - 72, 52);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(0.4, width * 0.92), Math.max(0.3, height * 0.82)),
    new THREE.MeshBasicMaterial({ map, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  plane.position.set(0, height / 2 + 0.08, depth / 2 + 0.02);
  group.add(plane);
  if (balloon) {
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 8), new THREE.MeshLambertMaterial({ color }));
    tail.position.y = 0.2;
    tail.rotation.x = Math.PI;
    group.add(tail);
  }
  return group;
}

function vertexLetter(letter: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f8fbfa";
    ctx.font = "700 36px 'IBM Plex Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, 32, 34);
  }
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }),
  );
  sprite.position.y = 0.85;
  sprite.scale.set(1.15, 1.15, 1);
  sprite.userData.ui = true;
  sprite.raycast = () => {};
  return sprite;
}

function label(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 8, canvas.width, 48);
    ctx.fillStyle = luminance(color) > 0.6 ? "#071820" : "#f8fbfa";
    ctx.font = "600 28px 'IBM Plex Sans', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(text.slice(0, 22), 12, 32);
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }));
  sprite.position.set(0, 2.4, 0);
  sprite.scale.set(4.2, 1.05, 1);
  sprite.userData.ui = true;
  return sprite;
}

function hatchTexture(pattern: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.strokeStyle = "#071820";
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 3;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    if (pattern === "horizontal") {
      for (let y = 8; y < 64; y += 14) line(0, y, 64, y);
    } else if (pattern === "cross") {
      for (let i = -64; i < 128; i += 16) {
        line(i, 0, i + 64, 64);
        line(i, 64, i + 64, 0);
      }
    } else {
      for (let i = -64; i < 128; i += 14) line(i, 64, i + 64, 0);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.35, 0.35);
  return tex;
}

function buildFence(fence: PlanFence): THREE.Group {
  const group = new THREE.Group();
  const panels = Math.max(1, Math.round(fence.panels));
  const length = Math.max(0.8, fence.length);
  const height = 2;
  const width = length / panels;
  const color = fence.color || "#d5dee2";
  for (let i = 0; i < panels; i++) {
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.2, width - 0.1), height * 0.72, 0.05),
      new THREE.MeshLambertMaterial({ color }),
    );
    panel.position.set(-length / 2 + width * (i + 0.5), height * 0.58, 0);
    group.add(panel);
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, height, 0.08),
      new THREE.MeshLambertMaterial({ color: 0x163540 }),
    );
    post.position.set(-length / 2 + width * i, height / 2, 0);
    group.add(post);
  }
  const end = new THREE.Mesh(new THREE.BoxGeometry(0.08, height, 0.08), new THREE.MeshLambertMaterial({ color: 0x163540 }));
  end.position.set(length / 2, height / 2, 0);
  group.add(end);
  return group;
}

function buildDrill(drill: PlanDrill): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 2.4, 1.6),
    new THREE.MeshLambertMaterial({ color: drill.color || "#f0b429" }),
  );
  body.position.y = 1.35;
  group.add(body);
  const bit = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.22, 1, 10),
    new THREE.MeshStandardMaterial({ color: 0x5c6770, metalness: 0.45, roughness: 0.4 }),
  );
  bit.geometry.translate(0, -0.5, 0);
  bit.name = "bit";
  bit.scale.y = Math.max(0.2, drill.depth);
  group.add(bit);
  return group;
}

function buildMass(mass: PlanMass): THREE.Group {
  const group = new THREE.Group();
  const sections = Math.max(1, Math.round(mass.sections ?? 1));
  const width = Math.max(0.4, mass.width);
  const depth = Math.max(0.4, mass.depth);
  const height = Math.max(0.2, mass.height);
  const slice = width / sections;
  for (let i = 0; i < sections; i++) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(slice * 0.96, height, depth),
      new THREE.MeshLambertMaterial({ color: mass.color || "#8aa0a6", transparent: true, opacity: 0.92 }),
    );
    mesh.geometry.translate(0, height / 2, 0);
    mesh.name = `section-${i}`;
    mesh.position.set(-width / 2 + slice * (i + 0.5), 0, 0);
    group.add(mesh);
  }
  return group;
}

function buildPour(pour: PourItem): THREE.Group {
  const group = new THREE.Group();
  const sections = Math.max(1, Math.round(pour.sections));
  const sizeX = Math.max(0.05, pour.maxX - pour.minX);
  const sizeY = Math.max(0.05, pour.maxY - pour.minY);
  const sizeZ = Math.max(0.05, pour.maxZ - pour.minZ);
  const slice = sizeX / sections;
  for (let i = 0; i < sections; i++) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(slice * 0.98, sizeY, sizeZ),
      new THREE.MeshLambertMaterial({ color: 0xb7c4c8, transparent: true, opacity: 0.45 }),
    );
    mesh.geometry.translate(0, sizeY / 2, 0);
    mesh.name = `section-${i}`;
    mesh.position.set(pour.minX + slice * (i + 0.5), pour.minY, (pour.minZ + pour.maxZ) / 2);
    mesh.userData.ui = true;
    group.add(mesh);
  }
  return group;
}

function swingMesh(radius: number, degrees: number): THREE.Mesh {
  const sweep = (Math.min(360, Math.max(10, degrees)) * Math.PI) / 180;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  if (sweep >= Math.PI * 2 - 0.02) shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  else shape.absarc(0, 0, radius, -sweep / 2, sweep / 2, false);
  shape.lineTo(0, 0);
  const geom = new THREE.ShapeGeometry(shape, 48);
  geom.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({
      color: 0xf5d34d,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.position.y = 0.06;
  return mesh;
}

function scaleSections(root: THREE.Object3D, t: number, staged: boolean): void {
  const parts = root.children.filter((child) => child.name.startsWith("section-"));
  const count = Math.max(1, parts.length);
  parts.forEach((part, index) => {
    const start = staged ? index / count : 0;
    const span = staged ? 1 / count : 1;
    const local = Math.min(1, Math.max(0, (t - start) / span));
    part.scale.y = Math.max(0.02, local);
  });
}

function box(group: THREE.Group, w: number, h: number, d: number, x: number, y: number, z: number, color: number): void {
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
    if (obj.userData.ui) return;
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

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  if (value.length !== 6) return 0;
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, line: number): void {
  const words = text.split(/\s+/);
  let row = "";
  let top = y;
  for (const word of words) {
    const next = row ? `${row} ${word}` : word;
    if (ctx.measureText(next).width > max && row) {
      ctx.fillText(row, x, top);
      row = word;
      top += line;
    } else row = next;
  }
  if (row) ctx.fillText(row, x, top);
}
