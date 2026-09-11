import { addDays, diffDays, recomputePlanRange, startOfDay } from "./dates";
import type { PlanAttachment, PlanTask, ProjectPlan } from "./types";

let seq = 0;

export function uid(prefix = "t"): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function emptyPlan(name = "Novo planejamento"): ProjectPlan {
  const start = startOfDay(new Date());
  const summary: PlanTask = {
    id: uid(),
    name,
    outlineLevel: 1,
    start,
    end: addDays(start, 20),
    durationDays: 20,
    progress: 0,
    isMilestone: false,
    isSummary: true,
    collapsed: false,
    predecessors: [],
    linkedProductGuids: [],
  };
  const child: PlanTask = {
    id: uid(),
    name: "Nova tarefa",
    outlineLevel: 2,
    start,
    end: addDays(start, 5),
    durationDays: 5,
    progress: 0,
    isMilestone: false,
    isSummary: false,
    collapsed: false,
    predecessors: [],
    linkedProductGuids: [],
  };
  return finalizePlan({
    id: uid("plan"),
    name,
    tasks: [summary, child],
    attachments: [],
    sourceKind: "blank",
  });
}

export function finalizePlan(partial: Omit<ProjectPlan, "minDate" | "maxDate"> & Partial<Pick<ProjectPlan, "minDate" | "maxDate">>): ProjectPlan {
  markSummaries(partial.tasks);
  const range = recomputePlanRange(partial.tasks.flatMap((t) => [t.start, t.end]));
  return {
    ...partial,
    minDate: range.minDate,
    maxDate: range.maxDate,
  };
}

export function markSummaries(tasks: PlanTask[]): void {
  for (let i = 0; i < tasks.length; i++) {
    const next = tasks[i + 1];
    tasks[i].isSummary = !!next && next.outlineLevel > tasks[i].outlineLevel;
  }
}

export function applyDuration(task: PlanTask, days: number): void {
  task.durationDays = Math.max(0, days);
  if (task.isMilestone) {
    task.end = task.start;
    task.durationDays = 0;
    return;
  }
  if (task.start) task.end = addDays(task.start, Math.max(0, days));
}

export function applyStart(task: PlanTask, start: Date): void {
  const dur =
    task.durationDays ??
    (task.start && task.end ? Math.max(0, diffDays(task.start, task.end)) : 5);
  task.start = startOfDay(start);
  if (task.isMilestone) {
    task.end = task.start;
    task.durationDays = 0;
    return;
  }
  task.durationDays = dur;
  task.end = addDays(task.start, dur);
}

export function applyEnd(task: PlanTask, end: Date): void {
  task.end = startOfDay(end);
  if (task.start && task.end < task.start) task.start = task.end;
  if (task.start) task.durationDays = Math.max(0, diffDays(task.start, task.end));
}

export function visibleTasks(tasks: PlanTask[]): PlanTask[] {
  const out: PlanTask[] = [];
  let maxVisible = Number.POSITIVE_INFINITY;
  for (const t of tasks) {
    if (t.outlineLevel > maxVisible) continue;
    out.push(t);
    maxVisible = t.collapsed ? t.outlineLevel : Number.POSITIVE_INFINITY;
  }
  return out;
}

export function descendantCount(tasks: PlanTask[], index: number): number {
  const level = tasks[index].outlineLevel;
  let n = 0;
  for (let i = index + 1; i < tasks.length; i++) {
    if (tasks[i].outlineLevel <= level) break;
    n += 1;
  }
  return n;
}

/** Índices das tarefas selecionadas que não são descendentes de outra selecionada. */
export function selectionRootIndices(tasks: PlanTask[], selectedIds: Set<string>): number[] {
  const indices: number[] = [];
  for (let i = 0; i < tasks.length; i++) {
    if (selectedIds.has(tasks[i].id)) indices.push(i);
  }
  return indices.filter((i) => !indices.some((j) => j < i && i <= j + descendantCount(tasks, j)));
}

export function canIndent(tasks: PlanTask[], index: number): boolean {
  if (index <= 0) return false;
  return tasks[index].outlineLevel <= tasks[index - 1].outlineLevel;
}

export function canOutdent(tasks: PlanTask[], index: number): boolean {
  return tasks[index].outlineLevel > 1;
}

/** Rebaixa a seleção (e subtarefas) um nível. Devolve os índices das raízes movidas. */
export function indentTasks(tasks: PlanTask[], selectedIds: Set<string>): number[] {
  const moved: number[] = [];
  for (const i of selectionRootIndices(tasks, selectedIds)) {
    if (!canIndent(tasks, i)) continue;
    const n = descendantCount(tasks, i);
    for (let k = i; k <= i + n; k++) tasks[k].outlineLevel += 1;
    moved.push(i);
  }
  markSummaries(tasks);
  return moved;
}

/** Sobe a seleção (e subtarefas) um nível. Devolve os índices das raízes movidas. */
export function outdentTasks(tasks: PlanTask[], selectedIds: Set<string>): number[] {
  const roots = selectionRootIndices(tasks, selectedIds);
  const moved: number[] = [];
  for (let r = roots.length - 1; r >= 0; r--) {
    const i = roots[r];
    if (!canOutdent(tasks, i)) continue;
    const n = descendantCount(tasks, i);
    for (let k = i; k <= i + n; k++) {
      tasks[k].outlineLevel = Math.max(1, tasks[k].outlineLevel - 1);
    }
    moved.push(i);
  }
  moved.sort((a, b) => a - b);
  markSummaries(tasks);
  return moved;
}

export function outlineParentIndex(tasks: PlanTask[], index: number): number {
  const level = tasks[index].outlineLevel;
  for (let i = index - 1; i >= 0; i--) {
    if (tasks[i].outlineLevel < level) return i;
  }
  return -1;
}

export function outlinePrevSiblingIndex(tasks: PlanTask[], index: number): number {
  const level = tasks[index].outlineLevel;
  for (let i = index - 1; i >= 0; i--) {
    if (tasks[i].outlineLevel < level) return -1;
    if (tasks[i].outlineLevel === level) return i;
  }
  return -1;
}

function wbsPrefix(tasks: PlanTask[]): string {
  for (const t of tasks) {
    const w = t.wbs?.trim();
    if (!w) continue;
    const m = w.match(/^([^\d]+)/);
    if (m?.[1] && m[1].length < w.length) return m[1];
  }
  return "";
}

/** Recalcula Identification / WBS a partir da hierarquia. Devolve id → novo código. */
export function rebuildWbs(tasks: PlanTask[]): Map<string, string> {
  const prefix = wbsPrefix(tasks);
  const stack: number[] = [];
  const changed = new Map<string, string>();
  for (const t of tasks) {
    const level = Math.max(1, Math.floor(t.outlineLevel) || 1);
    t.outlineLevel = level;
    while (stack.length > level) stack.pop();
    while (stack.length < level) stack.push(0);
    stack[level - 1] += 1;
    const next = `${prefix}${stack.join(".")}`;
    if (t.wbs !== next) {
      t.wbs = next;
      changed.set(t.id, next);
    }
  }
  return changed;
}

export function insertTaskAfter(plan: ProjectPlan, afterId: string | null): PlanTask {
  const task: PlanTask = {
    id: uid(),
    name: "Nova tarefa",
    outlineLevel: 1,
    start: startOfDay(plan.minDate),
    end: addDays(startOfDay(plan.minDate), 5),
    durationDays: 5,
    progress: 0,
    isMilestone: false,
    isSummary: false,
    collapsed: false,
    predecessors: [],
    linkedProductGuids: [],
  };
  const idx = afterId ? plan.tasks.findIndex((t) => t.id === afterId) : -1;
  if (idx >= 0) {
    task.outlineLevel = plan.tasks[idx].outlineLevel;
    const n = descendantCount(plan.tasks, idx);
    plan.tasks.splice(idx + 1 + n, 0, task);
  } else {
    const last = plan.tasks[plan.tasks.length - 1];
    if (last) task.outlineLevel = last.outlineLevel;
    plan.tasks.push(task);
  }
  markSummaries(plan.tasks);
  return task;
}

export function removeTask(plan: ProjectPlan, id: string): void {
  const idx = plan.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const n = descendantCount(plan.tasks, idx);
  plan.tasks.splice(idx, 1 + n);
}

export function fileToAttachment(
  file: File,
  kind: PlanAttachment["kind"],
  note?: string,
): PlanAttachment {
  return {
    id: uid("att"),
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    kind,
    addedAt: new Date(),
    note,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
