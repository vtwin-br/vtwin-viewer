/** ObjectType do IfcBuildingElementProxy plantado no canteiro. */
export const VISTA4D_SITE_ASSET = "VISTA4D_SITE_ASSET";

/** IfcElementQuantity com contagem, comprimento e volume do elemento. */
export const QTO_SITE_ASSET = "Qto_Vista4dSiteAsset";

/**
 * Elemento de canteiro gravado no STEP.
 * Coordenadas em IFC (Z para cima), origem na base, metros.
 * A malha no browser é uma vista do `libraryKey`; o sólido exportado é a caixa.
 */
export interface SiteAsset {
  proxyId: number;
  globalId: string;
  libraryKey: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Rotação em torno do Z do IFC, radianos. */
  yaw: number;
  count: number;
  length: number;
  volume: number;
  clusterIds: number[];
  /** Ainda não foi escrito no STEP. */
  isNew: boolean;
  /** Posição ou rotação mudou desde o último export. */
  dirty: boolean;
}

export function cloneSiteAsset(asset: SiteAsset): SiteAsset {
  return { ...asset, clusterIds: [...asset.clusterIds] };
}
