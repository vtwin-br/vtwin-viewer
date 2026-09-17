import { SITE_LIMIT_MAX_POINTS } from "./types";

export interface XzPoint {
  x: number;
  z: number;
}

/** Área com sinal (xz como plano). Positivo = CCW visto de +Y. */
export function signedAreaXZ(pts: XzPoint[]): number {
  if (pts.length < 3) return 0;
  let acc = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j]!;
    const b = pts[i]!;
    acc += a.x * b.z - b.x * a.z;
  }
  return acc / 2;
}

export function polygonAreaAbs(pts: XzPoint[]): number {
  return Math.abs(signedAreaXZ(pts));
}

export function pointInPolygonXZ(p: XzPoint, poly: XzPoint[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const intersect =
      a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z + 1e-12) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function len(x: number, z: number): number {
  return Math.hypot(x, z) || 1;
}

/**
 * Offset no plano XZ. `dist > 0` cresce o polígono (para fora); `dist < 0` encolhe.
 * O sentido corrige-se pela área, para não depender da ordem dos vértices.
 */
export function offsetPolygonXZ(pts: XzPoint[], dist: number): XzPoint[] {
  if (pts.length < 3 || !Number.isFinite(dist) || Math.abs(dist) < 1e-6) {
    return pts.map((p) => ({ ...p }));
  }
  const area0 = polygonAreaAbs(pts);
  const out = offsetOnce(pts, dist);
  const grew = polygonAreaAbs(out) > area0 + 1e-4;
  if (dist > 0 && !grew) return offsetOnce(pts, -dist);
  if (dist < 0 && grew) return offsetOnce(pts, -dist);
  return out;
}

/** Sempre para fora: o anel do talude / o corte da malha Google. */
export function expandPolygonXZ(pts: XzPoint[], dist: number): XzPoint[] {
  return offsetPolygonXZ(pts, Math.max(0, dist));
}

function offsetOnce(pts: XzPoint[], dist: number): XzPoint[] {
  const n = pts.length;
  const sign = signedAreaXZ(pts) >= 0 ? 1 : -1;
  const out: XzPoint[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const e1x = cur.x - prev.x;
    const e1z = cur.z - prev.z;
    const e2x = next.x - cur.x;
    const e2z = next.z - cur.z;
    const l1 = len(e1x, e1z);
    const l2 = len(e2x, e2z);
    const n1x = (e1z / l1) * sign;
    const n1z = (-e1x / l1) * sign;
    const n2x = (e2z / l2) * sign;
    const n2z = (-e2x / l2) * sign;
    let nx = n1x + n2x;
    let nz = n1z + n2z;
    const nl = len(nx, nz);
    nx /= nl;
    nz /= nl;
    const miter = Math.max(0.35, n1x * nx + n1z * nz);
    out.push({
      x: cur.x + (nx * dist) / miter,
      z: cur.z + (nz * dist) / miter,
    });
  }
  return out;
}

export function clampSitePoints<T>(pts: T[]): T[] {
  if (pts.length <= SITE_LIMIT_MAX_POINTS) return pts;
  return pts.slice(0, SITE_LIMIT_MAX_POINTS);
}

export function dropClosingDuplicate<T extends { x: number; y?: number; z: number }>(pts: T[]): T[] {
  if (pts.length < 2) return pts;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const dy = (a.y ?? 0) - (b.y ?? 0);
  if (Math.hypot(a.x - b.x, dy, a.z - b.z) < 1e-4) return pts.slice(0, -1);
  return pts;
}
