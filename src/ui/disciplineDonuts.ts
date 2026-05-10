import type { ScheduleData, Task } from "../schedule/types";
import { getTaskState } from "../schedule/simulation";
import { displayTaskName, isInternalProjectCode } from "./taskLabels";

/** Cores alinhadas à legenda do painel (pendente / execução / concluído). */
const COL = { pending: "#94a3b8", active: "#d97706", done: "#059669" };

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

function findDisciplineGroups(schedule: ScheduleData): Task[] {
  const construction = findConstructionPhaseRoot(schedule);
  if (construction != null && construction.children.length > 0) {
    return construction.children;
  }

  // Fallback: filhos de tarefa com nome exatamente "Construction" ou "Obra" (evita falso positivo em títulos longos)
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

  // Último recurso: nós com código de fase  *.n (apenas para mapear dados; rótulos vêm do Name)
  const byCode: Task[] = [];
  const collect = (t: Task) => {
    const id = t.identification ?? "";
    if (/^DCP-3\.\d+$/i.test(id)) byCode.push(t);
    for (const c of t.children) collect(c);
  };
  for (const r of schedule.roots) collect(r);
  return byCode;
}

function countLeafStates(task: Task, currentDate: Date): { pending: number; active: number; done: number } {
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

function disciplineCaption(task: Task): string {
  const n = displayTaskName(task);
  return n.length > 24 ? n.slice(0, 22) + "…" : n;
}

function conicBackground(p: number, a: number, d: number): string {
  const t = p + a + d;
  if (t === 0) {
    return `conic-gradient(${COL.pending} 0turn 1turn)`;
  }
  const dTurn = d / t;
  const aTurn = a / t;
  const pTurn = p / t;
  let x = 0;
  const stops: string[] = [];
  if (d > 0) {
    stops.push(`${COL.done} ${x}turn ${(x += dTurn)}turn`);
  }
  if (a > 0) {
    stops.push(`${COL.active} ${x}turn ${(x += aTurn)}turn`);
  }
  if (p > 0) {
    stops.push(`${COL.pending} ${x}turn 1turn`);
  }
  if (stops.length === 0) {
    return `conic-gradient(${COL.pending} 0turn 1turn)`;
  }
  return `conic-gradient(${stops.join(", ")})`;
}

function pct(n: number, total: number): string {
  if (total <= 0) return "0";
  return Math.round((100 * n) / total) + "%";
}

/**
 * Atualiza o bloco de roscas por disciplina na data da simulação.
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
      "Não foi encontrada uma fase de obra com subtarefas por disciplina. Verifique se o IFC tem uma tarefa de obra (ex.: Construction / Obra) com filhos.";
    container.appendChild(p);
    return;
  }

  container.classList.remove("is-empty");
  const title = document.createElement("div");
  title.className = "discipline-section-title";
  title.textContent = "Disciplinas da obra";
  container.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "discipline-donut-grid";

  for (const disc of groups) {
    const { pending, active, done } = countLeafStates(disc, currentDate);
    const total = pending + active + done;

    const card = document.createElement("div");
    card.className = "donut-card";
    const fullName = displayTaskName(disc);
    card.title = `${fullName}\nConcluído: ${done} · Em execução: ${active} · Pendente: ${pending}`;

    const ring = document.createElement("div");
    ring.className = "donut-ring";
    ring.style.background = conicBackground(pending, active, done);

    const hole = document.createElement("div");
    hole.className = "donut-hole";
    const pctEl = document.createElement("span");
    pctEl.className = "donut-pct";
    const donePct = total > 0 ? Math.round((100 * done) / total) : 0;
    pctEl.textContent = `${donePct}%`;
    hole.appendChild(pctEl);
    ring.appendChild(hole);

    const cap = document.createElement("div");
    cap.className = "donut-caption";
    cap.textContent = disciplineCaption(disc);

    const sub = document.createElement("div");
    sub.className = "donut-sub";
    sub.textContent =
      total > 0
        ? `${pct(done, total)} · ${pct(active, total)} · ${pct(pending, total)}`
        : "—";

    card.appendChild(ring);
    card.appendChild(cap);
    card.appendChild(sub);
    grid.appendChild(card);
  }

  container.appendChild(grid);
}
