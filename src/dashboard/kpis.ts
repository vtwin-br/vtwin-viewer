import { computeCostProgress, formatMoney } from "../schedule/cost";
import { inclusiveCalendarDays } from "../schedule/range";
import { computeStateBuckets, getTaskState } from "../schedule/simulation";
import type { ScheduleData, Task, TaskState } from "../schedule/types";
import { formatDay, toInputDate } from "../projectPlan/dates";
import { displayTaskName } from "../ui/taskLabels";
import type { BimCatalog } from "../projectPlan/bimCatalog";

export type KpiId =
  | "progress"
  | "executing"
  | "remaining"
  | "cost"
  | "leftover"
  | "unlinked"
  | "calendar"
  | "undated"
  | "link"
  | "model";

export const KPI_ORDER: KpiId[] = [
  "progress",
  "executing",
  "remaining",
  "cost",
  "leftover",
  "unlinked",
  "calendar",
  "undated",
  "link",
  "model",
];

export const KPI_GROUPS: Array<{ id: string; label: string; ids: KpiId[] }> = [
  { id: "plan", label: "Planeamento 4D / 5D", ids: ["progress", "executing", "remaining", "cost", "leftover", "calendar", "undated"] },
  { id: "model", label: "Modelo", ids: ["unlinked", "link", "model"] },
];

export const KPI_LABELS: Record<KpiId, string> = {
  progress: "Avanço 4D",
  executing: "Em execução",
  remaining: "Por iniciar",
  cost: "5D realizado",
  leftover: "5D por realizar",
  unlinked: "Sem vínculo",
  calendar: "Horizonte",
  undated: "Sem datas",
  link: "Ligados ao plano",
  model: "Modelo",
};

export const KPI_DEFAULT_ON: Record<KpiId, boolean> = {
  progress: true,
  executing: true,
  remaining: true,
  cost: true,
  leftover: true,
  unlinked: true,
  calendar: true,
  undated: false,
  link: false,
  model: false,
};

export interface DashboardKpis {
  asOf: Date;
  asOfLabel: string;
  asOfInput: string;
  hasPlan: boolean;
  hasModel: boolean;
  modelCount: number;
  modelLabel: string;
  productCount: number;
  storeyCount: number;
  leaves: number;
  pending: number;
  active: number;
  done: number;
  undated: number;
  progressPct: number;
  costTotal: number;
  costRealized: number;
  costLeft: number;
  costPct: number;
  costLeftPct: number;
  currency: string;
  costLabel: string;
  costLeftLabel: string;
  linkedGuids: number;
  unlinkedCount: number;
  linkPct: number;
  unlinkedPct: number;
  planStart?: Date;
  planEnd?: Date;
  planStartLabel: string;
  planEndLabel: string;
  spanDays: number;
}

export interface DashboardModelHint {
  id: string;
  name: string;
  visible: boolean;
}

export function collectLeaves(schedule: ScheduleData | null | undefined): Task[] {
  if (!schedule?.roots.length) return [];
  const out: Task[] = [];
  const walk = (task: Task) => {
    if (task.isFederationRoot) {
      for (const child of task.children) walk(child);
      return;
    }
    if (task.children.length === 0) {
      out.push(task);
      return;
    }
    for (const child of task.children) walk(child);
  };
  for (const root of schedule.roots) walk(root);
  return out;
}

export function uniqueLinkedGuids(schedule: ScheduleData | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!schedule) return out;
  for (const guids of schedule.productGuidsByTask.values()) {
    for (const guid of guids) out.add(guid);
  }
  for (const group of schedule.groups ?? []) {
    for (const guid of group.productGuids) out.add(guid);
  }
  return out;
}

export function countLeafStatesAll(
  schedule: ScheduleData | null | undefined,
  date: Date,
): { pending: number; active: number; done: number; undated: number; leaves: number } {
  const leaves = collectLeaves(schedule);
  let pending = 0;
  let active = 0;
  let done = 0;
  let undated = 0;
  for (const task of leaves) {
    if (!task.start || !task.end) {
      undated += 1;
      continue;
    }
    const state = getTaskState(task, date);
    if (state === "pending") pending += 1;
    else if (state === "active") active += 1;
    else done += 1;
  }
  return { pending, active, done, undated, leaves: leaves.length };
}

export function computeDashboardKpis(input: {
  schedule: ScheduleData | null;
  date: Date;
  models: DashboardModelHint[];
  productCount: number;
  storeyCount: number;
  catalog?: BimCatalog | null;
}): DashboardKpis {
  const schedule = input.schedule;
  const hasPlan = !!schedule && schedule.roots.length > 0;
  const hasModel = input.models.length > 0;
  const counts = countLeafStatesAll(schedule, input.date);
  const dated = counts.pending + counts.active + counts.done;
  const progressPct = dated > 0 ? Math.round((100 * counts.done) / dated) : 0;
  const currency = schedule?.currency ?? "BRL";
  const cost = schedule ? computeCostProgress(schedule, input.date, false) : { accrued: 0, total: 0 };
  const costLeft = Math.max(0, cost.total - cost.accrued);
  const costPct = cost.total > 0 ? Math.round((100 * cost.accrued) / cost.total) : 0;
  const costLeftPct = cost.total > 0 ? Math.round((100 * costLeft) / cost.total) : 0;
  const linked = uniqueLinkedGuids(schedule);
  const productCount = Math.max(0, input.productCount);
  const catalogGuids = new Set<string>();
  for (const bucket of input.catalog?.buckets ?? []) {
    for (const guid of bucket.guids) catalogGuids.add(guid);
  }
  const universe = catalogGuids.size || productCount;
  let unlinkedCount = 0;
  if (catalogGuids.size) {
    for (const guid of catalogGuids) if (!linked.has(guid)) unlinkedCount += 1;
  } else {
    unlinkedCount = Math.max(0, productCount - linked.size);
  }
  const linkPct = universe > 0 ? Math.round((100 * Math.min(linked.size, universe)) / universe) : 0;
  const unlinkedPct = universe > 0 ? Math.round((100 * unlinkedCount) / universe) : 0;
  const planStart = schedule?.minDate;
  const planEnd = schedule?.maxDate;
  const spanDays = planStart && planEnd ? inclusiveCalendarDays(planStart, planEnd) : 0;
  const visible = input.models.filter((m) => m.visible);
  const modelLabel =
    visible.length === 1 ? visible[0]!.name : visible.length > 1 ? `${visible.length} disciplinas` : "Sem modelo";

  return {
    asOf: input.date,
    asOfLabel: formatDay(input.date),
    asOfInput: toInputDate(input.date),
    hasPlan,
    hasModel,
    modelCount: input.models.length,
    modelLabel,
    productCount,
    storeyCount: input.storeyCount,
    leaves: counts.leaves,
    pending: counts.pending,
    active: counts.active,
    done: counts.done,
    undated: counts.undated,
    progressPct,
    costTotal: cost.total,
    costRealized: cost.accrued,
    costLeft,
    costPct,
    costLeftPct,
    currency,
    costLabel:
      cost.total > 0
        ? `${formatMoney(cost.accrued, currency)} / ${formatMoney(cost.total, currency)}`
        : "Sem custos",
    costLeftLabel: cost.total > 0 ? formatMoney(costLeft, currency) : "Sem custos",
    linkedGuids: linked.size,
    unlinkedCount,
    linkPct,
    unlinkedPct,
    planStart,
    planEnd,
    planStartLabel: planStart ? formatDay(planStart) : "—",
    planEndLabel: planEnd ? formatDay(planEnd) : "—",
    spanDays,
  };
}

export function guidsForKpi(
  id: KpiId,
  ctx: { schedule: ScheduleData | null; date: Date; catalog: BimCatalog | null; allGuids: string[] },
): { guids: string[]; isolate: boolean; label: string } {
  const linked = uniqueLinkedGuids(ctx.schedule);
  const catalogGuids = (ctx.catalog?.buckets ?? []).flatMap((b) => b.guids);
  const all = [...new Set([...ctx.allGuids, ...catalogGuids])];
  if (id === "progress") {
    if (!ctx.schedule) return { guids: [], isolate: false, label: "" };
    return { guids: [...computeStateBuckets(ctx.schedule, ctx.date).done], isolate: true, label: "Elementos concluídos (4D)" };
  }
  if (id === "executing") {
    if (!ctx.schedule) return { guids: [], isolate: false, label: "" };
    return { guids: [...computeStateBuckets(ctx.schedule, ctx.date).active], isolate: true, label: "Elementos em execução" };
  }
  if (id === "remaining") {
    if (!ctx.schedule) return { guids: [], isolate: false, label: "" };
    return { guids: [...computeStateBuckets(ctx.schedule, ctx.date).pending], isolate: true, label: "Elementos por iniciar" };
  }
  if (id === "leftover") {
    if (!ctx.schedule) return { guids: [], isolate: false, label: "" };
    const buckets = computeStateBuckets(ctx.schedule, ctx.date);
    return { guids: [...buckets.pending, ...buckets.active], isolate: true, label: "Elementos ainda não concluídos" };
  }
  if (id === "unlinked") {
    return { guids: all.filter((g) => !linked.has(g)), isolate: true, label: "Elementos sem vínculo ao plano" };
  }
  if (id === "undated") {
    const out = new Set<string>();
    for (const task of collectLeaves(ctx.schedule)) {
      if (task.start && task.end) continue;
      for (const guid of task.productGuids) out.add(guid);
    }
    return { guids: [...out], isolate: true, label: "Tarefas sem datas" };
  }
  if (id === "link") {
    return { guids: all.filter((g) => linked.has(g)), isolate: true, label: "Elementos ligados ao plano" };
  }
  return { guids: [], isolate: false, label: "" };
}

export function compactTaskRows(schedule: ScheduleData | null, date: Date, limit = 70) {
  const leaves = collectLeaves(schedule);
  const dated = leaves.filter((t) => t.start && t.end);
  const rest = leaves.filter((t) => !t.start || !t.end);
  const picked = [...dated, ...rest].slice(0, limit);
  return picked.map((task) => ({
    id: task.id,
    name: displayTaskName(task),
    start: task.start ? formatDay(task.start) : null,
    end: task.end ? formatDay(task.end) : null,
    state: (task.start && task.end ? getTaskState(task, date) : "undated") as TaskState | "undated",
    cost: task.cost ?? 0,
    products: task.productGuids.length,
  }));
}
