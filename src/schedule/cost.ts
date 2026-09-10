import type { ScheduleData, Task } from "./types";

export interface CostProgress {
  accrued: number;
  total: number;
}

export interface MonthlyCostRow {
  index: number;
  label: string;
  start: Date;
  planned: number;
  realized: number;
  plannedCumulative: number;
  realizedCumulative: number;
}

export interface CostProjection {
  total: number;
  realized: number;
  months: MonthlyCostRow[];
}

interface CostEntry {
  amount: number;
  start?: Date;
  end?: Date;
}

interface TimeBucket {
  start: Date;
  end: Date;
  label: string;
}

/** Custo próprio da tarefa (IfcCostItem desta linha). */
export function ownCost(task: Task): number {
  return task.cost ?? 0;
}

/** Custo da tarefa + subtarefas (hierarquia de IfcTask, somando IfcCostItem). */
export function treeCost(task: Task): number {
  let n = ownCost(task);
  for (const c of task.children) n += treeCost(c);
  return n;
}

/**
 * 5D na data da simulação.
 * previewAll no início, sem play: orçamento completo.
 * Em simulação, tarefas sem datas não acumulam; as datadas interpolam.
 */
export function computeCostProgress(
  schedule: ScheduleData,
  currentDate: Date,
  previewAll: boolean,
): CostProgress {
  let accrued = 0;
  let total = 0;
  for (const entry of collectCostEntries(schedule)) {
    total += entry.amount;
    accrued += accrueEntry(entry, currentDate, previewAll);
  }
  return { accrued, total };
}

/**
 * Orçamento vs realizado na data, mais o custo planejado/realizado por mês.
 * O realizado segue a linha do tempo (não o preview 4D do modelo completo).
 */
export function computeCostProjection(schedule: ScheduleData, currentDate: Date): CostProjection {
  const entries = collectCostEntries(schedule);
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const realized = entries.reduce((s, e) => s + accrueEntry(e, currentDate, false), 0);
  const buckets = buildTimeBuckets(schedule.minDate, schedule.maxDate);
  const planned = buckets.map(() => 0);
  const earned = buckets.map(() => 0);
  const now = currentDate.getTime();

  for (const entry of entries) {
    if (!entry.start || !entry.end || entry.amount <= 0) continue;
    const t0 = entry.start.getTime();
    const t1 = Math.max(t0 + 1, entry.end.getTime());
    const span = t1 - t0;
    for (let i = 0; i < buckets.length; i++) {
      const b0 = buckets[i].start.getTime();
      const b1 = buckets[i].end.getTime();
      const o0 = Math.max(t0, b0);
      const o1 = Math.min(t1, b1);
      if (o1 <= o0) continue;
      planned[i] += entry.amount * ((o1 - o0) / span);
      const r1 = Math.min(o1, now);
      if (r1 > o0) earned[i] += entry.amount * ((r1 - o0) / span);
    }
  }

  let plannedCum = 0;
  let realizedCum = 0;
  const months: MonthlyCostRow[] = buckets.map((b, i) => {
    plannedCum += planned[i];
    realizedCum += earned[i];
    return {
      index: i + 1,
      label: b.label,
      start: b.start,
      planned: planned[i],
      realized: earned[i],
      plannedCumulative: plannedCum,
      realizedCumulative: realizedCum,
    };
  });

  return { total, realized, months };
}

export function formatMoney(amount: number, currency = "BRL"): string {
  const code = /^[A-Z]{3}$/i.test(currency) ? currency.toUpperCase() : "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: code }).format(amount);
  } catch {
    return amount.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

export function formatMoneyShort(amount: number, currency = "BRL"): string {
  const code = /^[A-Z]{3}$/i.test(currency) ? currency.toUpperCase() : "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: code,
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 1,
    }).format(amount);
  } catch {
    return formatMoney(amount, currency);
  }
}

function collectCostEntries(schedule: ScheduleData): CostEntry[] {
  const seenItems = new Set<number>();
  const entries: CostEntry[] = [];
  const visit = (task: Task) => {
    for (const c of task.children) visit(c);
    const amount = ownCost(task);
    if (amount === 0) return;
    if (task.costItemId != null) {
      if (seenItems.has(task.costItemId)) return;
      seenItems.add(task.costItemId);
    }
    entries.push({ amount, start: task.start, end: task.end });
  };
  for (const r of schedule.roots) visit(r);
  return entries;
}

function accrueEntry(entry: CostEntry, currentDate: Date, previewAll: boolean): number {
  if (previewAll) return entry.amount;
  if (!entry.start || !entry.end) return 0;
  const t = currentDate.getTime();
  const s = entry.start.getTime();
  const e = entry.end.getTime();
  if (t < s) return 0;
  if (t >= e) return entry.amount;
  const span = Math.max(1, e - s);
  return entry.amount * ((t - s) / span);
}

function buildTimeBuckets(minDate: Date, maxDate: Date): TimeBucket[] {
  const monthCount = monthsBetween(minDate, maxDate);
  if (monthCount > 16) return buildQuarterBuckets(minDate, maxDate);
  const out: TimeBucket[] = [];
  let t = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  const last = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);
  const spanYears = last.getFullYear() !== t.getFullYear();
  while (t <= last && out.length < 24) {
    const end = new Date(t.getFullYear(), t.getMonth() + 1, 1);
    out.push({ start: t, end, label: monthLabel(t, spanYears) });
    t = end;
  }
  return out;
}

function buildQuarterBuckets(minDate: Date, maxDate: Date): TimeBucket[] {
  const out: TimeBucket[] = [];
  const q = Math.floor(minDate.getMonth() / 3) * 3;
  let t = new Date(minDate.getFullYear(), q, 1);
  const last = new Date(maxDate.getFullYear(), Math.floor(maxDate.getMonth() / 3) * 3, 1);
  while (t <= last && out.length < 16) {
    const end = new Date(t.getFullYear(), t.getMonth() + 3, 1);
    const qn = Math.floor(t.getMonth() / 3) + 1;
    out.push({ start: t, end, label: `T${qn}/${String(t.getFullYear()).slice(2)}` });
    t = end;
  }
  return out;
}

function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
}

function monthLabel(d: Date, withYear: boolean): string {
  const m = d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "");
  if (!withYear) return m;
  return `${m}/${String(d.getFullYear()).slice(2)}`;
}
