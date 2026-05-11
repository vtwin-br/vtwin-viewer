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

  const model = fragments.list.get(modelId);
  if (!model) throw new Error("Falha ao carregar IFC: modelo nao apareceu em fragments.list");

  // Aguarda o primeiro frame do worker computar a bounding box
  await fragments.core.update(true);

  // Enquadra a camera com base na bounding box do modelo
  await fitCameraToModel(world, model);

  return { model };
}

/** Recentra a câmara no modelo (botão “Enquadrar”). */
export async function refitViewerCamera(handles: ViewerHandles, modelId = "main"): Promise<void> {
  const model = handles.fragments.list.get(modelId);
  if (!model) return;
  await fitCameraToModel(handles.world, model);
  await handles.fragments.core.update(true);
}

async function fitCameraToModel(world: OBC.World, model: FRAGS.FragmentsModel) {
  try {
    const box = new THREE.Box3().setFromObject(model.object);
    if (!isFinite(box.min.x) || !isFinite(box.max.x)) return;
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.5 || 30;
    const cam = world.camera as OBC.OrthoPerspectiveCamera;
    await cam.controls.setLookAt(
      center.x + dist,
      center.y + dist * 0.8,
      center.z + dist,
      center.x,
      center.y,
      center.z,
      true,
    );
  } catch (err) {
    console.warn("Nao foi possivel enquadrar a camera:", err);
  }
}
