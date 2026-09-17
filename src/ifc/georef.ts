import * as WebIFC from "web-ifc";

/** Origem, orientação e CRS lidos da hierarquia IfcProject → IfcSite. */
export interface IfcGeoref {
  source: "map-conversion" | "ifc-site" | "none";
  projectName?: string;
  siteName?: string;
  siteId?: number;
  /** WGS84, se o IFC tiver IfcSite.RefLatitude/RefLongitude ou CRS projetado conversível. */
  lat?: number;
  lon?: number;
  /** Metros (RefElevation ou IfcMapConversion.OrthogonalHeight). */
  elevation?: number;
  /**
   * Ângulo do norte verdadeiro no plano XY do IFC (radianos).
   * 0 = +Y do IFC aponta para o norte (padrão).
   */
  heading: number;
  crsName?: string;
  contextId?: number;
  trueNorthId?: number;
  mapConversionId?: number;
  mapEastings?: number;
  mapNorthings?: number;
  mapHeight?: number;
  mapXAbs?: number;
  mapXOrd?: number;
  placement?: SitePlacement;
}

export interface SitePlacement {
  placementId?: number;
  axisId?: number;
  locationId?: number;
  axisDirId?: number;
  refDirId?: number;
  location: { x: number; y: number; z: number };
  /** Eixo Z local. Ausente = (0,0,1). */
  axis?: { x: number; y: number; z: number };
  /** Eixo X local. Ausente = (1,0,0). */
  refDirection?: { x: number; y: number; z: number };
}

export interface ModelExtraTransform {
  /** Metros no espaço Three.js (Y-up) aplicado sobre o modelo já carregado. */
  x: number;
  y: number;
  z: number;
  /** Rotação em torno do eixo vertical (radianos). */
  yaw: number;
}

export function emptyExtraTransform(): ModelExtraTransform {
  return { x: 0, y: 0, z: 0, yaw: 0 };
}

export function extraIsIdentity(t: ModelExtraTransform, eps = 1e-6): boolean {
  return Math.abs(t.x) < eps && Math.abs(t.y) < eps && Math.abs(t.z) < eps && Math.abs(t.yaw) < eps;
}

export function applyExtraToObject(
  object: { position: { set(x: number, y: number, z: number): void }; rotation: { set(x: number, y: number, z: number): void } },
  t: ModelExtraTransform,
): void {
  object.position.set(t.x, t.y, t.z);
  object.rotation.set(0, t.yaw, 0);
}

export function extraFromObject(object: {
  position: { x: number; y: number; z: number };
  rotation: { y: number };
}): ModelExtraTransform {
  return { x: object.position.x, y: object.position.y, z: object.position.z, yaw: object.rotation.y };
}

/**
 * Cota gravada em IfcSite.RefElevation / IfcMapConversion.OrthogonalHeight.
 * `0` (e quase-zero) é o default STEP de muitos IFCs e não serve como elipsoide.
 */
export function hasStoredSiteElevation(elevation?: number): boolean {
  return elevation != null && Number.isFinite(elevation) && Math.abs(elevation) >= 0.5;
}

export function extractGeoref(ifcApi: WebIFC.IfcAPI, modelId: number): IfcGeoref {
  const georef: IfcGeoref = { source: "none", heading: 0 };

  const projectIds = idsOfType(ifcApi, modelId, WebIFC.IFCPROJECT);
  if (projectIds[0] != null) {
    const project = ifcApi.GetLine(modelId, projectIds[0]) as any;
    georef.projectName = str(project?.Name) ?? str(project?.LongName);
  }

  const ctx = pickModelContext(ifcApi, modelId);
  if (ctx) {
    georef.contextId = ctx.id;
    const tn = vec(ctx.raw?.TrueNorth);
    if (tn && tn.length >= 2) {
      georef.trueNorthId = ref(ctx.raw?.TrueNorth);
      georef.heading = Math.atan2(tn[0], tn[1]);
    }
  }

  const map = readMapConversion(ifcApi, modelId, ctx?.id);
  if (map) {
    georef.mapConversionId = map.id;
    georef.mapEastings = map.eastings;
    georef.mapNorthings = map.northings;
    georef.mapHeight = map.height;
    georef.mapXAbs = map.xAbs;
    georef.mapXOrd = map.xOrd;
    georef.crsName = map.crsName;
    if (map.xAbs != null && map.xOrd != null) {
      georef.heading = Math.atan2(map.xOrd, map.xAbs);
    }
    if (map.height != null && hasStoredSiteElevation(map.height)) georef.elevation = map.height;
    const ll = projectedToWgs84(map.eastings, map.northings, map.crsName, map.mapZone);
    if (ll) {
      georef.lat = ll.lat;
      georef.lon = ll.lon;
      georef.source = "map-conversion";
    }
  }

  const siteIds = idsOfType(ifcApi, modelId, WebIFC.IFCSITE);
  if (siteIds[0] != null) {
    const site = ifcApi.GetLine(modelId, siteIds[0]) as any;
    georef.siteId = siteIds[0];
    georef.siteName = str(site?.Name) ?? str(site?.LongName);
    const lat = compoundToDecimal(site?.RefLatitude);
    const lon = compoundToDecimal(site?.RefLongitude);
    const elev = num(site?.RefElevation);
    if (lat != null && lon != null) {
      if (georef.source === "none") {
        georef.lat = lat;
        georef.lon = lon;
        georef.source = "ifc-site";
      }
    }
    if (elev != null && !hasStoredSiteElevation(georef.elevation)) georef.elevation = elev;
    georef.placement = readPlacement(ifcApi, modelId, ref(site?.ObjectPlacement));
  }

  return georef;
}

export function georefSourceLabel(g: IfcGeoref): string {
  if (g.source === "map-conversion") {
    return g.crsName ? `IFC · IfcMapConversion (${g.crsName})` : "IFC · IfcMapConversion";
  }
  if (g.source === "ifc-site") {
    return g.siteName ? `IFC · IfcSite “${g.siteName}”` : "IFC · IfcSite";
  }
  return "IFC sem coordenadas geográficas";
}

/** Three.js Y-up (That Open) ← IFC Z-up. */
export function ifcToThreePoint(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: p.x, y: p.z, z: -p.y };
}

/** IFC Z-up ← Three.js Y-up. */
export function threeToIfcPoint(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: p.x, y: -p.z, z: p.y };
}

/** Aplica o extra de sessão (translação Y-up + yaw) sobre um ponto IFC já convertido. */
export function applyExtraToThree(
  ifc: { x: number; y: number; z: number },
  extra: ModelExtraTransform,
): { x: number; y: number; z: number } {
  const p = ifcToThreePoint(ifc);
  const c = Math.cos(extra.yaw);
  const s = Math.sin(extra.yaw);
  return {
    x: p.x * c + p.z * s + extra.x,
    y: p.y + extra.y,
    z: -p.x * s + p.z * c + extra.z,
  };
}

/** Inverso de `applyExtraToThree`. */
export function threeWorldToIfc(
  world: { x: number; y: number; z: number },
  extra: ModelExtraTransform,
): { x: number; y: number; z: number } {
  const dx = world.x - extra.x;
  const dy = world.y - extra.y;
  const dz = world.z - extra.z;
  const c = Math.cos(extra.yaw);
  const s = Math.sin(extra.yaw);
  return threeToIfcPoint({
    x: dx * c - dz * s,
    y: dy,
    z: dx * s + dz * c,
  });
}

/** IFC (Z-up) → mundo Three.js já com o extra do gizmo. */
export function ifcPointToWorld(
  p: { x: number; y: number; z: number },
  extra: ModelExtraTransform,
): { x: number; y: number; z: number } {
  const local = ifcToThreePoint(p);
  const c = Math.cos(extra.yaw);
  const s = Math.sin(extra.yaw);
  return {
    x: c * local.x + s * local.z + extra.x,
    y: local.y + extra.y,
    z: -s * local.x + c * local.z + extra.z,
  };
}

/** Mundo Three.js → IFC (Z-up), invertendo o extra do gizmo. */
export function worldPointToIfc(
  p: { x: number; y: number; z: number },
  extra: ModelExtraTransform,
): { x: number; y: number; z: number } {
  const dx = p.x - extra.x;
  const dy = p.y - extra.y;
  const dz = p.z - extra.z;
  const c = Math.cos(extra.yaw);
  const s = Math.sin(extra.yaw);
  const local = {
    x: c * dx - s * dz,
    y: dy,
    z: s * dx + c * dz,
  };
  return threeToIfcPoint(local);
}

export function rotateIfcZ(
  p: { x: number; y: number; z: number },
  yaw: number,
): { x: number; y: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y, z: p.z };
}

export function composeSitePlacement(
  base: SitePlacement | undefined,
  extra: ModelExtraTransform,
): { location: { x: number; y: number; z: number }; refDirection: { x: number; y: number; z: number } } {
  const t0 = base?.location ?? { x: 0, y: 0, z: 0 };
  const r0 = base?.refDirection ?? { x: 1, y: 0, z: 0 };
  const extraIfc = threeToIfcPoint(extra);
  const location = {
    x: rotateIfcZ(t0, extra.yaw).x + extraIfc.x,
    y: rotateIfcZ(t0, extra.yaw).y + extraIfc.y,
    z: rotateIfcZ(t0, extra.yaw).z + extraIfc.z,
  };
  const refDirection = rotateIfcZ(r0, extra.yaw);
  const len = Math.hypot(refDirection.x, refDirection.y, refDirection.z) || 1;
  return {
    location,
    refDirection: { x: refDirection.x / len, y: refDirection.y / len, z: refDirection.z / len },
  };
}

export function decimalToCompound(deg: number): string {
  const sign = deg < 0 ? -1 : 1;
  let abs = Math.abs(deg);
  const d = Math.floor(abs + 1e-12);
  abs = (abs - d) * 60;
  const m = Math.floor(abs + 1e-12);
  abs = (abs - m) * 60;
  const s = Math.floor(abs + 1e-12);
  const micro = Math.max(0, Math.min(999999, Math.round((abs - s) * 1e6)));
  if (d === 0 && sign < 0) return `(0,${-m},${s},${micro})`;
  return `(${sign < 0 ? -d : d},${m},${s},${micro})`;
}

export function ifcReal(n: number): string {
  if (!Number.isFinite(n)) return "0.";
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s.includes(".") ? s : `${s}.`;
}

function pickModelContext(
  ifcApi: WebIFC.IfcAPI,
  modelId: number,
): { id: number; raw: any } | null {
  const ids = idsOfType(ifcApi, modelId, WebIFC.IFCGEOMETRICREPRESENTATIONCONTEXT);
  let fallback: { id: number; raw: any } | null = null;
  for (const id of ids) {
    const raw = ifcApi.GetLine(modelId, id) as any;
    if (ref(raw?.ParentContext) != null) continue;
    const dim = num(raw?.CoordinateSpaceDimension);
    const type = (str(raw?.ContextType) ?? "").toLowerCase();
    const item = { id, raw };
    if (dim === 3 && (type === "model" || type === "")) return item;
    if (dim === 3 && !fallback) fallback = item;
    if (!fallback) fallback = item;
  }
  return fallback;
}

function readMapConversion(
  ifcApi: WebIFC.IfcAPI,
  modelId: number,
  contextId?: number,
): {
  id: number;
  eastings: number;
  northings: number;
  height?: number;
  xAbs?: number;
  xOrd?: number;
  crsName?: string;
  mapZone?: string;
} | null {
  const ids = idsOfType(ifcApi, modelId, WebIFC.IFCMAPCONVERSION);
  for (const id of ids) {
    const raw = ifcApi.GetLine(modelId, id) as any;
    const source = ref(raw?.SourceCRS);
    if (contextId != null && source != null && source !== contextId) continue;
    const eastings = num(raw?.Eastings);
    const northings = num(raw?.Northings);
    if (eastings == null || northings == null) continue;
    const crsId = ref(raw?.TargetCRS);
    let crsName: string | undefined;
    let mapZone: string | undefined;
    if (crsId != null) {
      try {
        const crs = ifcApi.GetLine(modelId, crsId) as any;
        crsName = str(crs?.Name) ?? str(crs?.Description);
        mapZone = str(crs?.MapZone);
      } catch {
        /* CRS ilegível */
      }
    }
    return {
      id,
      eastings,
      northings,
      height: num(raw?.OrthogonalHeight),
      xAbs: num(raw?.XAxisAbscissa),
      xOrd: num(raw?.XAxisOrdinate),
      crsName,
      mapZone,
    };
  }
  return null;
}

function readPlacement(ifcApi: WebIFC.IfcAPI, modelId: number, placementId?: number): SitePlacement | undefined {
  if (placementId == null) return undefined;
  let locId: number | undefined;
  let axisId: number | undefined;
  let axisDirId: number | undefined;
  let refDirId: number | undefined;
  try {
    const place = ifcApi.GetLine(modelId, placementId) as any;
    axisId = ref(place?.RelativePlacement);
    if (axisId == null) return { placementId, location: { x: 0, y: 0, z: 0 } };
    const axis = ifcApi.GetLine(modelId, axisId) as any;
    locId = ref(axis?.Location);
    axisDirId = ref(axis?.Axis);
    refDirId = ref(axis?.RefDirection);
    const location = readPoint(ifcApi, modelId, locId) ?? { x: 0, y: 0, z: 0 };
    const z = vec(axis?.Axis) ?? (axisDirId != null ? vecFromLine(ifcApi, modelId, axisDirId) : undefined);
    const x = vec(axis?.RefDirection) ?? (refDirId != null ? vecFromLine(ifcApi, modelId, refDirId) : undefined);
    return {
      placementId,
      axisId,
      locationId: locId,
      axisDirId,
      refDirId,
      location,
      axis: z && z.length >= 3 ? { x: z[0], y: z[1], z: z[2] } : undefined,
      refDirection: x && x.length >= 2 ? { x: x[0], y: x[1], z: x[2] ?? 0 } : undefined,
    };
  } catch {
    return { placementId, location: { x: 0, y: 0, z: 0 } };
  }
}

function readPoint(ifcApi: WebIFC.IfcAPI, modelId: number, id?: number): { x: number; y: number; z: number } | undefined {
  if (id == null) return undefined;
  try {
    const pt = ifcApi.GetLine(modelId, id) as any;
    const c = vec(pt?.Coordinates);
    if (!c || c.length < 2) return undefined;
    return { x: c[0], y: c[1], z: c[2] ?? 0 };
  } catch {
    return undefined;
  }
}

function vecFromLine(ifcApi: WebIFC.IfcAPI, modelId: number, id: number): number[] | undefined {
  try {
    const raw = ifcApi.GetLine(modelId, id) as any;
    return vec(raw?.DirectionRatios) ?? vec(raw?.Coordinates);
  } catch {
    return undefined;
  }
}

function projectedToWgs84(
  eastings: number,
  northings: number,
  crsName?: string,
  mapZone?: string,
): { lat: number; lon: number } | null {
  const utm = parseUtm(crsName, mapZone);
  if (!utm) return null;
  return utmToLatLon(eastings, northings, utm.zone, utm.south);
}

function parseUtm(crsName?: string, mapZone?: string): { zone: number; south: boolean } | null {
  const blob = `${crsName ?? ""} ${mapZone ?? ""}`;
  const epsg = blob.match(/EPSG\s*:?\s*(\d+)/i);
  if (epsg) {
    const code = Number(epsg[1]);
    const known = EPSG_UTM[code];
    if (known) return known;
    if (code >= 32601 && code <= 32660) return { zone: code - 32600, south: false };
    if (code >= 32701 && code <= 32760) return { zone: code - 32700, south: true };
    if (code >= 31960 && code <= 31989) {
      // SIRGAS 2000 / UTM: 31960=18N … 31972=18S? Tabela abaixo cobre os do Brasil.
    }
  }
  const zone = blob.match(/UTM[^0-9]*(\d{1,2})\s*([NS])?/i) ?? blob.match(/\b(\d{1,2})\s*([NS])\b/i);
  if (zone) {
    const z = Number(zone[1]);
    if (z >= 1 && z <= 60) {
      const hemi = (zone[2] ?? (/\bsouth\b|\bsul\b/i.test(blob) ? "S" : "N")).toUpperCase();
      return { zone: z, south: hemi === "S" };
    }
  }
  return null;
}

/** EPSG comuns no Brasil (SIRGAS 2000 / WGS84 UTM). */
const EPSG_UTM: Record<number, { zone: number; south: boolean }> = {
  31978: { zone: 18, south: true },
  31979: { zone: 19, south: true },
  31980: { zone: 20, south: true },
  31981: { zone: 21, south: true },
  31982: { zone: 22, south: true },
  31983: { zone: 23, south: true },
  31984: { zone: 24, south: true },
  31985: { zone: 25, south: true },
  31986: { zone: 17, south: false },
  31987: { zone: 18, south: false },
  31988: { zone: 19, south: false },
  31989: { zone: 20, south: false },
};

function utmToLatLon(easting: number, northing: number, zone: number, south: boolean): { lat: number; lon: number } {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const x = easting - 500000;
  const y = south ? northing - 10000000 : northing;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const phi1 =
    mu +
    (3 * e1 / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    (21 * e1 ** 2 / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const sinPhi = Math.sin(phi1);
  const cosPhi = Math.cos(phi1);
  const tanPhi = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const t1 = tanPhi * tanPhi;
  const c1 = (e2 / (1 - e2)) * cosPhi * cosPhi;
  const r1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi * sinPhi, 1.5);
  const d = x / (n1 * k0);
  const lat =
    phi1 -
    ((n1 * tanPhi) / r1) *
      (d * d / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * (e2 / (1 - e2))) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * (e2 / (1 - e2)) - 3 * c1 * c1) * d ** 6) / 720);
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const lon =
    lon0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * (e2 / (1 - e2)) + 24 * t1 * t1) * d ** 5) / 120) /
      cosPhi;
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}

function compoundToDecimal(v: any): number | undefined {
  const parts = vec(v);
  if (!parts?.length) return undefined;
  const d = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const s = parts[2] ?? 0;
  const micro = parts[3] ?? 0;
  const sign = d < 0 || m < 0 || s < 0 || micro < 0 ? -1 : 1;
  return sign * (Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600 + Math.abs(micro) / 3.6e9);
}

function idsOfType(api: WebIFC.IfcAPI, modelId: number, type: number | undefined): number[] {
  if (type == null || !Number.isFinite(type)) return [];
  try {
    const v = api.GetLineIDsWithType(modelId, type);
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    return out;
  } catch {
    return [];
  }
}

function str(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v.value === "string") return v.value;
  return undefined;
}

function num(v: any): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v.value === "number" && Number.isFinite(v.value)) return v.value;
  if (typeof v.value === "string") {
    const n = Number(v.value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function ref(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  if (typeof v.value === "number") return v.value;
  return undefined;
}

function vec(v: any): number[] | undefined {
  if (v == null) return undefined;
  const raw = Array.isArray(v) ? v : Array.isArray(v.value) ? v.value : null;
  if (!raw) {
    if (typeof v.size === "function" && typeof v.get === "function") {
      const out: number[] = [];
      for (let i = 0; i < v.size(); i++) {
        const n = num(v.get(i));
        if (n != null) out.push(n);
      }
      return out.length ? out : undefined;
    }
    return undefined;
  }
  const out = raw.map((x: any) => num(x)).filter((n: number | undefined): n is number => n != null);
  return out.length ? out : undefined;
}
