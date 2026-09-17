/** ObjectType gravado na IfcAnnotation do limite de canteiro. */
export const VISTA4D_SITE_LIMIT_TYPE = "VISTA4D_SITE_LIMIT";

/** Pset com recorte e platô — a curva vive na representação da IfcAnnotation. */
export const VISTA4D_SITE_LIMIT_PSET = "Pset_Vista4dSiteLimit";

/** Máximo de vértices no shader de recorte dos tiles Google. */
export const SITE_LIMIT_MAX_POINTS = 32;

export interface IfcPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Limite de intervenção do canteiro.
 * Pontos em coordenadas IFC (Z-up), polígono aberto (o fecho grava-se no STEP).
 */
export interface SiteLimit {
  globalId: string;
  name: string;
  points: IfcPoint[];
  /** Metros abaixo da cota do platô a recortar (árvores / relevo). */
  clipBelow: number;
  /** Metros acima da cota do platô a recortar. */
  clipAbove: number;
  /** Largura do talude (m) — anel entre o platô e o corte da malha Google. */
  clipBuffer: number;
  showPlateau: boolean;
  annotationId?: number;
  /** ExpressIDs da ocorrência anterior — comentados no export ao substituir. */
  clusterIds?: number[];
}

export function defaultSiteLimit(points: IfcPoint[], name = "Canteiro"): SiteLimit {
  const zs = points.map((p) => p.z);
  const z = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0;
  return {
    globalId: "",
    name,
    points: points.map((p) => ({ x: p.x, y: p.y, z })),
    clipBelow: 40,
    clipAbove: 80,
    clipBuffer: 1.5,
    showPlateau: true,
  };
}

export function cloneSiteLimit(limit: SiteLimit): SiteLimit {
  return {
    ...limit,
    points: limit.points.map((p) => ({ ...p })),
    clusterIds: limit.clusterIds ? [...limit.clusterIds] : undefined,
  };
}

export function siteLimitElevation(limit: SiteLimit): number {
  if (!limit.points.length) return 0;
  return limit.points.reduce((s, p) => s + p.z, 0) / limit.points.length;
}
