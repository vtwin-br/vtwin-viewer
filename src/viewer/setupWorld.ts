import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";

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
    antialias: true,
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
  cam.threePersp.near = 0.1;
  cam.threePersp.updateProjectionMatrix();
  cam.threeOrtho.far = 1e7;
  cam.threeOrtho.near = -1e7;
  cam.threeOrtho.updateProjectionMatrix();

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

  world.camera.controls.addEventListener("update", () => fragments.core.update());
  world.onCameraChanged.add((camera) => {
    for (const [, model] of fragments.list) {
      model.useCamera(camera.three);
    }
    fragments.core.update(true);
  });

  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
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
  onProgress?: (p: number) => void,
): Promise<LoadedModel> {
  const { ifcLoader, fragments, world } = handles;

  await ifcLoader.load(buffer, false, modelId, {
    processData: {
      progressCallback: (p: number) => onProgress?.(p),
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
  await fragments.core.update(true);
  await fitCameraToModel(world, model);
  return { model };
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
    await fragments.core.update(true);
  } catch {
    // worker pode já ter libertado o modelo
  }
}

/** Recentra a câmara nos modelos visíveis (botão “Enquadrar”). */
export async function refitViewerCamera(handles: ViewerHandles, modelId?: string): Promise<void> {
  if (modelId) {
    const model = handles.fragments.list.get(modelId);
    if (!model || model.object.visible === false) return;
    await fitCameraToModel(handles.world, model);
    await handles.fragments.core.update(true);
    return;
  }
  await fitCameraToVisibleModels(handles);
}

export async function fitCameraToVisibleModels(handles: ViewerHandles): Promise<void> {
  const box = new THREE.Box3();
  let any = false;
  for (const [, model] of handles.fragments.list) {
    if (model.object.visible === false) continue;
    const b = new THREE.Box3().setFromObject(model.object);
    if (b.isEmpty()) continue;
    box.union(b);
    any = true;
  }
  if (!any) return;
  await lookAtBox(handles.world, box, 1.5);
  await handles.fragments.core.update(true);
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
  sets: Array<{ model: FRAGS.FragmentsModel; localIds: number[] }>,
): Promise<void> {
  const worldBox = new THREE.Box3();
  let any = false;
  for (const { model, localIds } of sets) {
    if (!localIds.length) continue;
    try {
      let box: THREE.Box3;
      if (typeof model.getMergedBox === "function") {
        box = await model.getMergedBox(localIds);
      } else {
        const boxes = await model.getBoxes(localIds);
        box = new THREE.Box3();
        for (const b of boxes) {
          if (b) box.union(b);
        }
      }
      if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) continue;
      model.object.updateWorldMatrix(true, false);
      box.applyMatrix4(model.object.matrixWorld);
      worldBox.union(box);
      any = true;
    } catch (err) {
      console.warn("Não foi possível enquadrar a seleção:", err);
    }
  }
  if (!any) return;
  await lookAtBox(handles.world, worldBox, 2.15);
  await handles.fragments.core.update(true);
}

async function fitCameraToModel(world: OBC.World, model: FRAGS.FragmentsModel) {
  try {
    const box = new THREE.Box3().setFromObject(model.object);
    await lookAtBox(world, box, 1.5);
  } catch (err) {
    console.warn("Nao foi possivel enquadrar a camera:", err);
  }
}

async function lookAtBox(world: OBC.World, box: THREE.Box3, distanceScale: number) {
  if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 0.6);
  const dist = maxDim * distanceScale || 30;
  const cam = world.camera as OBC.OrthoPerspectiveCamera;
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
