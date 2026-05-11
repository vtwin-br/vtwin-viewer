import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { TilesRenderer } from "3d-tiles-renderer";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/plugins";
import { Sky } from "three/examples/jsm/objects/Sky.js";

/** Latitude/longitude/altitude (graus, graus, metros sobre o elipsoide WGS84). */
export interface AnchorLLA {
  lat: number;
  lon: number;
  /** Altura sobre o elipsoide (m). Para colar no terreno do Google, usa a cota local + ~50 m de margem. */
  altitude: number;
  /**
   * Rotacao ao redor do "Up" do anchor (radianos), util para alinhar a planta do edificio
   * com a malha do Google. 0 = norte verdadeiro.
   */
  heading?: number;
}

export interface EarthTilesOptions {
  apiKey: string;
  anchor: AnchorLLA;
  /**
   * Raio (m) ao redor do anchor onde os tiles do Google ficam ocultos para
   * evitar sobreposicao com o IFC. 0 = mostra tudo. Recomendado 30-200 m.
   */
  hideRadiusMeters?: number;
}

/**
 * Camada que carrega a malha fotorrealista do Google (Photorealistic 3D Tiles)
 * dentro da mesma cena Three.js do viewer (That Open). O posicionamento eh
 * feito via frame ENU (East-North-Up) calculado no anchor.
 */
export class GoogleEarthLayer {
  private world: OBC.World;
  private opts: EarthTilesOptions;
  private tiles: TilesRenderer | null = null;
  private localFrame = new THREE.Matrix4();
  private localFrameInv = new THREE.Matrix4();
  private updateUnsub: (() => void) | null = null;
  private clipBox: THREE.Mesh | null = null;
  private sky: Sky | null = null;
  private prevBackground: THREE.Color | THREE.Texture | null = null;
  private _enabled = false;

  constructor(world: OBC.World, opts: EarthTilesOptions) {
    this.world = world;
    this.opts = opts;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  getAnchor(): AnchorLLA {
    return { ...this.opts.anchor };
  }

  getHideRadius(): number {
    return this.opts.hideRadiusMeters ?? 0;
  }

  /** Liga ou desliga a camada. */
  async setEnabled(on: boolean): Promise<void> {
    if (on === this._enabled) return;
    if (on) await this.attach();
    else this.detach();
  }

  /** Reposiciona o anchor sem destruir a camada. */
  setAnchor(anchor: AnchorLLA): void {
    this.opts.anchor = anchor;
    if (this.tiles) this.applyAnchorTransform();
  }

  setHideRadius(meters: number): void {
    this.opts.hideRadiusMeters = meters;
    this.refreshClipBox();
  }

  // -------------------------------------------------------------------------

  private async attach(): Promise<void> {
    const cam = this.world.camera as OBC.OrthoPerspectiveCamera;
    const renderer = this.world.renderer!.three;
    const scene = this.world.scene.three;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(
      new GoogleCloudAuthPlugin({
        apiToken: this.opts.apiKey,
        autoRefreshToken: true,
      }),
    );

    // ---- Tuning de performance --------------------------------------------
    // Estes valores aplicam-se DEPOIS do plugin Google (que sobrepoe o
    // errorTarget para 20). Subir o errorTarget perde algum detalhe mas
    // reduz drasticamente o numero de tiles a baixar / desenhar.
    tiles.errorTarget = 32;
    tiles.downloadQueue.maxJobs = 10; // HTTP/2 paraleliza bem ate ~10
    tiles.parseQueue.maxJobs = 4;
    // Cache mais generoso para nao reciclar tiles em panoramicas pequenas.
    tiles.lruCache.minSize = 600;
    tiles.lruCache.maxSize = 1200;

    // Camera ativa do OrthoPerspectiveCamera
    const activeCam = (cam as any).three as THREE.Camera;
    tiles.setCamera(activeCam);
    tiles.setResolutionFromRenderer(activeCam, renderer);

    // Adiciona ao mesmo grafo de cena
    scene.add(tiles.group);
    this.tiles = tiles;

    // Ceu procedural (Hosek-Wilkie). Sem isto o fundo continua a cor da app
    // e a malha do Google fica "flutuando" no nada, sem horizonte.
    this.installSky();

    this.applyAnchorTransform();
    this.refreshClipBox();

    // Update por frame. Mantemos a camera ativa do TilesRenderer sincronizada com
    // a do viewer (perspectiva <-> ortografica), pois o OrthoPerspectiveCamera
    // troca a referencia interna sem emitir evento.
    let lastCamRef: THREE.Camera = activeCam;
    const updateFn = () => {
      if (!this.tiles) return;
      const c = (this.world.camera as any).three as THREE.Camera;
      if (c !== lastCamRef) {
        for (const oldCam of [...this.tiles.cameras]) this.tiles.deleteCamera(oldCam);
        this.tiles.setCamera(c);
        lastCamRef = c;
      }
      this.tiles.setResolutionFromRenderer(c, renderer);
      this.tiles.update();
    };
    this.world.renderer!.onBeforeUpdate.add(updateFn);
    this.updateUnsub = () => this.world.renderer!.onBeforeUpdate.remove(updateFn);

    this._enabled = true;
  }

  private detach(): void {
    if (!this.tiles) return;
    this.updateUnsub?.();
    this.updateUnsub = null;

    this.world.scene.three.remove(this.tiles.group);
    if (this.clipBox) {
      this.world.scene.three.remove(this.clipBox);
      this.clipBox.geometry.dispose();
      (this.clipBox.material as THREE.Material).dispose();
      this.clipBox = null;
    }
    this.uninstallSky();
    this.tiles.dispose();
    this.tiles = null;
    this._enabled = false;
  }

  // ----- Ceu procedural ---------------------------------------------------

  private installSky(): void {
    if (this.sky) return;
    const scene = this.world.scene.three as THREE.Scene;

    const sky = new Sky();
    // Caixa gigante (450 km de "raio"): suficiente com log depth e far=1e7.
    sky.scale.setScalar(450000);
    const u = sky.material.uniforms;
    u.turbidity.value = 8;
    u.rayleigh.value = 1.8;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.7;

    // Sol a meio do ceu, ligeiramente para oeste — boa luz ambiente neutra.
    const sun = new THREE.Vector3();
    const phi = THREE.MathUtils.degToRad(90 - 55); // elevacao 55 deg
    const theta = THREE.MathUtils.degToRad(160); // azimute (graus do norte)
    sun.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(sun);

    scene.add(sky);
    this.sky = sky;

    // Salva e neutraliza o background da app — o ceu agora preenche tudo.
    this.prevBackground = scene.background as THREE.Color | THREE.Texture | null;
    scene.background = null;
  }

  private uninstallSky(): void {
    if (!this.sky) return;
    const scene = this.world.scene.three as THREE.Scene;
    scene.remove(this.sky);
    (this.sky.material as THREE.Material).dispose();
    this.sky.geometry.dispose();
    this.sky = null;
    scene.background = this.prevBackground;
    this.prevBackground = null;
  }

  /**
   * Constroi o frame ENU (East-North-Up) no anchor e usa o seu inverso como
   * matriz do `tiles.group`. Assim, os tiles em ECEF sao mapeados num sistema
   * local em metros, com origem no anchor e Y para cima (convencao Three.js).
   */
  private applyAnchorTransform(): void {
    if (!this.tiles) return;
    const { lat, lon, altitude, heading = 0 } = this.opts.anchor;
    const ellipsoid = this.tiles.ellipsoid;

    const enu = new THREE.Matrix4();
    ellipsoid.getEastNorthUpFrame(
      THREE.MathUtils.degToRad(lat),
      THREE.MathUtils.degToRad(lon),
      altitude,
      enu,
    );
    // ENU = [E, N, U, P] (X=East, Y=North, Z=Up); Three.js usa Y=Up, Z=South.
    // Rotacionamos +90 deg em torno de X (no espaco local) para trazer Up -> +Y
    // e North -> -Z. Sinal errado aqui poe o Y local a apontar para o centro
    // da Terra e os tiles aparecem de cabeca para baixo.
    const enuToYUp = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    const localToECEF = new THREE.Matrix4().multiplyMatrices(enu, enuToYUp);

    // Heading do edificio (rotacao em Y, ja no frame local)
    if (heading) {
      const headingMat = new THREE.Matrix4().makeRotationY(heading);
      localToECEF.multiply(headingMat);
    }

    // Inverso: ECEF -> local
    this.localFrame.copy(localToECEF);
    this.localFrameInv.copy(localToECEF).invert();

    this.tiles.group.matrixAutoUpdate = false;
    this.tiles.group.matrix.copy(this.localFrameInv);
    this.tiles.group.matrixWorldNeedsUpdate = true;

    this.refreshClipBox();
  }

  /**
   * Disco no chao com gradiente radial: opaco-claro no centro (esconde o
   * tile do Google por baixo do IFC) e desvanecendo para 0 nos bordos. Eh
   * um placeholder visual; o clipping real (stencil) entra depois. Default
   * 0 para nao aparecer "prato branco" como artifact.
   */
  private refreshClipBox(): void {
    if (!this.tiles) return;
    const r = this.opts.hideRadiusMeters ?? 0;
    if (r <= 0) {
      if (this.clipBox) {
        this.world.scene.three.remove(this.clipBox);
        this.clipBox.geometry.dispose();
        (this.clipBox.material as THREE.Material).dispose();
        this.clipBox = null;
      }
      return;
    }
    if (!this.clipBox) {
      const geo = new THREE.CircleGeometry(1, 96);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        map: makeRadialFadeTexture(),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.clipBox = new THREE.Mesh(geo, mat);
      this.clipBox.renderOrder = -1;
      this.world.scene.three.add(this.clipBox);
    }
    this.clipBox.scale.setScalar(r);
    // Eleva 5 cm para ficar visivelmente sobre o terreno do tile, sem briga
    // de z-fighting. Com log depth + offset, isto eh imperceptivel.
    this.clipBox.position.set(0, 0.05, 0);
  }
}

/**
 * Textura procedural com gradiente radial (alpha 1.0 no centro -> 0.0 na
 * borda) usada para fundir o disco com a malha do Google sem deixar uma
 * borda dura visivel.
 */
function makeRadialFadeTexture(): THREE.Texture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, "rgba(245,247,250,1.0)");
  grad.addColorStop(0.55, "rgba(245,247,250,0.85)");
  grad.addColorStop(0.85, "rgba(245,247,250,0.25)");
  grad.addColorStop(1.0, "rgba(245,247,250,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
