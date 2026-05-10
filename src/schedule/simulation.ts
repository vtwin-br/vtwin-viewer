import type { ScheduleData, Task, TaskState } from "./types";

export interface SimulationStateBuckets {
  /** GUIDs em "nao iniciado" naquela data. */
  pending: Set<string>;
  /** GUIDs em "em execucao" naquela data. */
  active: Set<string>;
  /** GUIDs ja "concluidos". */
  done: Set<string>;
}

/**
 * Para cada GUID de produto associado a alguma task, determina o estado
 * combinado naquela data:
 *
 *   currentDate < min(start)        -> pending
 *   start <= currentDate <= end      -> active
 *   currentDate > max(end)           -> done
 *
 * Se um produto pertence a varias tasks, prevalece nesta ordem:
 * active > pending > done
 * (uma task ainda em execucao "trava" o produto em amarelo).
 */
export function computeStateBuckets(
  schedule: ScheduleData,
  currentDate: Date,
): SimulationStateBuckets {
  const t = currentDate.getTime();

  // Para cada GUID, juntamos as tasks-folha que o referenciam
  // -> leafTasksByGuid eh construido na primeira chamada e cacheado abaixo.
  const leafByGuid = getLeafTasksByGuid(schedule);

  const pending = new Set<string>();
  const active = new Set<string>();
  const done = new Set<string>();

  for (const [guid, tasks] of leafByGuid) {
    let state: TaskState = "done";
    let anyActive = false;
    let anyPending = false;
    let anyDone = false;

    for (const task of tasks) {
      const s = task.start ? task.start.getTime() : undefined;
      const e = task.end ? task.end.getTime() : undefined;
      if (s == null || e == null) {
        // sem tempo: assume sempre concluido (parte estrutural do edificio)
        anyDone = true;
        continue;
      }
      if (t < s) anyPending = true;
      else if (t <= e) anyActive = true;
      else anyDone = true;
    }

    if (anyActive) state = "active";
    else if (anyPending) state = "pending";
    else if (anyDone) state = "done";

    if (state === "active") active.add(guid);
    else if (state === "pending") pending.add(guid);
    else done.add(guid);
  }

  return { pending, active, done };
}

/** Para cada task da arvore, retorna o estado naquela data (usado pela UI da arvore). */
export function getTaskState(task: Task, currentDate: Date): TaskState {
  if (!task.start || !task.end) {
    // Tasks sem tempo: derivam do estado dos filhos (se houver), senao "done"
    if (task.children.length > 0) {
      let anyActive = false;
      let anyPending = false;
      let anyDone = false;
      for (const c of task.children) {
        const s = getTaskState(c, currentDate);
        if (s === "active") anyActive = true;
        else if (s === "pending") anyPending = true;
        else anyDone = true;
      }
      if (anyActive) return "active";
      if (anyPending && anyDone) return "active";
      if (anyPending) return "pending";
      return "done";
    }
    return "done";
  }

  const t = currentDate.getTime();
  const s = task.start.getTime();
  const e = task.end.getTime();
  if (t < s) return "pending";
  if (t <= e) return "active";
  return "done";
}

// ---------------------------------------------------------------------------
// Cache: mapa GUID -> tasks-folha (leaf) que referenciam aquele produto
// ---------------------------------------------------------------------------
const cacheKey = "__leafByGuid__";
function getLeafTasksByGuid(schedule: ScheduleData): Map<string, Task[]> {
  const anySched = schedule as any;
  if (anySched[cacheKey]) return anySched[cacheKey] as Map<string, Task[]>;

  const map = new Map<string, Task[]>();
  const visit = (t: Task) => {
    if (t.children.length === 0) {
      for (const g of t.productGuids) {
        const list = map.get(g);
        if (list) list.push(t);
        else map.set(g, [t]);
      }
    } else {
      for (const c of t.children) visit(c);
    }
  };
  for (const r of schedule.roots) visit(r);

  // Tambem inclui produtos atribuidos diretamente a tasks intermediarias (raro,
  // mas pode acontecer). Se um produto so aparece numa task com filhos, ainda
  // queremos respeitar o tempo daquela task.
  const seen = new Set(map.keys());
  const visitAll = (t: Task) => {
    if (t.children.length > 0) {
      for (const g of t.productGuids) {
        if (!seen.has(g)) {
          map.set(g, [t]);
          seen.add(g);
        }
      }
      for (const c of t.children) visitAll(c);
    }
  };
  for (const r of schedule.roots) visitAll(r);

  anySched[cacheKey] = map;
  return map;
}
