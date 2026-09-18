import * as THREE from "three";
import { applyExtraToThree, type ModelExtraTransform } from "../ifc/georef";
import { expandPolygonXZ, polygonAreaAbs, type XzPoint } from "../logistics/polygon";
import { siteLimitElevation, type SiteLimit } from "../logistics/types";

const PLATEAU = 0xcbb892;
const TALUDE_FOOT = 0x8d7348;
const EDGE = 0x087f72;
const PREVIEW = 0xf59e0b;
const TALUDE_RINGS = 4;
/** Recorte até ao globo de LOD baixo (quilómetros abaixo do plano tangente). */
const CLIP_GLOBE_DEPTH = 1e7;
/** O pé do talude avança uns centímetros sobre a malha, a tapar o corte vertical. */
const TOE_OVERLAP = 0.12;
const TALUDE_MIN = 0.8;
const TALUDE_MAX = 2.5;
const TALUDE_DEFAULT = 1.5;

export type GroundSampler = (x: number, z: number, aroundY: number) => number | null;

export interface SiteOverlayApplyOpts {
  sampleGround?: GroundSampler | null;
  /** O talude só faz sentido com a malha Google visível. */
  earthEnabled?: boolean;
}

/** Largura horizontal do talude: da crista (limite IFC) até ao corte Google. */
export function siteTaludeWidth(limit: SiteLimit): number {
  const raw = Number.isFinite(limit.clipBuffer) ? limit.clipBuffer : TALUDE_DEFAULT;
  if (raw > TALUDE_MAX) return TALUDE_DEFAULT;
  return Math.min(TALUDE_MAX, Math.max(TALUDE_MIN, raw || TALUDE_DEFAULT));
}

/**
 * Platô e contorno do limite de canteiro, no espaço Three.js (Y-up).
 */
export class SiteOverlay {
  readonly group = new THREE.Group();
  private readonly solids = new THREE.Group();
  private plateau: THREE.Mesh | null = null;
  private talude: THREE.Mesh | null = null;
  private edge: THREE.LineLoop | null = null;
  private preview: THREE.Line | null = null;
  private dots: THREE.Points | null = null;
  private plateauMat: THREE.MeshBasicMaterial;
  private taludeMat: THREE.MeshBasicMaterial;
  private edgeMat: THREE.LineBasicMaterial;
  private previewMat: THREE.LineBasicMaterial;
  private dotMat: THREE.PointsMaterial;
  private sampleGround: GroundSampler | null = null;
  private earthEnabled = false;

  constructor(scene: THREE.Object3D) {
    this.group.name = "site-overlay";
    this.solids.name = "site-ground";
    this.group.add(this.solids);
    scene.add(this.group);
    this.plateauMat = new THREE.MeshBasicMaterial({
      color: PLATEAU,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: THREE.DoubleSide,
    });
    this.taludeMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      depthWrite: true,
      depthTest: true,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.edgeMat = new THREE.LineBasicMaterial({ color: EDGE, linewidth: 2 });
    this.previewMat = new THREE.LineBasicMaterial({ color: PREVIEW });
    this.dotMat = new THREE.PointsMaterial({ color: PREVIEW, size: 6, sizeAttenuation: false });
  }

  get plateauMesh(): THREE.Mesh | null {
    return this.plateau;
  }

  /** Platô + talude (colisão / caminhada). */
  get ground(): THREE.Object3D | null {
    return this.plateau || this.talude ? this.solids : null;
  }

  apply(
    limit: SiteLimit | null,
    extra: ModelExtraTransform,
    draft?: THREE.Vector3[],
    opts?: SiteOverlayApplyOpts,
  ): void {
    if (opts) {
      if (opts.sampleGround !== undefined) this.sampleGround = opts.sampleGround;
      if (opts.earthEnabled !== undefined) this.earthEnabled = opts.earthEnabled;
    }
    if (draft?.length) {
      this.setDraft(draft);
      if (!limit) this.clearSolid();
    } else {
      this.clearDraft();
    }
    if (!limit || limit.points.length < 3) {
      if (!draft?.length) this.clearSolid();
      return;
    }
    const world = limit.points.map((p) => applyExtraToThree(p, extra));
    const y = world.reduce((s, p) => s + p.y, 0) / world.length;
    this.setSolid(world, y, limit.showPlateau, siteTaludeWidth(limit));
  }

  areaM2(limit: SiteLimit | null, extra: ModelExtraTransform): number {
    if (!limit || limit.points.length < 3) return 0;
    const xz: XzPoint[] = limit.points.map((p) => {
      const w = applyExtraToThree(p, extra);
      return { x: w.x, z: w.z };
    });
    return polygonAreaAbs(xz);
  }

  /**
   * Corte da malha Google = perímetro exterior (pé do talude), não o limite do platô.
   */
  clipPolygon(limit: SiteLimit | null, extra: ModelExtraTransform): {
    xz: XzPoint[];
    yMin: number;
    yMax: number;
  } | null {
    if (!limit || limit.points.length < 3) return null;
    const world = limit.points.map((p) => applyExtraToThree(p, extra));
    const y = world.reduce((s, p) => s + p.y, 0) / world.length;
    const inner: XzPoint[] = world.map((p) => ({ x: p.x, z: p.z }));
    const span = Math.max(8, limit.clipAbove);
    // A malha Google, no frame ENU, vive perto de Y=0. O platô IFC pode estar
    // dezenas/centenas de metros abaixo (origem interna vs cota de projeto).
    // O prisma tem de cobrir os dois, senão o recorte não fura as árvores.
    return {
      xz: expandPolygonXZ(inner, siteTaludeWidth(limit)),
      yMin: Math.min(y, 0) - CLIP_GLOBE_DEPTH,
      yMax: Math.max(y, 0) + span,
    };
  }

  dispose(): void {
    this.clearSolid();
    this.clearDraft();
    this.plateauMat.dispose();
    this.taludeMat.dispose();
    this.edgeMat.dispose();
    this.previewMat.dispose();
    this.dotMat.dispose();
    this.group.removeFromParent();
  }

  private setSolid(
    world: Array<{ x: number; y: number; z: number }>,
    y: number,
    plateau: boolean,
    width: number,
  ): void {
    this.clearSolid();
    const shape = new THREE.Shape();
    shape.moveTo(world[0]!.x, world[0]!.z);
    for (let i = 1; i < world.length; i++) shape.lineTo(world[i]!.x, world[i]!.z);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    this.plateau = new THREE.Mesh(geo, this.plateauMat);
    let plateauY = y;
    if (this.earthEnabled && plateau) {
      const draped = this.buildTalude(world, y, width);
      if (draped != null && Number.isFinite(draped)) plateauY = draped;
    }
    this.plateau.position.y = plateauY + 0.04;
    this.plateau.renderOrder = 2;
    this.plateau.visible = plateau;
    this.solids.add(this.plateau);
    const pts = world.map((p) => new THREE.Vector3(p.x, plateauY + 0.08, p.z));
    this.edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.edgeMat);
    this.edge.renderOrder = 3;
    this.group.add(this.edge);
  }

  private buildTalude(
    world: Array<{ x: number; y: number; z: number }>,
    y: number,
    width: number,
  ): number | null {
    const inner: XzPoint[] = world.map((p) => ({ x: p.x, z: p.z }));
    const n = inner.length;
    if (n < 3 || width < 0.2) return null;
    const toe = expandPolygonXZ(inner, width + TOE_OVERLAP);
    const sampleAt = expandPolygonXZ(inner, width + TOE_OVERLAP + 0.4);
    const sampled = sampleAt.map((p) => this.sampleGround?.(p.x, p.z, y) ?? null);
    const valid = sampled.filter((v): v is number => v != null && Number.isFinite(v));
    const ground = valid.length ? median(valid) : y;
    // Se a cota IFC não está no mesmo referencial que o Google (ENU ~ Y=0),
    // o platô assenta no terreno amostrado em vez de ficar a dezenas de metros.
    const crestY = valid.length && Math.abs(ground - y) > 8 ? ground : y;
    const outerY = sampled.map((hit) => (hit != null && Number.isFinite(hit) ? hit - 0.08 : ground));

    const top = new THREE.Color(PLATEAU);
    const foot = new THREE.Color(TALUDE_FOOT);
    const rings: Array<Array<{ x: number; y: number; z: number; t: number }>> = [];
    for (let r = 0; r <= TALUDE_RINGS; r++) {
      const u = r / TALUDE_RINGS;
      const ease = u * u * (3 - 2 * u);
      const xz =
        r === 0 ? inner : r === TALUDE_RINGS ? toe : expandPolygonXZ(inner, (width + TOE_OVERLAP) * u);
      rings.push(
        xz.map((p, i) => ({
          x: p.x,
          z: p.z,
          t: ease,
          y: crestY + (outerY[i]! - crestY) * ease + (r === 0 ? 0.03 : 0),
        })),
      );
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    const push = (
      a: { x: number; y: number; z: number; t: number },
      b: { x: number; y: number; z: number; t: number },
      c: { x: number; y: number; z: number; t: number },
    ) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      for (const v of [a, b, c]) {
        color.copy(top).lerp(foot, v.t);
        colors.push(color.r, color.g, color.b);
      }
    };

    for (let r = 0; r < TALUDE_RINGS; r++) {
      const a = rings[r]!;
      const b = rings[r + 1]!;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a0 = a[i]!;
        const a1 = a[j]!;
        const b0 = b[i]!;
        const b1 = b[j]!;
        push(a0, a1, b1);
        push(a0, b1, b0);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.talude = new THREE.Mesh(geo, this.taludeMat);
    this.talude.renderOrder = 1;
    this.solids.add(this.talude);
    return crestY;
  }

  private setDraft(world: THREE.Vector3[]): void {
    this.clearDraft();
    if (world.length === 0) return;
    this.dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(world), this.dotMat);
    this.group.add(this.dots);
    if (world.length < 2) return;
    this.preview = new THREE.Line(new THREE.BufferGeometry().setFromPoints(world), this.previewMat);
    this.group.add(this.preview);
  }

  private clearSolid(): void {
    if (this.plateau) {
      this.plateau.geometry.dispose();
      this.plateau.removeFromParent();
      this.plateau = null;
    }
    if (this.talude) {
      this.talude.geometry.dispose();
      this.talude.removeFromParent();
      this.talude = null;
    }
    if (this.edge) {
      this.edge.geometry.dispose();
      this.edge.removeFromParent();
      this.edge = null;
    }
  }

  private clearDraft(): void {
    if (this.preview) {
      this.preview.geometry.dispose();
      this.preview.removeFromParent();
      this.preview = null;
    }
    if (this.dots) {
      this.dots.geometry.dispose();
      this.dots.removeFromParent();
      this.dots = null;
    }
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export { siteLimitElevation };
