import type { ScheduleData, Task } from "./types";

/** Dias de calendário inclusivos (1 de out. → 29 de dez. = 90). */
export function inclusiveCalendarDays(start: Date, end: Date): number {
  const a = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const b = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/** Recalcula o intervalo global e o número de tarefas-folha com datas. */
export function recomputeScheduleRange(schedule: ScheduleData): void {
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  let leafTaskCount = 0;

  const visit = (t: Task) => {
    const isLeaf = t.children.length === 0;
    if (isLeaf && t.start && t.end) {
      leafTaskCount += 1;
      minTime = Math.min(minTime, t.start.getTime());
      maxTime = Math.max(maxTime, t.end.getTime());
    } else if (t.start) {
      minTime = Math.min(minTime, t.start.getTime());
      if (t.end) maxTime = Math.max(maxTime, t.end.getTime());
    }
    for (const c of t.children) visit(c);
  };
  for (const r of schedule.roots) visit(r);

  if (isFinite(minTime) && isFinite(maxTime) && minTime <= maxTime) {
    schedule.minDate = new Date(minTime);
    schedule.maxDate = new Date(maxTime);
  }
  schedule.leafTaskCount = leafTaskCount;
}

/** Cronograma vazio para a UI antes de importar um IFC. */
export function emptySchedule(): ScheduleData {
  const minDate = new Date();
  minDate.setHours(0, 0, 0, 0);
  const maxDate = new Date(minDate);
  maxDate.setDate(maxDate.getDate() + 30);
  return {
    name: "—",
    roots: [],
    byId: new Map(),
    productGuidsByTask: new Map(),
    minDate,
    maxDate,
    leafTaskCount: 0,
    currency: "BRL",
  };
}
