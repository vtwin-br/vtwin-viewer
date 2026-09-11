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
