import type { PlanPoint } from "./sitePlan";

export interface PdfPair {
  drawing: { u: number; v: number };
  model: PlanPoint;
}

export interface PdfFrame {
  origin: PlanPoint;
  yaw: number;
  width: number;
  height: number;
}

/** Dois pares desenho→terreno definem posição, rotação e escala. Não é EPSG. */
export function frameFromPairs(a: PdfPair, b: PdfPair, aspect: number): PdfFrame | null {
  const page = aspect > 0.05 ? aspect : 1;
  const du = (b.drawing.u - a.drawing.u) * page;
  const dv = b.drawing.v - a.drawing.v;
  const dx = b.model.x - a.model.x;
  const dy = b.model.y - a.model.y;
  const lenD = Math.hypot(du, dv);
  const lenM = Math.hypot(dx, dy);
  if (lenD < 1e-4 || lenM < 1e-4) return null;
  const meters = lenM / lenD;
  const yaw = Math.atan2(dy, dx) - Math.atan2(dv, du);
  const lx = a.drawing.u * page;
  const ly = a.drawing.v;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const rx = (lx * c - ly * s) * meters;
  const ry = (lx * s + ly * c) * meters;
  return {
    origin: { x: a.model.x - rx, y: a.model.y - ry, z: a.model.z },
    yaw,
    width: meters * page,
    height: meters,
  };
}
