import { addDays, diffDays, startOfDay } from "../projectPlan/dates";
import type { PlanPredecessor, PlanTask, PredType } from "../projectPlan/types";
import type { SequenceType, Task } from "./types";

export type { SequenceType };

const SEQ_TYPES: SequenceType[] = ["FS", "SS", "FF", "SF"];

export function isSequenceType(raw: string | undefined): raw is SequenceType {
  const s = (raw || "").toUpperCase();
  return s === "FS" || s === "SS" || s === "FF" || s === "SF";
}

export function nextSequenceType(type: SequenceType): SequenceType {
  return SEQ_TYPES[(SEQ_TYPES.indexOf(type) + 1) % SEQ_TYPES.length]!;
}

/** Texto tipo Project: `3FS+2d`, `ECP-1.2 SS-1`. */
export function formatPredecessor(pred: PlanPredecessor, tasks: PlanTask[]): string {
  const target = tasks.find((t) => t.id === pred.id);
  const idx = tasks.findIndex((t) => t.id === pred.id);
  const token = target?.wbs?.trim() || (idx >= 0 ? String(idx + 1) : pred.id);
  const type = pred.type && pred.type !== "FS" ? pred.type : pred.lagDays ? "FS" : "";
  const lag = pred.lagDays ? `${pred.lagDays > 0 ? "+" : ""}${pred.lagDays}d` : "";
  return `${token}${type}${lag}`;
}

export function formatPredecessors(task: PlanTask, tasks: PlanTask[]): string {
  return task.predecessors.map((p) => formatPredecessor(p, tasks)).join("; ");
}

export function parsePredecessorToken(raw: string): { token: string; type: PredType; lagDays: number } | null {
  const p = raw.trim();
  if (!p) return null;
  const m = /^(.*?)(?:\s*(FS|SS|FF|SF))?\s*([+-]\d+(?:\.\d+)?)?(?:\s*d(?:ias?)?)?\s*$/i.exec(p);
  if (!m?.[1]) return null;
  return {
    token: m[1].trim(),
    type: ((m[2] || "FS").toUpperCase() as PredType),
    lagDays: m[3] ? Number(m[3]) : 0,
  };
}

export function parsePredecessorList(raw: string): Array<{ token: string; type: PredType; lagDays: number }> {
  return raw
    .split(/[;,]/)
    .map(parsePredecessorToken)
    .filter((x): x is { token: string; type: PredType; lagDays: number } => !!x);
}

export function resolvePredecessorToken(token: string, tasks: PlanTask[], selfId: string): string | null {
  const t = token.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    const byIndex = tasks[n - 1];
    if (byIndex && byIndex.id !== selfId) return byIndex.id;
  }
  const byWbs = tasks.find((task) => task.wbs?.trim() === t && task.id !== selfId);
  if (byWbs) return byWbs.id;
  const byName = tasks.find((task) => task.name.trim() === t && task.id !== selfId);
  return byName?.id ?? null;
}

export function wouldCreateCycle(
  tasks: Array<{ id: string; predecessors: Array<{ id: string }> }>,
  predId: string,
  succId: string,
): boolean {
  if (predId === succId) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stack = [predId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === succId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const p of node.predecessors) stack.push(p.id);
  }
  return false;
}

export function constraintStart(
  type: SequenceType,
  predStart: Date,
  predEnd: Date,
  lagDays: number,
  durationDays: number,
): Date {
  const lag = lagDays || 0;
  if (type === "SS") return addDays(predStart, lag);
  if (type === "SF") return addDays(addDays(predStart, lag), -durationDays);
  if (type === "FF") return addDays(addDays(predEnd, lag), -durationDays);
  return addDays(predEnd, lag);
}

export function earliestStart(task: PlanTask, byId: Map<string, PlanTask>): Date | undefined {
  let latest: Date | undefined;
  const duration = task.durationDays ?? (task.start && task.end ? diffDays(task.start, task.end) : 0);
  for (const p of task.predecessors) {
    const pred = byId.get(p.id);
    if (!pred?.start) continue;
    const predEnd = pred.end ?? pred.start;
    const start = constraintStart(p.type, pred.start, predEnd, p.lagDays ?? 0, duration);
    if (!latest || start.getTime() > latest.getTime()) latest = start;
  }
  return latest;
}

/**
 * Empurra sucessores para respeitar IfcRelSequence (ASAP só quando a restrição é violada).
 * Devolve os ids cuja data mudou.
 */
export function cascadeDates(tasks: PlanTask[], seedIds?: Iterable<string>): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const changed = new Set<string>();
  const order = topoTasks(tasks);
  const seeds = seedIds ? new Set(seedIds) : null;
  const affected = seeds ? expandSuccessors(tasks, seeds) : null;

  for (const task of order) {
    if (task.isSummary) continue;
    if (affected && !affected.has(task.id) && !(seeds && seeds.has(task.id))) continue;
    const min = earliestStart(task, byId);
    if (!min) continue;
    const current = task.start ? startOfDay(task.start) : undefined;
    if (current && current.getTime() >= min.getTime()) continue;
    applyKeptDuration(task, min);
    changed.add(task.id);
  }

  for (const id of rollupSummaryDates(tasks)) changed.add(id);
  return changed;
}

/** Ajusta início para não violar predecessoras (permite folga positiva). */
export function clampToPredecessors(task: PlanTask, tasks: PlanTask[]): boolean {
  if (!task.start || task.isSummary) return false;
  const min = earliestStart(task, new Map(tasks.map((t) => [t.id, t])));
  if (!min || startOfDay(task.start).getTime() >= min.getTime()) return false;
  applyKeptDuration(task, min);
  return true;
}

export function rollupSummaryDates(tasks: PlanTask[]): Set<string> {
  const changed = new Set<string>();
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i]!;
    if (!task.isSummary) continue;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const level = task.outlineLevel;
    for (let k = i + 1; k < tasks.length; k++) {
      const child = tasks[k]!;
      if (child.outlineLevel <= level) break;
      if (child.start) {
        const t = startOfDay(child.start).getTime();
        min = Math.min(min, t);
        max = Math.max(max, t);
      }
      if (child.end) max = Math.max(max, startOfDay(child.end).getTime());
    }
    if (!Number.isFinite(min)) continue;
    if (!Number.isFinite(max)) max = min;
    const start = new Date(min);
    const end = new Date(max);
    if (task.start?.getTime() !== start.getTime() || task.end?.getTime() !== end.getTime()) {
      task.start = start;
      task.end = end;
      task.durationDays = Math.max(0, diffDays(start, end));
      changed.add(task.id);
    }
  }
  return changed;
}

export function applyKeptDuration(task: PlanTask, start: Date): void {
  const dur =
    task.durationDays ??
    (task.start && task.end ? Math.max(0, diffDays(task.start, task.end)) : 0);
  task.start = startOfDay(start);
  if (task.isMilestone) {
    task.end = task.start;
    task.durationDays = 0;
    return;
  }
  task.durationDays = dur;
  task.end = addDays(task.start, dur);
}

function topoTasks(tasks: PlanTask[]): PlanTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const pending = new Set(tasks.map((t) => t.id));
  const out: PlanTask[] = [];
  const visiting = new Set<string>();

  const visit = (id: string) => {
    if (!pending.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    if (!task) return;
    for (const p of task.predecessors) visit(p.id);
    visiting.delete(id);
    pending.delete(id);
    out.push(task);
  };

  for (const t of tasks) visit(t.id);
  return out;
}

function expandSuccessors(tasks: PlanTask[], seeds: Set<string>): Set<string> {
  const succs = new Map<string, string[]>();
  for (const t of tasks) {
    for (const p of t.predecessors) {
      const list = succs.get(p.id);
      if (list) list.push(t.id);
      else succs.set(p.id, [t.id]);
    }
  }
  const out = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    for (const s of succs.get(id) ?? []) {
      if (out.has(s)) continue;
      out.add(s);
      stack.push(s);
    }
  }
  return out;
}

/** Versão sobre o grafo IfcTask (ids nativos). */
export function cascadeIfcTasks(byId: Map<number, Task>, seedIds?: Iterable<number>): Set<number> {
  const changed = new Set<number>();
  const tasks = [...byId.values()];
  const order = topoIfc(tasks);
  const seeds = seedIds ? new Set(seedIds) : null;
  const affected = seeds ? expandIfcSuccessors(tasks, seeds) : null;

  for (const task of order) {
    if (task.children.length) continue;
    if (affected && !affected.has(task.id) && !(seeds && seeds.has(task.id))) continue;
    const min = earliestIfcStart(task, byId);
    if (!min) continue;
    if (task.start && startOfDay(task.start).getTime() >= min.getTime()) continue;
    const dur =
      task.start && task.end ? Math.max(0, diffDays(task.start, task.end)) : 0;
    task.start = min;
    task.end = task.isMilestone ? min : addDays(min, dur);
    changed.add(task.id);
  }

  rollupIfcSummaries(byId, changed);
  return changed;
}

function earliestIfcStart(task: Task, byId: Map<number, Task>): Date | undefined {
  let latest: Date | undefined;
  const duration = task.start && task.end ? diffDays(task.start, task.end) : 0;
  for (const p of task.predecessors) {
    const pred = byId.get(p.taskId);
    if (!pred?.start) continue;
    const predEnd = pred.end ?? pred.start;
    const start = constraintStart(p.type, pred.start, predEnd, p.lagDays ?? 0, duration);
    if (!latest || start.getTime() > latest.getTime()) latest = start;
  }
  return latest;
}

function topoIfc(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const pending = new Set(tasks.map((t) => t.id));
  const out: Task[] = [];
  const visiting = new Set<number>();
  const visit = (id: number) => {
    if (!pending.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    if (!task) return;
    for (const p of task.predecessors) visit(p.taskId);
    visiting.delete(id);
    pending.delete(id);
    out.push(task);
  };
  for (const t of tasks) visit(t.id);
  return out;
}

function expandIfcSuccessors(tasks: Task[], seeds: Set<number>): Set<number> {
  const succs = new Map<number, number[]>();
  for (const t of tasks) {
    for (const p of t.predecessors) {
      const list = succs.get(p.taskId);
      if (list) list.push(t.id);
      else succs.set(p.taskId, [t.id]);
    }
  }
  const out = new Set<number>();
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    for (const s of succs.get(id) ?? []) {
      if (out.has(s)) continue;
      out.add(s);
      stack.push(s);
    }
  }
  return out;
}

function rollupIfcSummaries(byId: Map<number, Task>, changed: Set<number>): void {
  const visit = (task: Task) => {
    for (const c of task.children) visit(c);
    if (!task.children.length) return;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const c of task.children) {
      if (c.start) min = Math.min(min, startOfDay(c.start).getTime());
      if (c.end) max = Math.max(max, startOfDay(c.end).getTime());
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    const start = new Date(min);
    const end = new Date(max);
    if (task.start?.getTime() !== start.getTime() || task.end?.getTime() !== end.getTime()) {
      task.start = start;
      task.end = end;
      changed.add(task.id);
    }
  };
  for (const t of byId.values()) {
    if (t.parentId == null) visit(t);
  }
}

export function wouldCreateIfcCycle(byId: Map<number, Task>, predId: number, succId: number): boolean {
  if (predId === succId) return true;
  const stack = [predId];
  const seen = new Set<number>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === succId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const p of node.predecessors) stack.push(p.taskId);
  }
  return false;
}
