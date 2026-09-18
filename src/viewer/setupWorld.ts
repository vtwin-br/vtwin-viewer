import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import { requestFragmentsUpdate } from "./fragmentsUpdate";
import { configureOpenBimSemanticProfile } from "../ifc/semanticProfile";

export interface ViewerHandles {
  components: OBC.Components;
  world: OBC.World;
  fragments: OBC.FragmentsManager;
  ifcLoader: OBC.IfcLoader;
}

export interface LoadedModel {
  model: FRAGS.FragmentsModel;
}

/**
 * Cria o mundo 3D (cena, camera, renderer, grid) e configura o IfcLoader.
 * Aponta o web-ifc para os WASMs em /wasm/ (servidos por Vite a partir de public/).
 */
export function setWorldGridVisible(world: OBC.World, visible: boolean): void {
  const components = (world as unknown as { components?: OBC.Components }).components;
  const grid = components?.get(OBC.Grids).list.get(world.uuid);
  if (grid) grid.visible = visible;
  world.scene.three.traverse((obj) => {
    if (obj.type === "GridHelper") obj.visible = visible;
  });
}

export async function createViewer(container: HTMLElement): Promise<ViewerHandles> {
  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<
    OBC.SimpleScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
  >();

  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, container, {
    // Necessario para coexistir com tiles globais (Google Photorealistic 3D Tiles)
    // sem perder precisao de profundidade no IFC (que esta perto da camara).
    logarithmicDepthBuffer: true,
    antialias: !isWeakGpu(),
    powerPreference: "high-performance",
  });
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  world.scene.setup();
  world.scene.three.background = new THREE.Color(0xf0f2f6);
  world.renderer.showLogo = false;

  components.init();

  // Aumenta o far plane das cameras (perspectiva e ortografica) para suportar
  // a malha global do Google. O log depth buffer cuida da precisao perto.
  const cam = world.camera as OBC.OrthoPerspectiveCamera;
  cam.threePersp.far = 1e7;
  cam.threePersp.near = 0.05;
  cam.threePersp.updateProjectionMatrix();
  cam.threeOrtho.far = 1e7;
  cam.threeOrtho.near = -1e7;
  cam.threeOrtho.updateProjectionMatrix();
  configureOrbitNavigation(cam);

  // Grid para referencia espacial
  const grids = components.get(OBC.Grids);
  grids.create(world);

  // Configura IfcLoader -> aponta WASM para /wasm/ (servidos pelo Vite)
  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: "/wasm/",
      absolute: true,
    },
  });

  // Configura FragmentsManager (worker do unpkg ja resolvido pela lib)
  const workerUrl = await OBC.FragmentsManager.getWorker();
  const fragments = components.get(OBC.FragmentsManager);
  fragments.init(workerUrl);

  world.camera.controls.addEventListener("update", () => {
    void requestFragmentsUpdate(fragments);
  });
  world.onCameraChanged.add((camera) => {
    for (const [, model] of fragments.list) {
      model.useCamera(camera.three);
    }
    void requestFragmentsUpdate(fragments, true);
  });

  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    void requestFragmentsUpdate(fragments, true);
  });

  // Reduz z-fighting com pequeno offset por material
  fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
    if (!("isLodMaterial" in material && material.isLodMaterial)) {
      material.polygonOffset = true;
      material.polygonOffsetUnits = 1;
      material.polygonOffsetFactor = Math.random();
    }
  });

  return { components, world, fragments, ifcLoader };
}

/**
 * Carrega o IFC em FragmentsModel via OBC.IfcLoader. Retorna o modelo
 * resultante e enquadra a camera.
 */
export async function loadIfc(
  handles: ViewerHandles,
  buffer: Uint8Array,
  modelId = "main",
  onProgress?: (p: number, phase?: string) => void,
): Promise<LoadedModel> {
  const { ifcLoader, fragments, world } = handles;

  await ifcLoader.load(buffer, false, modelId, {
    instanceCallback: configureOpenBimSemanticProfile,
    processData: {
      progressCallback: (p, data) => onProgress?.(p, data.process),
    },
  });

  return finishLoadedModel(handles, modelId, world, fragments);
}

/** Carrega um .frag já convertido — sem tessellation web-ifc. */
export async function loadFragments(
  handles: ViewerHandles,
  buffer: Uint8Array | ArrayBuffer,
  modelId = "main",
): Promise<LoadedModel> {
  const { fragments, world } = handles;
  await fragments.core.load(buffer, { modelId, raw: false });
  return finishLoadedModel(handles, modelId, world, fragments);
}

export async function exportFragmentsBuffer(model: FRAGS.FragmentsModel): Promise<Uint8Array> {
  const buf = await model.getBuffer(false);
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf);
}

async function finishLoadedModel(
  handles: ViewerHandles,
  modelId: string,
  world: OBC.World,
  fragments: OBC.FragmentsManager,
): Promise<LoadedModel> {
  const model = handles.fragments.list.get(modelId);
  if (!model) throw new Error("Falha ao carregar o modelo 3D: não apareceu em fragments.list");
  applyModelQuality(model);
  await requestFragmentsUpdate(fragments, true);
  await fitCameraToModel(world, model);
  return { model };
}

export function deviceGraphicsQuality(): number {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (mem != null && mem <= 4) return 0.35;
  if (cores <= 4) return 0.5;
  if (cores <= 8) return 0.75;
  return 1;
}

export function isWeakGpu(): boolean {
  return deviceGraphicsQuality() <= 0.5;
}

export function applyModelQuality(model: FRAGS.FragmentsModel, quality = deviceGraphicsQuality()): void {
  model.graphicsQuality = Math.max(0, Math.min(1, quality));
}

export function setAllModelsQuality(fragments: OBC.FragmentsManager, quality: number): void {
  const q = Math.max(0, Math.min(1, quality));
  for (const [, model] of fragments.list) applyModelQuality(model, q);
  void requestFragmentsUpdate(fragments);
}

/** Remove o modelo IFC atual para permitir importar outro ficheiro. */
export async function unloadIfc(handles: ViewerHandles, modelId = "main"): Promise<void> {
  const { fragments, world } = handles;
  const model = fragments.list.get(modelId);
  if (!model) return;
  try {
    world.scene.three.remove(model.object);
  } catch {
    // já não estava na cena
  }
  const disposable = model as { dispose?: () => Promise<void> | void };
  if (typeof disposable.dispose === "function") {
    try {
      await disposable.dispose();
    } catch (err) {
      console.warn("Falha ao libertar o modelo IFC anterior:", err);
    }
  }
  fragments.list.delete(modelId);
  try {
    await requestFragmentsUpdate(fragments, true);
  } catch {
    // worker pode já ter libertado o modelo
  }
}

export interface CameraFitOptions {
  /** Modelos sem malha útil (COORD.ifc) — não entram no enquadramento. */
  skipModelIds?: Iterable<string>;
}

/** Recentra a câmara nos modelos visíveis (botão “Enquadrar”). */
export async function refitViewerCamera(
  handles: ViewerHandles,
  modelId?: string,
  opts?: CameraFitOptions,
): Promise<void> {
  if (modelId) {
    const model = handles.fragments.list.get(modelId);
    if (!model || model.object.visible === false) return;
    await fitCameraToModel(handles.world, model);
    await requestFragmentsUpdate(handles.fragments, true);
    return;
  }
  await fitCameraToVisibleModels(handles, opts);
}

export async function fitCameraToVisibleModels(
  handles: ViewerHandles,
  opts?: CameraFitOptions,
): Promise<void> {
  const skip = new Set(opts?.skipModelIds ?? []);
  const boxes: THREE.Box3[] = [];
  for (const [id, model] of handles.fragments.list) {
    if (skip.has(id) || model.object.visible === false) continue;
    const box = await geometryWorldBox(model);
    if (box) boxes.push(box);
  }
  const merged = mergeNearbyBoxes(boxes);
  if (!merged) return;
  await lookAtBox(handles.world, merged, 1.4);
  await requestFragmentsUpdate(handles.fragments, true);
}

/** Enquadra a câmara nos itens selecionados (conjunto / grupo espacial). */
export async function fitCameraToItems(
  handles: ViewerHandles,
  localIds: number[],
  modelId = "main",
): Promise<void> {
  const model = handles.fragments.list.get(modelId);
  if (!model || localIds.length === 0) return;
  await fitCameraToItemSets(handles, [{ model, localIds }]);
}

export async function fitCameraToItemSets(
  handles: ViewerHandles,
  sets: Array<{ model: FRAGS.FragmentsModel; localIds: number[]; modelId?: string }>,
  opts?: CameraFitOptions,
): Promise<void> {
  const skip = new Set(opts?.skipModelIds ?? []);
  const boxes: THREE.Box3[] = [];
  for (const { model, localIds, modelId } of sets) {
    if (!localIds.length) continue;
    if (modelId && skip.has(modelId)) continue;
    try {
      const box = await geometryWorldBox(model, localIds);
      if (box) boxes.push(box);
    } catch (err) {
      console.warn("Não foi possível enquadrar a seleção:", err);
    }
  }
  const merged = mergeNearbyBoxes(boxes);
  if (!merged) {
    await fitCameraToVisibleModels(handles, opts);
    return;
  }
  await lookAtBox(handles.world, merged, 1.45);
  await requestFragmentsUpdate(handles.fragments, true);
}

async function fitCameraToModel(world: OBC.World, model: FRAGS.FragmentsModel) {
  try {
    const box = await geometryWorldBox(model);
    if (box) await lookAtBox(world, box, 1.4);
  } catch (err) {
    console.warn("Nao foi possivel enquadrar a camera:", err);
  }
}

/** Caixa da geometria visível — evita COORD vazio, helpers enormes e caixas IFC noutro referencial. */
async function geometryWorldBox(model: FRAGS.FragmentsModel, localIds?: number[]): Promise<THREE.Box3 | null> {
  const objectBox = meshWorldBox(model.object);
  let itemBox: THREE.Box3 | null = null;
  try {
    let ids = localIds;
    const geom = await model.getItemsIdsWithGeometry();
    if (geom.length) {
      if (ids?.length) {
        const allow = new Set(geom);
        ids = ids.filter((id) => allow.has(id));
      } else {
        ids = geom;
      }
      if (ids.length) {
        let box: THREE.Box3;
        if (typeof model.getMergedBox === "function") {
          box = await model.getMergedBox(ids);
        } else {
          const parts = await model.getBoxes(ids);
          box = new THREE.Box3();
          for (const part of parts) {
            if (part && !part.isEmpty()) box.union(part);
          }
        }
        if (boxIsUseful(box)) {
          model.object.updateWorldMatrix(true, false);
          const world = box.clone().applyMatrix4(model.object.matrixWorld);
          itemBox = boxIsUseful(world) ? world : box;
        }
      }
    }
  } catch {
    itemBox = null;
  }
  return pickFitBox(itemBox, objectBox, model.object);
}

function meshWorldBox(root: THREE.Object3D): THREE.Box3 | null {
  const boxes: THREE.Box3[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    if (!obj.visible) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingBox || geo.boundingBox.isEmpty()) return;
    const world = geo.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const size = boxSize(world);
    if (!Number.isFinite(size) || size < 0.02 || size > 8_000) return;
    boxes.push(world);
  });
  if (boxes.length) return mergeNearbyBoxes(boxes);
  const fallback = new THREE.Box3().setFromObject(root);
  return boxIsUseful(fallback) ? fallback : null;
}

function pickFitBox(item: THREE.Box3 | null, object: THREE.Box3 | null, root: THREE.Object3D): THREE.Box3 | null {
  const origin = new THREE.Vector3();
  root.getWorldPosition(origin);
  const near = (box: THREE.Box3 | null): THREE.Box3 | null => {
    if (!box || !boxIsUseful(box)) return null;
    const expanded = box.clone().expandByScalar(Math.max(boxSize(box) * 2, 80));
    if (expanded.containsPoint(origin)) return box;
    const center = box.getCenter(new THREE.Vector3());
    if (center.distanceTo(origin) < Math.max(boxSize(box) * 4, 250)) return box;
    return null;
  };
  const a = near(item);
  const b = near(object);
  if (a && b) {
    const sa = boxSize(a);
    const sb = boxSize(b);
    if (sa > sb * 6 && sb > 1) return b;
    if (sb > sa * 6 && sa > 1) return a;
    return b;
  }
  return b ?? a ?? (object && boxIsUseful(object) ? object : null);
}

function boxIsUseful(box: THREE.Box3): boolean {
  if (box.isEmpty()) return false;
  const { min, max } = box;
  if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) return false;
  const size = boxSize(box);
  if (size < 1e-4 || size > 8_000) return false;
  return true;
}

function boxSize(box: THREE.Box3): number {
  return Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
}

/** Une caixas próximas; descarta outliers (ex.: COORD na origem vs. modelo deslocado). */
function mergeNearbyBoxes(boxes: THREE.Box3[]): THREE.Box3 | null {
  const useful = boxes.filter(boxIsUseful);
  if (!useful.length) return null;
  if (useful.length === 1) return useful[0]!.clone();
  const sizes = useful.map(boxSize);
  let primary = 0;
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i]! > sizes[primary]!) primary = i;
  }
  const origin = useful[primary]!.getCenter(new THREE.Vector3());
  const span = Math.max(sizes[primary]!, 12);
  const merged = useful[primary]!.clone();
  for (let i = 0; i < useful.length; i++) {
    if (i === primary) continue;
    const center = useful[i]!.getCenter(new THREE.Vector3());
    if (center.distanceTo(origin) > Math.max(span * 8, 200)) continue;
    merged.union(useful[i]!);
  }
  return boxIsUseful(merged) ? merged : useful[primary]!.clone();
}

async function lookAtBox(world: OBC.World, box: THREE.Box3, distanceScale: number) {
  if (!boxIsUseful(box)) return;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const maxDim = Math.max(boxSize(box), 0.8);
  const dist = Math.min(Math.max(maxDim * distanceScale, 4), 1_200);
  const cam = world.camera as OBC.OrthoPerspectiveCamera;
  applyOrbitNavigation(cam);
  await cam.controls.setLookAt(
    center.x + dist * 0.85,
    center.y + dist * 0.55,
    center.z + dist * 0.85,
    center.x,
    center.y,
    center.z,
    true,
  );
}

/**
 * O OrbitMode do That Open impõe maxDistance=300 e infinityDolly=true.
 * Depois de orbitar / zoom / gizmo, o alvo é empurrado e a órbita fica num
 * raio de ~1 m: o rato quase não mexe e o zoom parece morto.
 */
const ORBIT_MIN_DISTANCE = 0.08;
const ORBIT_MAX_DISTANCE = 1e7;

type OrbitModePatch = {
  id?: string;
  activateOrbitControls?: () => void;
};

function applyOrbitNavigation(cam: OBC.OrthoPerspectiveCamera): void {
  const controls = cam.controls;
  controls.minDistance = ORBIT_MIN_DISTANCE;
  controls.maxDistance = ORBIT_MAX_DISTANCE;
  controls.infinityDolly = false;
  controls.dollyToCursor = true;
  controls.smoothTime = 0.12;
  controls.draggingSmoothTime = 0.05;
  controls.dollySpeed = 1.35;
  controls.truckSpeed = 2;
}

function configureOrbitNavigation(cam: OBC.OrthoPerspectiveCamera): void {
  applyOrbitNavigation(cam);
  try {
    const orbit = cam.mode as unknown as OrbitModePatch;
    if (orbit.id === "Orbit") {
      orbit.activateOrbitControls = () => applyOrbitNavigation(cam);
    }
  } catch {
    // câmara ainda sem NavigationMode
  }
}
