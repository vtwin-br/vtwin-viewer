import type { BimCatalog } from "../projectPlan/bimCatalog";
import { inferFamilies, storeyKeys } from "../projectPlan/linkHints";
import { collectLeaves, uniqueLinkedGuids } from "./kpis";
import { computeStateBuckets } from "../schedule/simulation";
import type { ScheduleData } from "../schedule/types";

export type PaintFilter = "unlinked" | "linked" | "done" | "active" | "pending" | "not_done" | "undated";

export interface PaintGroup {
  guids: string[];
  color: string;
}

export interface DashPaintPlan {
  isolate: boolean;
  clear: boolean;
  label: string;
  groups: PaintGroup[];
}

export interface PaintContext {
  schedule: ScheduleData | null;
  date: Date;
  catalog: BimCatalog | null;
  allGuids: string[];
}

const COLOR_GREEN = "#16a34a";
const COLOR_RED = "#dc2626";
const COLOR_AMBER = "#d97706";
const COLOR_BLUE = "#0284c7";
const COLOR_MAGENTA = "#c026d3";
const COLOR_SELECT = "#38bdf8";

export function catalogGuidSet(catalog: BimCatalog | null): Set<string> {
  const out = new Set<string>();
  if (!catalog) return out;
  for (const bucket of catalog.buckets) {
    for (const guid of bucket.guids) out.add(guid);
  }
  return out;
}

export function guidsMatchingFilter(filter: PaintFilter, ctx: PaintContext): string[] {
  const linked = uniqueLinkedGuids(ctx.schedule);
  const all = ctx.allGuids.length ? ctx.allGuids : [...catalogGuidSet(ctx.catalog)];
  if (filter === "linked") return all.filter((g) => linked.has(g));
  if (filter === "unlinked") return all.filter((g) => !linked.has(g));
  if (filter === "undated") {
    const out = new Set<string>();
    for (const task of collectLeaves(ctx.schedule)) {
      if (task.start && task.end) continue;
      for (const guid of task.productGuids) out.add(guid);
    }
    return [...out];
  }
  if (!ctx.schedule) return [];
  const buckets = computeStateBuckets(ctx.schedule, ctx.date);
  if (filter === "done") return [...buckets.done];
  if (filter === "active") return [...buckets.active];
  if (filter === "pending") return [...buckets.pending];
  if (filter === "not_done") return [...buckets.pending, ...buckets.active];
  return [];
}

export function resolvePaintPlan(raw: unknown, ctx: PaintContext): DashPaintPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as {
    clear?: unknown;
    isolate?: unknown;
    label?: unknown;
    layers?: unknown;
    heatmap?: unknown;
  };
  if (rec.clear === true) return { isolate: false, clear: true, label: "Modelo completo", groups: [] };
  const layers = Array.isArray(rec.layers) ? rec.layers : rec.heatmap ? [rec] : [];
  const groups: PaintGroup[] = [];
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    groups.push(...groupsFromLayer(layer as Record<string, unknown>, ctx));
  }
  if (!groups.length) return null;
  const painted = groups.reduce((n, g) => n + g.guids.length, 0);
  const universe = ctx.allGuids.length || catalogGuidSet(ctx.catalog).size || painted;
  const isolate = rec.isolate === false ? false : rec.isolate === true ? true : painted < universe * 0.8;
  return {
    isolate,
    clear: false,
    label: String(rec.label || "Destaque no modelo").slice(0, 80),
    groups: mergeGroups(groups),
  };
}

function groupsFromLayer(layer: Record<string, unknown>, ctx: PaintContext): PaintGroup[] {
  let guids = new Set<string>();
  const filter = asFilter(layer.filter);
  if (filter) for (const g of guidsMatchingFilter(filter, ctx)) guids.add(g);
  if (Array.isArray(layer.bucketIds) && ctx.catalog) {
    const wanted = new Set(layer.bucketIds.filter((v): v is string => typeof v === "string"));
    for (const bucket of ctx.catalog.buckets) {
      if (!wanted.has(bucket.id)) continue;
      for (const guid of bucket.guids) guids.add(guid);
    }
  }
  if (Array.isArray(layer.taskIds) && ctx.schedule) {
    for (const raw of layer.taskIds) {
      const id = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(id)) continue;
      for (const guid of ctx.schedule.productGuidsByTask.get(id) ?? []) guids.add(guid);
    }
  }
  const family = typeof layer.family === "string" ? layer.family : "";
  const storey = typeof layer.storey === "string" ? layer.storey : "";
  if (family || storey) {
    const scoped = scopeCatalogGuids(ctx.catalog, family, storey);
    if (guids.size) guids = new Set([...guids].filter((g) => scoped.has(g)));
    else guids = scoped;
  }
  if (!guids.size) return [];
  const heatmap = layer.heatmap === "cost" || layer.heatmap === true;
  if (heatmap) {
    return costHeatmap([...guids], ctx, parseColor(layer.from, COLOR_GREEN), parseColor(layer.to, COLOR_RED));
  }
  return [{ guids: [...guids], color: parseColor(layer.color, defaultColor(filter)) }];
}

function scopeCatalogGuids(catalog: BimCatalog | null, family: string, storey: string): Set<string> {
  const out = new Set<string>();
  if (!catalog) return out;
  const families = family ? new Set(family.toUpperCase().startsWith("IFC") ? [family.toUpperCase()] : inferFamilies(family)) : null;
  if (family && families && !families.size) families.add(family.toUpperCase());
  const keys = storey ? storeyKeys(storey) : [];
  for (const bucket of catalog.buckets) {
    if (families && !families.has(bucket.family) && !bucket.family.includes(family.toUpperCase())) continue;
    if (keys.length && !bucket.storeyKeys.some((k) => keys.includes(k)) && !(bucket.storey && fold(bucket.storey).includes(fold(storey)))) {
      continue;
    }
    for (const guid of bucket.guids) out.add(guid);
  }
  return out;
}

function costHeatmap(guids: string[], ctx: PaintContext, from: string, to: string): PaintGroup[] {
  const costByGuid = costMap(ctx.schedule);
  const values = guids.map((g) => costByGuid.get(g) ?? 0);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const buckets = new Map<string, string[]>();
  for (let i = 0; i < guids.length; i++) {
    const t = (values[i]! - min) / span;
    const color = lerpHex(from, to, t);
    const list = buckets.get(color) ?? [];
    list.push(guids[i]!);
    buckets.set(color, list);
  }
  return [...buckets.entries()].map(([color, ids]) => ({ color, guids: ids }));
}

function costMap(schedule: ScheduleData | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!schedule) return out;
  for (const task of collectLeaves(schedule)) {
    const cost = task.cost ?? 0;
    if (!cost) continue;
    for (const guid of task.productGuids) {
      const prev = out.get(guid) ?? 0;
      if (cost > prev) out.set(guid, cost);
    }
  }
  return out;
}

function mergeGroups(groups: PaintGroup[]): PaintGroup[] {
  const byColor = new Map<string, Set<string>>();
  for (const group of groups) {
    const set = byColor.get(group.color) ?? new Set<string>();
    for (const guid of group.guids) set.add(guid);
    byColor.set(group.color, set);
  }
  return [...byColor.entries()].map(([color, guids]) => ({ color, guids: [...guids] }));
}

function asFilter(raw: unknown): PaintFilter | null {
  const v = String(raw || "").trim();
  if (
    v === "unlinked" ||
    v === "linked" ||
    v === "done" ||
    v === "active" ||
    v === "pending" ||
    v === "not_done" ||
    v === "undated"
  ) {
    return v;
  }
  return null;
}

function defaultColor(filter: PaintFilter | null): string {
  if (filter === "done") return COLOR_GREEN;
  if (filter === "not_done" || filter === "pending") return COLOR_RED;
  if (filter === "active") return COLOR_AMBER;
  if (filter === "unlinked") return COLOR_MAGENTA;
  if (filter === "undated") return COLOR_BLUE;
  return COLOR_SELECT;
}

function parseColor(raw: unknown, fallback: string): string {
  const v = String(raw || "").trim();
  const named: Record<string, string> = {
    green: COLOR_GREEN,
    vermelho: COLOR_RED,
    red: COLOR_RED,
    amber: COLOR_AMBER,
    yellow: COLOR_AMBER,
    blue: COLOR_BLUE,
    magenta: COLOR_MAGENTA,
    cyan: COLOR_SELECT,
  };
  if (named[v.toLowerCase()]) return named[v.toLowerCase()]!;
  if (/^#([0-9a-f]{6})$/i.test(v)) return v.toLowerCase();
  return fallback;
}

function lerpHex(a: string, b: string, t: number): string {
  const u = Math.max(0, Math.min(1, t));
  const pa = hexRgb(a);
  const pb = hexRgb(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * u);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * u);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * u);
  return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
