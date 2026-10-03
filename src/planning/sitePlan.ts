import { encodeIfcRef } from "../ifc/modelSet";
import { excavationVolume } from "./polygon";
import { LEAF_BY_GUID_CACHE, TASK_IDS_BY_GUID } from "../schedule/range";
import type { ScheduleData, Task } from "../schedule/types";

/** Ficheiro `planning/site.json` dentro do `.vtwin`. */
export const SITE_PLAN_FORMAT = "vtwin-site-plan";
export const SITE_PLAN_VERSION = 1;
export const SITE_PLAN_PATH = "planning/site.json";

/** Slot da vista que não corresponde a nenhum IFC. */
const PLANNING_SLOT = 900;

export const DEFAULT_MAST_HEIGHT = 18;
export const DEFAULT_JIB_LENGTH = 12;
export const DEFAULT_COUNTER_JIB = 6;
export const DEFAULT_SWING = 270;
export const DEFAULT_TERRAIN_DEPTH = 1.5;
export const DEFAULT_TERRAIN_SLOPE = 45;
export const DEFAULT_FENCE_LENGTH = 12;
export const DEFAULT_FENCE_PANELS = 4;
export const DEFAULT_DRILL_DEPTH = 6;
export const DEFAULT_TRIP_SECONDS = 20;

export interface PlanPoint {
  x: number;
  y: number;
  z: number;
}

export interface PlanCrane {
  id: string;
  /** Slot do catálogo. O GLB em `public/models/` é só o visual. */
  catalogId?: string;
  modelId?: string;
  x: number;
  y: number;
  z: number;
  /** Radianos em torno do Z do IFC. Igual a `rz`. */
  yaw: number;
  /** Radianos nos eixos X, Y e Z do IFC. */
  rx?: number;
  ry?: number;
  rz?: number;
  mastHeight: number;
  jibLength: number;
  /** Metros de cabo abaixo do carro. A malha do cabo não se grava. */
  hook?: number;
  /** Contra-lança, metros. A malha é só vista. */
  counterJib?: number;
  /** Zona de giro, graus. A malha é só vista. */
  swing?: number;
  /** Cor de vista. Fica no pacote, não no IFC. */
  color?: string;
  lineId?: string;
}

export interface PlanTruck {
  id: string;
  /** Slot do catálogo. O GLB em `public/models/` é só o visual. */
  catalogId?: string;
  modelId?: string;
  x: number;
  y: number;
  z: number;
  /** Radianos em torno do Z do IFC. Igual a `rz`. */
  yaw: number;
  rx?: number;
  ry?: number;
  rz?: number;
  /** Caminho que o camião percorre. A posição intermédia fica nos keyframes. */
  pathId?: string;
  /** Segundos para percorrer o caminho durante a reprodução. */
  duration?: number;
  color?: string;
  lineId?: string;
}

export interface PlanPath {
  id: string;
  modelId?: string;
  points: PlanPoint[];
  color?: string;
  lineId?: string;
}

export interface PlanTerrain {
  id: string;
  modelId?: string;
  contour: PlanPoint[];
  operation: "cut" | "fill";
  /** Metros. */
  depth: number;
  /** Graus a partir da horizontal. */
  slope: number;
  /** Perímetro fechado. Enquanto se desenha, ainda é o mesmo polígono. */
  closed?: boolean;
  /** Cor do corpo (corte ou aterro). */
  color?: string;
  /** Cor do talude. */
  slopeColor?: string;
  /** Zona: só roda em Z. */
  rz?: number;
  lineId?: string;
}

export interface PlanFence {
  id: string;
  modelId?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  rz?: number;
  /** Comprimento total, metros. */
  length: number;
  /** Quantidade de painéis. */
  panels: number;
  color?: string;
  lineId?: string;
}

export interface PlanDrill {
  id: string;
  modelId?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  rx?: number;
  ry?: number;
  rz?: number;
  /** Profundidade da perfuração, metros. */
  depth: number;
  color?: string;
  lineId?: string;
}

export interface PlanMass {
  id: string;
  modelId?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  rx?: number;
  ry?: number;
  rz?: number;
  width: number;
  depth: number;
  height: number;
  color?: string;
  /** Cresce na vertical ao longo da linha (concretagem). */
  grow?: boolean;
  /** Trechos ao longo do comprimento. */
  sections?: number;
  lineId?: string;
}

export interface PlanNote {
  id: string;
  modelId?: string;
  x: number;
  y: number;
  z: number;
  text: string;
  color?: string;
  lineId?: string;
}

export interface PlanLine {
  id: string;
  name: string;
  /** `YYYY-MM-DD`. */
  start: string;
  end: string;
  origin: "planning";
}

export interface SitePlan {
  format: typeof SITE_PLAN_FORMAT;
  version: typeof SITE_PLAN_VERSION;
  cranes: PlanCrane[];
  trucks: PlanTruck[];
  paths: PlanPath[];
  terrains: PlanTerrain[];
  fences: PlanFence[];
  drills: PlanDrill[];
  masses: PlanMass[];
  notes: PlanNote[];
  lines: PlanLine[];
}

export interface PlanMeasure {
  id: string;
  name: string;
  measure: string;
}

export interface LegacySiteAsset {
  globalId: string;
  libraryKey: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export function emptySitePlan(): SitePlan {
  return {
    format: SITE_PLAN_FORMAT,
    version: SITE_PLAN_VERSION,
    cranes: [],
    trucks: [],
    paths: [],
    terrains: [],
    fences: [],
    drills: [],
    masses: [],
    notes: [],
    lines: [],
  };
}

export function newPlanId(): string {
  return crypto.randomUUID();
}

export function poseOf(item: { yaw: number; rx?: number; ry?: number; rz?: number }): { rx: number; ry: number; rz: number } {
  return {
    rx: Number.isFinite(item.rx) ? Number(item.rx) : 0,
    ry: Number.isFinite(item.ry) ? Number(item.ry) : 0,
    rz: Number.isFinite(item.rz) ? Number(item.rz) : item.yaw,
  };
}

export function readPlanColor(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
}

export function cloneSitePlan(plan: SitePlan): SitePlan {
  return {
    format: SITE_PLAN_FORMAT,
    version: SITE_PLAN_VERSION,
    cranes: plan.cranes.map((item) => ({ ...item })),
    trucks: plan.trucks.map((item) => ({ ...item })),
    paths: plan.paths.map((item) => ({ ...item, points: item.points.map((point) => ({ ...point })) })),
    terrains: plan.terrains.map((item) => ({ ...item, contour: item.contour.map((point) => ({ ...point })) })),
    fences: plan.fences.map((item) => ({ ...item })),
    drills: plan.drills.map((item) => ({ ...item })),
    masses: plan.masses.map((item) => ({ ...item })),
    notes: plan.notes.map((item) => ({ ...item })),
    lines: plan.lines.map((item) => ({ ...item })),
  };
}

export function sitePlanToJson(plan: SitePlan): SitePlan {
  return cloneSitePlan(plan);
}

export function parseSitePlan(raw: unknown): SitePlan {
  if (!raw || typeof raw !== "object") throw new Error("planning/site.json está vazio.");
  const j = raw as Partial<SitePlan>;
  if (j.format !== SITE_PLAN_FORMAT) throw new Error("planning/site.json não é um plano de obra vtwin.");
  if (j.version !== SITE_PLAN_VERSION) {
    throw new Error(`Versão de planejamento não suportada (${String(j.version)}).`);
  }
  const plan = emptySitePlan();
  for (const item of asArray(j.cranes)) plan.cranes.push(readCrane(item));
  for (const item of asArray(j.trucks)) plan.trucks.push(readTruck(item));
  for (const item of asArray(j.paths)) plan.paths.push(readPath(item));
  for (const item of asArray(j.terrains)) plan.terrains.push(readTerrain(item));
  for (const item of asArray(j.fences)) plan.fences.push(readFence(item));
  for (const item of asArray(j.drills)) plan.drills.push(readDrill(item));
  for (const item of asArray(j.masses)) plan.masses.push(readMass(item));
  for (const item of asArray(j.notes)) plan.notes.push(readNote(item));
  for (const item of asArray(j.lines)) plan.lines.push(readLine(item));
  return plan;
}

export function planIsEmpty(plan: SitePlan): boolean {
  return (
    !plan.cranes.length &&
    !plan.trucks.length &&
    !plan.paths.length &&
    !plan.terrains.length &&
    !plan.fences.length &&
    !plan.drills.length &&
    !plan.masses.length &&
    !plan.notes.length &&
    !plan.lines.length
  );
}

export function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year || 1970, (month || 1) - 1, day || 1);
}

export function addPlanningLine(plan: SitePlan, name: string, start: Date, end: Date): PlanLine {
  const line: PlanLine = {
    id: newPlanId(),
    name,
    start: isoDate(start),
    end: isoDate(end),
    origin: "planning",
  };
  plan.lines.push(line);
  return line;
}

export function pathLength(path: PlanPath): number {
  let total = 0;
  for (let i = 1; i < path.points.length; i++) total += distance(path.points[i - 1]!, path.points[i]!);
  return total;
}

export function measuresForPhase(
  plan: SitePlan,
  phase: { start?: Date; end?: Date } | null,
): PlanMeasure[] {
  const lines = new Map(plan.lines.map((line) => [line.id, line]));
  const visible = (lineId?: string) => {
    if (!phase?.start || !phase.end) return true;
    if (!lineId) return true;
    const line = lines.get(lineId);
    if (!line) return true;
    const start = parseIsoDate(line.start).getTime();
    const end = parseIsoDate(line.end).getTime();
    return start <= phase.end.getTime() && end >= phase.start.getTime();
  };
  const rows: PlanMeasure[] = [];
  for (const crane of plan.cranes) {
    if (!visible(crane.lineId)) continue;
    rows.push({
      id: crane.id,
      name: "Guindaste",
      measure: `${trimMeasure(crane.mastHeight)} × ${trimMeasure(crane.jibLength)} m`,
    });
  }
  for (const truck of plan.trucks) {
    if (!visible(truck.lineId)) continue;
    rows.push({ id: truck.id, name: "Camião", measure: "" });
  }
  for (const path of plan.paths) {
    if (!visible(path.lineId)) continue;
    rows.push({ id: path.id, name: "Caminho", measure: `${trimMeasure(pathLength(path))} m` });
  }
  for (const terrain of plan.terrains) {
    if (!visible(terrain.lineId)) continue;
    const op = terrain.operation === "cut" ? "corte" : "aterro";
    rows.push({
      id: terrain.id,
      name: "Terreno",
      measure: `${op} ${trimMeasure(cutVolume(terrain))} m³`,
    });
  }
  for (const fence of plan.fences) {
    if (!visible(fence.lineId)) continue;
    rows.push({ id: fence.id, name: "Cerca", measure: `${trimMeasure(fence.length)} m · ${fence.panels}` });
  }
  for (const drill of plan.drills) {
    if (!visible(drill.lineId)) continue;
    rows.push({ id: drill.id, name: "Perfuratriz", measure: `${trimMeasure(drill.depth)} m` });
  }
  for (const mass of plan.masses) {
    if (!visible(mass.lineId)) continue;
    rows.push({
      id: mass.id,
      name: "Volume",
      measure: `${trimMeasure(mass.width)}×${trimMeasure(mass.depth)}×${trimMeasure(mass.height)}`,
    });
  }
  for (const note of plan.notes) {
    if (!visible(note.lineId)) continue;
    rows.push({ id: note.id, name: note.text || "Nota", measure: "" });
  }
  return rows;
}

export function findPlanItem(
  plan: SitePlan,
  id: string,
): { kind: "crane" | "truck" | "path" | "terrain" | "fence" | "drill" | "mass" | "note" } | null {
  if (plan.cranes.some((item) => item.id === id)) return { kind: "crane" };
  if (plan.trucks.some((item) => item.id === id)) return { kind: "truck" };
  if (plan.paths.some((item) => item.id === id)) return { kind: "path" };
  if (plan.terrains.some((item) => item.id === id)) return { kind: "terrain" };
  if (plan.fences.some((item) => item.id === id)) return { kind: "fence" };
  if (plan.drills.some((item) => item.id === id)) return { kind: "drill" };
  if (plan.masses.some((item) => item.id === id)) return { kind: "mass" };
  if (plan.notes.some((item) => item.id === id)) return { kind: "note" };
  return null;
}

export function cutVolume(terrain: PlanTerrain): number {
  return excavationVolume(
    terrain.contour.map((point) => ({ x: point.x, y: point.y })),
    terrain.depth,
    terrain.slope,
  );
}

export function setLineDates(plan: SitePlan, lineId: string | undefined, start: string, end: string): void {
  const line = lineId ? plan.lines.find((item) => item.id === lineId) : undefined;
  if (!line) return;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) line.start = start;
  if (/^\d{4}-\d{2}-\d{2}$/.test(end)) line.end = end;
}

export function removePlanItem(plan: SitePlan, id: string): void {
  const lineIds = new Set<string>();
  const drop = <T extends { id: string; lineId?: string }>(list: T[]) => {
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) return;
    const lineId = list[index]?.lineId;
    if (lineId) lineIds.add(lineId);
    list.splice(index, 1);
  };
  drop(plan.cranes);
  drop(plan.trucks);
  drop(plan.paths);
  drop(plan.terrains);
  drop(plan.fences);
  drop(plan.drills);
  drop(plan.masses);
  drop(plan.notes);
  for (const lineId of lineIds) {
    const used = [
      ...plan.cranes,
      ...plan.trucks,
      ...plan.paths,
      ...plan.terrains,
      ...plan.fences,
      ...plan.drills,
      ...plan.masses,
      ...plan.notes,
    ].some((item) => item.lineId === lineId);
    if (!used) {
      const index = plan.lines.findIndex((line) => line.id === lineId);
      if (index >= 0) plan.lines.splice(index, 1);
    }
  }
}

/** Guindastes antigos do STEP entram no plano uma vez. O export deixa de os escrever. */
export function importLegacyAssets(plan: SitePlan, assets: LegacySiteAsset[]): number {
  const known = new Set([
    ...plan.cranes.map((item) => item.id),
    ...plan.trucks.map((item) => item.id),
    ...plan.notes.map((item) => item.id),
  ]);
  let added = 0;
  for (const asset of assets) {
    if (!asset.globalId || known.has(asset.globalId)) continue;
    known.add(asset.globalId);
    if (asset.libraryKey === "grua") {
      plan.cranes.push({
        id: asset.globalId,
        catalogId: "tower-crane",
        x: asset.x,
        y: asset.y,
        z: asset.z,
        yaw: asset.yaw,
        mastHeight: DEFAULT_MAST_HEIGHT,
        jibLength: DEFAULT_JIB_LENGTH,
      });
    } else if (asset.libraryKey === "camiao") {
      plan.trucks.push({
        id: asset.globalId,
        catalogId: "dump-truck",
        x: asset.x,
        y: asset.y,
        z: asset.z,
        yaw: asset.yaw,
      });
    } else {
      plan.notes.push({
        id: asset.globalId,
        x: asset.x,
        y: asset.y,
        z: asset.z,
        text: asset.name || asset.libraryKey,
      });
    }
    added += 1;
  }
  return added;
}

/** Linhas de planejamento na vista 4D. Não são IfcTask e não voltam ao STEP. */
export function overlaySitePlan(schedule: ScheduleData, plan: SitePlan): ScheduleData {
  if (!plan.lines.length) return schedule;
  const roots = [...schedule.roots];
  const byId = new Map(schedule.byId);
  const productGuidsByTask = new Map(schedule.productGuidsByTask);
  let min = schedule.minDate.getTime();
  let max = schedule.maxDate.getTime();
  let leaves = schedule.leafTaskCount;
  plan.lines.forEach((line, index) => {
    const start = parseIsoDate(line.start);
    const end = parseIsoDate(line.end);
    const id = encodeIfcRef(PLANNING_SLOT, index + 1);
    const guids = itemIdsForLine(plan, line.id);
    const task: Task = {
      id,
      globalId: line.id,
      name: line.name,
      start,
      end,
      children: [],
      productIds: [],
      productGuids: guids,
      groupIds: [],
      predecessors: [],
      isPlanning: true,
    };
    roots.push(task);
    byId.set(id, task);
    productGuidsByTask.set(id, guids);
    min = Math.min(min, start.getTime());
    max = Math.max(max, end.getTime());
    leaves += 1;
  });
  const out: ScheduleData = {
    ...schedule,
    roots,
    byId,
    productGuidsByTask,
    minDate: new Date(min),
    maxDate: new Date(max),
    leafTaskCount: leaves,
  };
  const rec = out as unknown as Record<string, unknown>;
  delete rec[LEAF_BY_GUID_CACHE];
  delete rec[TASK_IDS_BY_GUID];
  return out;
}

export function bytesIncludeMarker(bytes: Uint8Array, marker: string): boolean {
  const needle = new TextEncoder().encode(marker);
  if (!needle.length || bytes.length < needle.length) return false;
  const last = bytes.length - needle.length;
  for (let i = 0; i <= last; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function itemIdsForLine(plan: SitePlan, lineId: string): string[] {
  const ids: string[] = [];
  for (const item of [
    ...plan.cranes,
    ...plan.trucks,
    ...plan.paths,
    ...plan.terrains,
    ...plan.fences,
    ...plan.drills,
    ...plan.masses,
    ...plan.notes,
  ]) {
    if (item.lineId === lineId) ids.push(item.id);
  }
  return ids;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readId(raw: unknown): string {
  if (!raw || typeof raw !== "object" || typeof (raw as { id?: unknown }).id !== "string") {
    throw new Error("Um item de planejamento não tem id.");
  }
  const id = (raw as { id: string }).id.trim();
  if (!id) throw new Error("Um item de planejamento não tem id.");
  return id;
}

function readPoint(raw: unknown, label: string): PlanPoint {
  if (!raw || typeof raw !== "object") throw new Error(`${label} inválido.`);
  const point = raw as Partial<PlanPoint>;
  const x = Number(point.x);
  const y = Number(point.y);
  const z = Number(point.z);
  if (![x, y, z].every(Number.isFinite)) throw new Error(`${label} sem coordenadas.`);
  return { x, y, z };
}

function readCatalogId(raw: { catalogId?: unknown }, fallback: string): string {
  return typeof raw.catalogId === "string" && raw.catalogId.trim() ? raw.catalogId.trim() : fallback;
}

function readModelId(raw: { modelId?: unknown }): string | undefined {
  return typeof raw.modelId === "string" && raw.modelId ? raw.modelId : undefined;
}

function readLineId(raw: { lineId?: unknown }): string | undefined {
  return typeof raw.lineId === "string" && raw.lineId ? raw.lineId : undefined;
}

function readCrane(raw: unknown): PlanCrane {
  const id = readId(raw);
  const item = raw as Partial<PlanCrane>;
  const point = readPoint(item, "Guindaste");
  const yaw = Number(item.yaw);
  const mastHeight = Number(item.mastHeight);
  const jibLength = Number(item.jibLength);
  if (![yaw, mastHeight, jibLength].every(Number.isFinite)) throw new Error("Guindaste sem rotação, mastro ou lança.");
  const pose = poseOf({ yaw, rx: numberOrUndefined(item.rx), ry: numberOrUndefined(item.ry), rz: numberOrUndefined(item.rz) });
  const hook = Number(item.hook);
  return {
    id,
    catalogId: readCatalogId(item, "tower-crane"),
    ...point,
    yaw: pose.rz,
    rx: pose.rx,
    ry: pose.ry,
    rz: pose.rz,
    mastHeight,
    jibLength,
    hook: Number.isFinite(hook) ? hook : 4,
    counterJib: finitePositive(item.counterJib, DEFAULT_COUNTER_JIB),
    swing: clampDegrees(item.swing, DEFAULT_SWING),
    color: readPlanColor(item.color),
    modelId: readModelId(item),
    lineId: readLineId(item),
  };
}

function readTruck(raw: unknown): PlanTruck {
  const id = readId(raw);
  const item = raw as Partial<PlanTruck>;
  const point = readPoint(item, "Camião");
  const yaw = Number(item.yaw);
  if (!Number.isFinite(yaw)) throw new Error("Camião sem rotação.");
  const pose = poseOf({ yaw, rx: numberOrUndefined(item.rx), ry: numberOrUndefined(item.ry), rz: numberOrUndefined(item.rz) });
  return {
    id,
    catalogId: readCatalogId(item, "dump-truck"),
    ...point,
    yaw: pose.rz,
    rx: pose.rx,
    ry: pose.ry,
    rz: pose.rz,
    pathId: typeof item.pathId === "string" && item.pathId ? item.pathId : undefined,
    duration: finitePositive(item.duration, DEFAULT_TRIP_SECONDS),
    color: readPlanColor(item.color),
    modelId: readModelId(item),
    lineId: readLineId(item),
  };
}

function readPath(raw: unknown): PlanPath {
  const id = readId(raw);
  const item = raw as Partial<PlanPath>;
  if (!Array.isArray(item.points) || !item.points.length) throw new Error("Caminho sem polilinha.");
  return {
    id,
    points: item.points.map((point) => readPoint(point, "Caminho")),
    color: readPlanColor(item.color),
    modelId: readModelId(item),
    lineId: readLineId(item),
  };
}

function readTerrain(raw: unknown): PlanTerrain {
  const id = readId(raw);
  const item = raw as Partial<PlanTerrain>;
  if (!Array.isArray(item.contour) || item.contour.length < 3) throw new Error("Terreno sem contorno.");
  if (item.operation !== "cut" && item.operation !== "fill") throw new Error("Terreno sem corte ou aterro.");
  const depth = Number(item.depth);
  const slope = Number(item.slope);
  if (![depth, slope].every(Number.isFinite)) throw new Error("Terreno sem profundidade ou inclinação.");
  const rz = Number(item.rz);
  return {
    id,
    contour: item.contour.map((point) => readPoint(point, "Terreno")),
    operation: item.operation,
    depth,
    slope,
    closed: item.closed === false ? false : true,
    color: readPlanColor(item.color),
    slopeColor: readPlanColor(item.slopeColor),
    rz: Number.isFinite(rz) ? rz : 0,
    modelId: readModelId(item),
    lineId: readLineId(item),
  };
}

function readFence(raw: unknown): PlanFence {
  const id = readId(raw);
  const item = raw as Partial<PlanFence>;
  const point = readPoint(item, "Cerca");
  const yaw = Number(item.yaw);
  const length = Number(item.length);
  const panels = Number(item.panels);
  if (![yaw, length, panels].every(Number.isFinite)) throw new Error("Cerca sem rotação, comprimento ou painéis.");
  const pose = poseOf({ yaw, rz: numberOrUndefined(item.rz) });
  return {
    id,
    ...point,
    yaw: pose.rz,
    rz: pose.rz,
    length,
    panels: Math.max(1, Math.round(panels)),
    color: readPlanColor(item.color),
    modelId: readModelId(item),
    lineId: readLineId(item),
  };
}

function readDrill(raw: unknown): PlanDrill {
  const id = readId(raw);
  const item = raw as Partial<PlanDrill>;
  const point = readPoint(item, "Perfuratriz");
  const yaw = Number(item.yaw);
  const depth = Number(item.depth);
  if (![yaw, depth].every(Number.isFinite)) throw new Error("Perfuratriz sem rotação ou profundidade.");
  const pose = poseOf({ yaw, rx: numberOrUndefined(item.rx), ry: numberOrUndefined(item.ry), rz: numberOrUndefined(item.rz) });
  return {
    id,
    ...point,
    yaw: pose.rz,
    rx: pose.rx,
    ry: pose.ry,
    rz: pose.rz,
    depth,
    color: readPlanColor(item.color),
    modelId: readModelId(item),
    lineId: readLineId(item),
  };
}

function readMass(raw: unknown): PlanMass {
  const id = readId(raw);
  const item = raw as Partial<PlanMass>;
  const point = readPoint(item, "Volume");
  const yaw = Number(item.yaw);
  const width = Number(item.width);
  const depth = Number(item.depth);
  const height = Number(item.height);
  if (![yaw, width, depth, height].every(Number.isFinite)) throw new Error("Volume sem medidas.");
  const pose = poseOf({ yaw, rx: numberOrUndefined(item.rx), ry: numberOrUndefined(item.ry), rz: numberOrUndefined(item.rz) });
  const sections = Number(item.sections);
  return {
    id,
    ...point,
    yaw: pose.rz,
    rx: pose.rx,
    ry: pose.ry,
    rz: pose.rz,
    width,
    depth,
    height,
    color: readPlanColor(item.color),
    grow: item.grow === true,
    sections: Number.isFinite(sections) ? Math.max(1, Math.round(sections)) : 1,
    modelId: readModelId(item),
    lineId: readLineId(item),
  };
}

function readNote(raw: unknown): PlanNote {
  const id = readId(raw);
  const item = raw as Partial<PlanNote>;
  const point = readPoint(item, "Anotação");
  if (typeof item.text !== "string") throw new Error("Anotação sem texto.");
  return { id, ...point, text: item.text, color: readPlanColor(item.color), modelId: readModelId(item), lineId: readLineId(item) };
}

function numberOrUndefined(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function finitePositive(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampDegrees(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(360, Math.max(10, value));
}

function readLine(raw: unknown): PlanLine {
  const id = readId(raw);
  const item = raw as Partial<PlanLine>;
  if (item.origin !== "planning") throw new Error("A linha extra não está marcada como planejamento.");
  if (typeof item.name !== "string" || !item.name.trim()) throw new Error("Linha de planejamento sem nome.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(item.end ?? "")) {
    throw new Error("Linha de planejamento sem datas.");
  }
  return { id, name: item.name.trim(), start: item.start!, end: item.end!, origin: "planning" };
}

function distance(a: PlanPoint, b: PlanPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function trimMeasure(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
