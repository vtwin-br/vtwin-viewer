import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UpdateOnChangePlugin,
} from "3d-tiles-renderer/plugins";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { hasStoredSiteElevation } from "../ifc/georef";
import { pointInPolygonXZ, type XzPoint } from "../logistics/polygon";
import { SITE_LIMIT_MAX_POINTS } from "../logistics/types";

const DRACO_DECODER_PATH = "https://www.gstatic.com/draco/v1/decoders/";
/** A sessão Photorealistic 3D Tiles da Google vale ~3 h; renovamos um pouco antes. */
const SESSION_TTL_MS = 2.75 * 60 * 60 * 1000;

/** 1 GiB em bytes — orçamento do LRU dos Photorealistic 3D Tiles. */
const GIB = 2 ** 30;

/**
 * SSE (px) em repouso. Valores menores = mais detalhe. O plugin Google recomenda 20;
 * perto do modelo baixamos para 14 para o LOD alto “grudar” como no Google Maps.
 */
const ERROR_STREET = 14;
const ERROR_BLOCK = 18;
const ERROR_CITY = 22;
const ERROR_SNAP = 12;
const ERROR_TELEPORT = 28;

function describeGoogleTilesError(raw: string, status?: number): string {
  const text = raw.replace(/\s+/g, " ").trim();
  const code = status ?? Number(/error code (\d{3})/i.exec(text)?.[1] ?? /(?:^|\D)([45]\d\d)(?:\D|$)/.exec(text)?.[1]);
  if (code === 404 || /NOT_FOUND|Requested entity was not found/i.test(text)) {
    return (
      "A Map Tiles API não está ativa neste projeto (404). Criar uma chave nova não chega: " +
      "no mesmo projeto da chave, ativa a Map Tiles API e a faturação. " +
      "https://console.cloud.google.com/apis/library/tile.googleapis.com"
    );
  }
  if (code === 403 || /PERMISSION_DENIED|referer|blocked/i.test(text)) {
    return (
      "A chave Google está bloqueada (403). Inclui http://localhost:5173/* nas restrições " +
      "de referer ou testa sem restrição de HTTP."
    );
  }
  if (code === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(text)) {
    return "A quota da Map Tiles API esgotou (429). Espera um pouco ou sobe o limite no Google Cloud.";
  }
  if (code === 400 || /INVALID_ARGUMENT/i.test(text)) {
    return "Pedido inválido à Map Tiles API (400). A sessão 3D pode ter expirado — volta a ligar a camada Earth.";
  }
  return text.slice(0, 220) || "Falha a carregar os Photorealistic 3D Tiles.";
}

export type EarthEnableResult = "created" | "resumed" | "paused" | "unchanged";

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
  /** Chamado quando o terreno do Google é amostrado (altura elipsoide, m). */
  onTerrainSnap?: (ellipsoidMeters: number) => void;
  /** Chamado se a malha não der um ponto de chão credível. */
  onTerrainSnapFail?: () => void;
  /** Falha a obter o tileset / um tile (API, rede, chave). */
  onLoadError?: (message: string) => void;
  /** Tiles novos carregaram — o talude pode reamostrar a cota do Google. */
  onTilesReady?: () => void;
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
  private clipCenter = new THREE.Vector3(0, 0.05, 0);
  private snapPending = false;
  private snapUntil = 0;
  private snapStarted = 0;
  private loadModelUnsub: (() => void) | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDir = new THREE.Vector3(0, -1, 0);
  private readonly ecefHit = new THREE.Vector3();
  private readonly cartHit = { lat: 0, lon: 0, height: 0 };
  private sky: Sky | null = null;
  private prevBackground: THREE.Color | THREE.Texture | null = null;
  private _enabled = false;
  private walkQuality = false;
  private smoothedError = ERROR_BLOCK;
  private lastCamPos = new THREE.Vector3();
  private lastCamQuat = new THREE.Quaternion();
  private lastCamT = 0;
  private lastResW = 0;
  private lastResH = 0;
  private prevPixelRatio: number | null = null;
  private prevSortObjects: boolean | null = null;
  private sseSettling = false;
  private ifcModelCount = 0;
  private siteClipPts: XzPoint[] = [];
  private siteClipYMin = -50;
  private siteClipYMax = 80;
  private tilesReadyTimer = 0;
  /** Instante do último `root.json` (SKU faturável). */
  private sessionAt = 0;
  private enableLock: Promise<void> | null = null;
  private recreating = false;
  private rootRetries = 0;

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

  /** Há tileset em memória (visível ou em pausa). */
  hasTiles(): boolean {
    return this.tiles != null;
  }

  /** Divide o orçamento de VRAM entre os tiles e as disciplinas IFC visíveis. */
  setIfcModelCount(count: number): void {
    this.ifcModelCount = Math.max(0, Math.floor(count));
    this.applyTileMemoryBudget();
  }

  /**
   * Liga ou desliga a camada. Desligar **pausa** o renderer (sem `root.json`
   * novo). A Google fatura sobretudo o pedido raiz (~3 h de sessão); ligar e
   * desligar na mesma página reutiliza essa sessão.
   */
  async setEnabled(on: boolean): Promise<EarthEnableResult> {
    const run = this.enableLock ?? Promise.resolve();
    let result: EarthEnableResult = "unchanged";
    const next = run.then(async () => {
      if (on) {
        if (this._enabled) return;
        if (this.tiles && this.sessionFresh()) {
          this.resume();
          result = "resumed";
          return;
        }
        if (this.tiles) this.detach();
        await this.attach();
        result = "created";
        return;
      }
      if (!this._enabled && !this.tiles) return;
      this.pause();
      result = "paused";
    });
    this.enableLock = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
    return result;
  }

  private sessionFresh(): boolean {
    return this.sessionAt > 0 && Date.now() - this.sessionAt < SESSION_TTL_MS;
  }

  /** Reposiciona o anchor. Por omissão só assenta se lat/lon mudaram. */
  setAnchor(anchor: AnchorLLA, opts?: { snap?: boolean }): void {
    const prev = this.opts.anchor;
    const moved =
      Math.abs(prev.lat - anchor.lat) > 1e-8 || Math.abs(prev.lon - anchor.lon) > 1e-8;
    this.opts.anchor = anchor;
    if (this.tiles) this.applyAnchorTransform();
    if (this._enabled && (opts?.snap ?? moved)) this.requestTerrainSnap();
  }

  /** Sobe a malha Google na vista (metros). O modelo IFC não mexe. */
  raiseTerrain(sceneMeters: number): void {
    if (!Number.isFinite(sceneMeters) || Math.abs(sceneMeters) < 1e-9) return;
    this.setAnchor(
      { ...this.opts.anchor, altitude: this.opts.anchor.altitude - sceneMeters },
      { snap: false },
    );
  }

  /** Assenta o chão do Google em Y=0, sem mexer no modelo IFC. */
  requestTerrainSnap(): void {
    this.snapPending = true;
    this.snapStarted = performance.now();
    this.snapUntil = this.snapStarted + 45000;
    if (this.tiles) this.tiles.errorTarget = ERROR_SNAP;
    this.tryTerrainSnap();
  }

  setHideRadius(meters: number): void {
    this.opts.hideRadiusMeters = meters;
    this.refreshClipBox();
  }

  /**
   * Recorte em prisma: dentro do polígono XZ e entre yMin/yMax os tiles não desenham
   * (árvores, casas e relevo do Google desaparecem no lote).
   */
  setSiteClip(poly: XzPoint[] | null, yMin = -50, yMax = 80): void {
    this.siteClipPts = poly && poly.length >= 3 ? poly.slice(0, SITE_LIMIT_MAX_POINTS) : [];
    this.siteClipYMin = yMin;
    this.siteClipYMax = yMax;
    const u = SITE_CLIP_UNIFORMS;
    u.enabled.value = this.siteClipPts.length >= 3 ? 1 : 0;
    u.count.value = this.siteClipPts.length;
    u.yMin.value = yMin;
    u.yMax.value = yMax;
    for (let i = 0; i < SITE_LIMIT_MAX_POINTS; i++) {
      const p = this.siteClipPts[i];
      u.pts.value[i]!.set(p?.x ?? 0, p?.z ?? 0);
    }
    if (this.siteClipPts.length >= 3 && this.tiles) bindSiteClipMaterials(this.tiles.group);
  }

  siteClipContains(world: THREE.Vector3): boolean {
    if (this.siteClipPts.length < 3) return false;
    if (world.y > this.siteClipYMax || world.y < this.siteClipYMin) return false;
    return pointInPolygonXZ({ x: world.x, z: world.z }, this.siteClipPts);
  }

  /**
   * Cota Y (Three) da malha Google visível em (x, z). Ignora globo de LOD
   * baixo e o prisma do canteiro; cruza um pequeno offset para não cair
   * só num pico (muro / copa).
   */
  sampleGroundY(x: number, z: number, aroundY: number): number | null {
    if (!this.tiles) return null;
    let best: number | null = null;
    const consider = (hx: number, hz: number) => {
      const top = Math.max(aroundY, 0) + 160;
      this.rayOrigin.set(hx, top, hz);
      const hit = this.raycast(this.rayOrigin, this.rayDir, top + 80 - (Math.min(aroundY, 0) - 80));
      if (!hit) return;
      if (this.hitToEllipsoidHeight(hit.point) == null) return;
      const hy = hit.point.y;
      const lo = Math.min(aroundY, 0) - 60;
      const hi = Math.max(aroundY, 0) + 40;
      if (hy > hi || hy < lo) return;
      if (best == null || hy < best) best = hy;
    };
    consider(x, z);
    consider(x + 1.6, z);
    consider(x - 1.6, z);
    consider(x, z + 1.6);
    consider(x, z - 1.6);
    return best;
  }

  /** Reposiciona o disco de oclusão (segue o modelo quando ele é arrastado). */
  setClipCenter(x: number, y: number, z: number): void {
    this.clipCenter.set(x, y + 0.05, z);
    if (this.clipBox) this.clipBox.position.copy(this.clipCenter);
  }

  /** Grupo dos Photorealistic 3D Tiles (colisão em 1ª pessoa). */
  getTilesGroup(): THREE.Object3D | null {
    return this.tiles?.group ?? null;
  }

  /**
   * Raycast na malha do Google. Ignora o disco de oclusão do IFC.
   * `far` em metros no referencial local (Y-up).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, far = 80): THREE.Intersection | null {
    if (!this.tiles) return null;
    const ndir = dir.lengthSq() > 0 ? dir.clone().normalize() : dir;
    this.raycaster.near = 0;
    this.raycaster.far = far;
    this.raycaster.firstHitOnly = true;
    this.raycaster.set(origin, ndir);
    const found = this.raycaster.intersectObject(this.tiles.group, true);
    for (const h of found) {
      if (h.object === this.clipBox) continue;
      if (!Number.isFinite(h.distance) || h.distance > far) continue;
      if (this.siteClipContains(h.point)) continue;
      return h;
    }
    return null;
  }

  /** Mais detalhe nos tiles quando se anda (melhor hitbox no chão). */
  setWalkQuality(on: boolean): void {
    this.walkQuality = on;
    if (this.tiles && !this.snapPending) {
      this.smoothedError = on ? ERROR_STREET : ERROR_BLOCK;
      this.tiles.errorTarget = this.smoothedError;
    }
  }

  // -------------------------------------------------------------------------

  private async attach(): Promise<void> {
    const key = this.opts.apiKey.trim();
    if (!key) {
      throw new Error(
        "Falta VITE_GOOGLE_MAP_TILES_API_KEY no .env. Reinicia o `npm run dev` depois de a preencher.",
      );
    }
    try {
      await this.attachTiles();
    } catch (err) {
      this.detach();
      throw err;
    }
  }

  private async attachTiles(): Promise<void> {
    const cam = this.world.camera as OBC.OrthoPerspectiveCamera;
    const renderer = this.world.renderer!.three;
    const scene = this.world.scene.three;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(
      new GoogleCloudAuthPlugin({
        apiToken: this.opts.apiKey.trim(),
        // `true` volta a pedir root.json a cada 4xx de tile — cada um é SKU.
        autoRefreshToken: false,
      }),
    );
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));
    // Menos VRAM (sem mipmaps) e índices compactos — sem comprimir posições
    // (artefactos visíveis na malha fotorrealista).
    tiles.registerPlugin(
      new TileCompressionPlugin({
        disableMipmaps: true,
        compressIndex: true,
        compressPosition: false,
        compressNormals: false,
        compressUvs: false,
      }),
    );
    tiles.registerPlugin({
      name: "UNLIT_GOOGLE_TILES",
      priority: -50,
      processTileModel(scene: THREE.Object3D) {
        makeTilesUnlit(scene);
        bindSiteClipMaterials(scene);
      },
    });
    tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 180, maximumFadeOutTiles: 40 }));
    tiles.registerPlugin(new UpdateOnChangePlugin());

    // ---- Tuning de performance --------------------------------------------
    // O plugin Google põe errorTarget=20. Perto do modelo usamos 14 para o
    // LOD alto ficar estável; o LRU grande evita descarregar a malha ao orbitar.
    this.smoothedError = ERROR_BLOCK;
    tiles.errorTarget = ERROR_BLOCK;
    tiles.downloadQueue.maxJobs = 12;
    tiles.parseQueue.maxJobs = 3;
    tiles.processNodeQueue.maxJobs = 12;
    tiles.maxTilesProcessed = 120;
    // Defaults da lib: 6000/8000 tiles e ~0.3–0.4 GiB. O cache anterior
    // (600/1200) despejava tiles a cada pan — parecia “recarregar o LOD”.
    tiles.lruCache.minSize = 2800;
    tiles.lruCache.maxSize = 5500;
    tiles.lruCache.unloadPercent = 0.04;
    this.applyTileMemoryBudget();

    const activeCam = (cam as any).three as THREE.Camera;
    tiles.setCamera(activeCam);
    tiles.setResolutionFromRenderer(activeCam, renderer);
    this.lastResW = renderer.domElement.clientWidth;
    this.lastResH = renderer.domElement.clientHeight;
    this.lastCamPos.copy(activeCam.position);
    this.lastCamQuat.copy(activeCam.quaternion);
    this.lastCamT = performance.now();

    scene.add(tiles.group);
    this.tiles = tiles;
    this.applyTileMemoryBudget();

    this.installSky();
    this.applyRendererBudget(true);

    this.applyAnchorTransform();
    this.refreshClipBox();

    const onLoadModel = () => {
      this.rootRetries = 0;
      if (this.snapPending) {
        this.snapUntil = Math.min(this.snapUntil + 6000, this.snapStarted + 90000);
        this.tryTerrainSnap();
      }
      if (this.siteClipPts.length >= 3) this.scheduleTilesReady();
    };
    tiles.addEventListener("load-model", onLoadModel);
    this.loadModelUnsub = () => tiles.removeEventListener("load-model", onLoadModel);

    const onLoadError = (event: { error?: Error; url?: string | URL }) => {
      const raw = event.error?.message || String(event.error || "falha a carregar tiles");
      const url = String(event.url ?? "");
      const isRoot = /\/3dtiles\/root\.json/i.test(url) || /Failed to load tileset/i.test(raw);
      const expired = this.sessionAt > 0 && Date.now() - this.sessionAt >= SESSION_TTL_MS;
      console.warn("Google Photorealistic 3D Tiles:", event.url ?? "", event.error);
      if (expired && this._enabled && !this.recreating && this.rootRetries < 1) {
        this.rootRetries += 1;
        void this.rebuildSession();
        return;
      }
      if (isRoot && !this.recreating) {
        this.detach();
        this.opts.onLoadError?.(describeGoogleTilesError(raw));
      }
    };
    tiles.addEventListener("load-error", onLoadError);
    const prevUnsub = this.loadModelUnsub;
    this.loadModelUnsub = () => {
      prevUnsub?.();
      tiles.removeEventListener("load-error", onLoadError);
    };

    if (!hasStoredSiteElevation(this.opts.anchor.altitude)) {
      this.requestTerrainSnap();
    }

    this.sessionAt = Date.now();
    this.rootRetries = 0;
    this.startUpdateLoop();
    this._enabled = true;
  }

  private startUpdateLoop(): void {
    this.updateUnsub?.();
    const renderer = this.world.renderer!.three;
    let lastCamRef: THREE.Camera = (this.world.camera as any).three as THREE.Camera;
    const updateFn = () => {
      if (!this.tiles || !this._enabled) return;
      const c = (this.world.camera as any).three as THREE.Camera;
      c.updateMatrixWorld();
      const persp = (this.world.camera as OBC.OrthoPerspectiveCamera).threePersp;
      if (persp && persp.far < 1e6) {
        persp.far = 1e7;
        persp.near = Math.min(persp.near, 0.05);
        persp.updateProjectionMatrix();
      }
      if (c !== lastCamRef) {
        for (const oldCam of [...this.tiles.cameras]) this.tiles.deleteCamera(oldCam);
        this.tiles.setCamera(c);
        lastCamRef = c;
        this.lastCamPos.copy(c.position);
        this.lastCamQuat.copy(c.quaternion);
      }
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      if (w !== this.lastResW || h !== this.lastResH) {
        this.lastResW = w;
        this.lastResH = h;
        this.tiles.setResolution(c, w, h);
      }
      this.updateAdaptiveError(c, performance.now());
      this.tiles.update();
      if (this.snapPending) this.tryTerrainSnap();
    };
    this.world.renderer!.onBeforeUpdate.add(updateFn);
    this.updateUnsub = () => this.world.renderer!.onBeforeUpdate.remove(updateFn);
  }

  private applyTileMemoryBudget(): void {
    if (!this.tiles) return;
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    const base = deviceMemory <= 4 ? 0.28 : deviceMemory <= 8 ? 0.42 : 0.55;
    const reserved = Math.min(0.34, this.ifcModelCount * 0.065);
    const maxGib = Math.max(0.16, base - reserved);
    this.tiles.lruCache.maxBytesSize = maxGib * GIB;
    this.tiles.lruCache.minBytesSize = Math.max(0.1, maxGib * 0.58) * GIB;
  }

  private scheduleTilesReady(): void {
    if (this.tilesReadyTimer) return;
    this.tilesReadyTimer = window.setTimeout(() => {
      this.tilesReadyTimer = 0;
      this.opts.onTilesReady?.();
    }, 900);
  }

  private pause(): void {
    this.updateUnsub?.();
    this.updateUnsub = null;
    this.snapPending = false;
    if (this.tiles) this.tiles.group.visible = false;
    if (this.clipBox) this.clipBox.visible = false;
    this.uninstallSky();
    this.applyRendererBudget(false);
    this._enabled = false;
  }

  private resume(): void {
    if (!this.tiles) return;
    this.tiles.group.visible = true;
    if (this.clipBox) this.clipBox.visible = true;
    this.installSky();
    this.applyRendererBudget(true);
    if (this.siteClipPts.length >= 3) bindSiteClipMaterials(this.tiles.group);
    this.startUpdateLoop();
    this._enabled = true;
  }

  private async rebuildSession(): Promise<void> {
    if (this.recreating) return;
    this.recreating = true;
    const want = this._enabled;
    try {
      this.detach();
      if (want) await this.attach();
    } catch (err) {
      this.opts.onLoadError?.(describeGoogleTilesError((err as Error).message));
    } finally {
      this.recreating = false;
    }
  }

  private detach(): void {
    if (this.tilesReadyTimer) {
      window.clearTimeout(this.tilesReadyTimer);
      this.tilesReadyTimer = 0;
    }
    this.updateUnsub?.();
    this.updateUnsub = null;
    this.loadModelUnsub?.();
    this.loadModelUnsub = null;
    this.snapPending = false;
    this.sessionAt = 0;

    if (this.tiles) {
      this.world.scene.three.remove(this.tiles.group);
      this.tiles.dispose();
      this.tiles = null;
    }
    if (this.clipBox) {
      this.world.scene.three.remove(this.clipBox);
      this.clipBox.geometry.dispose();
      (this.clipBox.material as THREE.Material).dispose();
      this.clipBox = null;
    }
    this.uninstallSky();
    this.applyRendererBudget(false);
    this.walkQuality = false;
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
    this.tiles.group.updateMatrixWorld(true);

    this.refreshClipBox();
  }

  private finishSnap(ok: boolean): void {
    this.snapPending = false;
    if (ok) this.opts.onTerrainSnap?.(this.opts.anchor.altitude);
    else this.opts.onTerrainSnapFail?.();
  }

  /**
   * SSE adaptativo: mais detalhe quando a câmara está perto (como o Maps ao
   * aproximar). Só sobe o erro após um salto grande de câmara, para não
   * despejar o LOD alto a cada órbita.
   */
  private updateAdaptiveError(camera: THREE.Camera, now: number): void {
    if (!this.tiles) return;
    if (this.snapPending) {
      this.smoothedError = ERROR_SNAP;
      this.tiles.errorTarget = ERROR_SNAP;
      this.sseSettling = true;
      this.lastCamPos.copy(camera.position);
      this.lastCamQuat.copy(camera.quaternion);
      this.lastCamT = now;
      return;
    }

    const dt = Math.max(1 / 120, (now - this.lastCamT) / 1000);
    const jump = camera.position.distanceTo(this.lastCamPos);
    this.lastCamPos.copy(camera.position);
    this.lastCamQuat.copy(camera.quaternion);
    this.lastCamT = now;

    const dist = camera.position.distanceTo(this.clipCenter);
    let rest = ERROR_CITY;
    if (this.walkQuality || dist < 90) rest = ERROR_STREET;
    else if (dist < 280) rest = ERROR_BLOCK;

    const teleported = jump > 80 && jump / dt > 120;
    const target = teleported ? Math.max(rest, ERROR_TELEPORT) : rest;
    const k = target > this.smoothedError ? 6 : 2.2;
    this.smoothedError += (target - this.smoothedError) * Math.min(1, dt * k);
    this.tiles.errorTarget = this.smoothedError;
    this.sseSettling = teleported || Math.abs(this.smoothedError - target) > 0.2;
  }

  private applyRendererBudget(on: boolean): void {
    const gl = this.world.renderer?.three;
    if (!gl) return;
    if (on) {
      this.prevPixelRatio = gl.getPixelRatio();
      this.prevSortObjects = gl.sortObjects;
      const cap = Math.min(window.devicePixelRatio || 1, 1.15);
      if (this.prevPixelRatio > cap) gl.setPixelRatio(cap);
      gl.sortObjects = false;
      return;
    }
    if (this.prevPixelRatio != null) {
      gl.setPixelRatio(this.prevPixelRatio);
      this.prevPixelRatio = null;
    }
    if (this.prevSortObjects != null) {
      gl.sortObjects = this.prevSortObjects;
      this.prevSortObjects = null;
    }
  }

  /**
   * Amostra a malha fotorrealista e coloca o frame ENU à cota do chão
   * (Y=0). Ignora tiles grosseiros do globo (acordes de milhares de metros).
   */
  private tryTerrainSnap(): boolean {
    if (!this.tiles) return false;
    if (performance.now() > this.snapUntil) {
      this.finishSnap(false);
      return false;
    }
    const height = this.sampleTerrainEllipsoidHeight();
    if (height == null) return false;
    if (Math.abs(height - this.opts.anchor.altitude) < 0.2) {
      this.finishSnap(true);
      return true;
    }
    this.opts.anchor = { ...this.opts.anchor, altitude: height };
    this.applyAnchorTransform();
    return false;
  }

  /**
   * Altura elipsoide (m) do chão Google sob o modelo.
   * Descarta intersecções cujo height cartográfico está fora do relevo terrestre
   * — o primeiro LOD do Google é um globo de poucos triângulos, com o “chão”
   * a ~10–20 km abaixo do plano tangente.
   */
  private sampleTerrainEllipsoidHeight(): number | null {
    if (!this.tiles) return null;
    this.tiles.group.updateMatrixWorld(true);
    const cam = (this.world.camera as OBC.OrthoPerspectiveCamera).three;
    this.raycaster.camera = cam;
    this.raycaster.firstHitOnly = true;
    this.raycaster.near = 0;
    this.raycaster.far = 400000;
    const heights: number[] = [];
    const xs = [0, 12, -12, 0, 0];
    const zs = [0, 0, 0, 12, -12];
    const ys = [this.clipCenter.y + 4000, this.clipCenter.y + 30000, 120000];
    for (const y0 of ys) {
      for (let i = 0; i < xs.length; i++) {
        this.rayOrigin.set(this.clipCenter.x + xs[i], y0, this.clipCenter.z + zs[i]);
        this.raycaster.set(this.rayOrigin, this.rayDir);
        const found = this.raycaster.intersectObject(this.tiles.group, true);
        for (const hit of found) {
          if (hit.object === this.clipBox) continue;
          const h = this.hitToEllipsoidHeight(hit.point);
          if (h != null) heights.push(h);
        }
      }
      if (heights.length) break;
    }
    if (heights.length === 0) return null;
    heights.sort((a, b) => a - b);
    return heights[Math.floor(heights.length / 2)];
  }

  private hitToEllipsoidHeight(worldPoint: THREE.Vector3): number | null {
    if (!this.tiles) return null;
    this.ecefHit.copy(worldPoint).applyMatrix4(this.tiles.group.matrixWorldInverse);
    this.tiles.ellipsoid.getPositionToCartographic(this.ecefHit, this.cartHit);
    const h = this.cartHit.height;
    if (!Number.isFinite(h)) return null;
    // Mar Morto ~−430 m; Everest ~8850 m. Fora disto é LOD grosseiro / erro.
    if (h < -500 || h > 9000) return null;
    return h;
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
    this.clipBox.position.copy(this.clipCenter);
    this.clipBox.visible = this._enabled;
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

/**
 * As texturas do Google Photorealistic 3D Tiles já vêm com iluminação baked.
 * MeshStandardMaterial em centenas de tiles mata o FPS; MeshBasicMaterial
 * fica visualmente próximo do Maps e é muito mais barato.
 */
function makeTilesUnlit(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map(toUnlitMaterial);
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
  });
}

function toUnlitMaterial(mat: THREE.Material): THREE.Material {
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial && !(mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    return mat;
  }
  const basic = new THREE.MeshBasicMaterial();
  basic.map = std.map;
  basic.color.copy(std.color);
  basic.vertexColors = std.vertexColors;
  basic.transparent = std.transparent;
  basic.opacity = std.opacity;
  basic.alphaTest = std.alphaTest;
  basic.side = std.side;
  basic.fog = false;
  basic.toneMapped = false;
  std.dispose();
  return basic;
}

const SITE_CLIP_UNIFORMS = {
  enabled: { value: 0 },
  count: { value: 0 },
  yMin: { value: -50 },
  yMax: { value: 80 },
  pts: { value: Array.from({ length: SITE_LIMIT_MAX_POINTS }, () => new THREE.Vector2()) },
};

function bindSiteClipMaterials(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) bindSiteClipMaterial(mat);
  });
}

function bindSiteClipMaterial(mat: THREE.Material): void {
  if (mat.userData.vista4dSiteClip) return;
  mat.userData.vista4dSiteClip = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uSiteClipEnabled = SITE_CLIP_UNIFORMS.enabled;
    shader.uniforms.uSiteClipCount = SITE_CLIP_UNIFORMS.count;
    shader.uniforms.uSiteClipYMin = SITE_CLIP_UNIFORMS.yMin;
    shader.uniforms.uSiteClipYMax = SITE_CLIP_UNIFORMS.yMax;
    shader.uniforms.uSiteClipPts = SITE_CLIP_UNIFORMS.pts;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSiteWorldPos;")
      .replace(
        "#include <fog_vertex>",
        "vSiteWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <fog_vertex>",
      );
    if (!shader.vertexShader.includes("vSiteWorldPos = ")) {
      shader.vertexShader = shader.vertexShader.replace(
        "void main() {",
        "void main() {\n  vSiteWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;",
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uSiteClipEnabled;
uniform int uSiteClipCount;
uniform float uSiteClipYMin;
uniform float uSiteClipYMax;
uniform vec2 uSiteClipPts[${SITE_LIMIT_MAX_POINTS}];
varying vec3 vSiteWorldPos;`,
      )
      .replace(
        "void main() {",
        `void main() {
  if (uSiteClipEnabled > 0.5) {
    vec2 p = vSiteWorldPos.xz;
    bool inside = false;
    for (int i = 0; i < ${SITE_LIMIT_MAX_POINTS}; i++) {
      if (i >= uSiteClipCount) break;
      int j = i == 0 ? uSiteClipCount - 1 : i - 1;
      vec2 a = uSiteClipPts[i];
      vec2 b = uSiteClipPts[j];
      if (((a.y > p.y) != (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / ((b.y - a.y) + 1e-8) + a.x)) {
        inside = !inside;
      }
    }
    if (inside && vSiteWorldPos.y >= uSiteClipYMin && vSiteWorldPos.y <= uSiteClipYMax) discard;
  }
`,
      );
  };
  mat.customProgramCacheKey = () => "vista4d-site-clip";
  mat.needsUpdate = true;
}
