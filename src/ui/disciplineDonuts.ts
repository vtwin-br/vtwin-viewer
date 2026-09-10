import type { ScheduleData, Task } from "../schedule/types";
import { getTaskState } from "../schedule/simulation";
import { displayTaskName } from "./taskLabels";

/**
 * Tarefa-pai da fase de obra (disciplinas como filhos).
 * Aceita ficheiros Bonsai (código interno na Identification) ou nome "Construction" / "Obra".
 */
function findConstructionPhaseRoot(schedule: ScheduleData): Task | undefined {
  const walk = (t: Task): Task | undefined => {
    const id = t.identification?.trim() ?? "";
    const nm = t.name.trim().toLowerCase();
    if (id === "DCP-3") return t;
    if ((nm === "construction" || nm === "obra") && t.children.length > 0) return t;
    for (const c of t.children) {
      const x = walk(c);
      if (x) return x;
    }
    return undefined;
  };
  for (const r of schedule.roots) {
    const x = walk(r);
    if (x) return x;
  }
  return undefined;
}

export function findDisciplineGroups(schedule: ScheduleData): Task[] {
  const construction = findConstructionPhaseRoot(schedule);
  if (construction != null && construction.children.length > 0) {
    return construction.children;
  }

  const out: Task[] = [];
  const seen = new Set<number>();
  const collectFromObraLike = (t: Task) => {
    const nm = t.name.trim().toLowerCase();
    if ((nm === "construction" || nm === "obra") && t.children.length >= 2) {
      for (const c of t.children) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          out.push(c);
        }
      }
    }
    for (const c of t.children) collectFromObraLike(c);
  };
  for (const r of schedule.roots) collectFromObraLike(r);
  if (out.length > 0) return out;

  const byCode: Task[] = [];
  const collect = (t: Task) => {
    const id = t.identification ?? "";
    if (/^DCP-3\.\d+$/i.test(id)) byCode.push(t);
    for (const c of t.children) collect(c);
  };
  for (const r of schedule.roots) collect(r);
  return byCode;
}

export function countLeafStates(task: Task, currentDate: Date): { pending: number; active: number; done: number } {
  let pending = 0;
  let active = 0;
  let done = 0;

  const visit = (t: Task) => {
    if (t.children.length === 0) {
      const s = getTaskState(t, currentDate);
      if (s === "pending") pending++;
      else if (s === "active") active++;
      else done++;
      return;
    }
    for (const c of t.children) visit(c);
  };
  visit(task);
  return { pending, active, done };
}

/**
 * Atualiza o bloco de progresso por disciplina na data da simulação.
 */
export function renderDisciplineDonuts(
  container: HTMLElement,
  schedule: ScheduleData,
  currentDate: Date,
): void {
  const groups = findDisciplineGroups(schedule);
  container.innerHTML = "";

  if (groups.length === 0) {
    container.classList.add("is-empty");
    const p = document.createElement("p");
    p.className = "discipline-empty-msg";
    p.textContent =
      "Não foi encontrada uma fase de obra com subtarefas por disciplina.";
    container.appendChild(p);
    return;
  }

  container.classList.remove("is-empty");
  const title = document.createElement("div");
  title.className = "discipline-section-title";
  title.textContent = "Disciplinas";
  container.appendChild(title);

  const list = document.createElement("div");
  list.className = "discipline-list";

  for (const disc of groups) {
    const { pending, active, done } = countLeafStates(disc, currentDate);
    const total = pending + active + done;
    const donePct = total > 0 ? Math.round((100 * done) / total) : 0;
    const fullName = displayTaskName(disc);

    const row = document.createElement("div");
    row.className = "disc-row";
    row.title = `${fullName}\nConcluído: ${done} · Em execução: ${active} · Pendente: ${pending}`;

    const head = document.createElement("div");
    head.className = "disc-head";
    const name = document.createElement("span");
    name.className = "disc-name";
    name.textContent = fullName;
    const pctEl = document.createElement("span");
    pctEl.className = "disc-pct";
    pctEl.textContent = `${donePct}%`;
    head.append(name, pctEl);

    const track = document.createElement("div");
    track.className = "disc-track";
    track.setAttribute("role", "img");
    track.setAttribute(
      "aria-label",
      `${fullName}: ${donePct}% concluído`,
    );

    const addSeg = (cls: string, n: number) => {
      if (n <= 0) return;
      const seg = document.createElement("span");
      seg.className = `disc-seg ${cls}`;
      seg.style.flex = String(n);
      track.appendChild(seg);
    };
    if (total === 0) {
      addSeg("disc-seg-pending", 1);
    } else {
      addSeg("disc-seg-done", done);
      addSeg("disc-seg-active", active);
      addSeg("disc-seg-pending", pending);
    }

    row.append(head, track);
    list.appendChild(row);
  }

  container.appendChild(list);
}
