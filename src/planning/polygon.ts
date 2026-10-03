export interface Plan2 {
  x: number;
  y: number;
}

export function signedArea(pts: Plan2[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** `distance` positivo afasta o anel para fora do polígono. */
export function offsetPolygon(pts: Plan2[], distance: number): Plan2[] {
  if (pts.length < 3 || Math.abs(distance) < 1e-6) return pts.map((p) => ({ x: p.x, y: p.y }));
  const d = signedArea(pts) >= 0 ? -distance : distance;
  const out: Plan2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const e1 = unit(cur.x - prev.x, cur.y - prev.y);
    const e2 = unit(next.x - cur.x, next.y - cur.y);
    const n1 = { x: -e1.y, y: e1.x };
    const n2 = { x: -e2.y, y: e2.x };
    const hit = lineIntersect(
      { x: prev.x + n1.x * d, y: prev.y + n1.y * d },
      { x: cur.x + n1.x * d, y: cur.y + n1.y * d },
      { x: cur.x + n2.x * d, y: cur.y + n2.y * d },
      { x: next.x + n2.x * d, y: next.y + n2.y * d },
    );
    if (hit) out.push(hit);
    else out.push({ x: cur.x + ((n1.x + n2.x) / 2) * d, y: cur.y + ((n1.y + n2.y) / 2) * d });
  }
  return out;
}

export function slopeRun(depth: number, slopeDeg: number): number {
  const slope = Math.min(89, Math.max(5, slopeDeg));
  const rad = (slope * Math.PI) / 180;
  return Math.max(0, depth) / Math.tan(rad);
}

/** Volume do prisma com talude, em m³. O anel de baixo é o contorno. */
export function excavationVolume(contour: Plan2[], depth: number, slopeDeg: number): number {
  if (contour.length < 3 || !(depth > 0)) return 0;
  const inner = Math.abs(signedArea(contour));
  const outer = Math.abs(signedArea(offsetPolygon(contour, slopeRun(depth, slopeDeg))));
  return (depth / 3) * (inner + outer + Math.sqrt(Math.max(0, inner * outer)));
}

function unit(x: number, y: number): Plan2 {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function lineIntersect(a1: Plan2, a2: Plan2, b1: Plan2, b2: Plan2): Plan2 | null {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const den = dax * dby - day * dbx;
  if (Math.abs(den) < 1e-8) return null;
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / den;
  return { x: a1.x + dax * t, y: a1.y + day * t };
}
