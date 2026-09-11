import type { ScheduleData, Task } from "../schedule/types";
import { getTaskState } from "../schedule/simulation";
import { formatMoney, treeCost } from "../schedule/cost";
import { displayTaskName, isInternalProjectCode } from "./taskLabels";

const ICON_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export interface TaskTreeOptions {
  container: HTMLElement;
  schedule: ScheduleData;
  onSelect: (task: Task | null) => void;
}

interface TaskNodeRefs {
  root: HTMLElement;
  row: HTMLElement;
  pip: HTMLElement;
  bar: HTMLElement;
  progress: HTMLElement;
  barWrap: HTMLElement;
  nameEl: HTMLElement;
  durationEl: HTMLElement;
  childrenWrap: HTMLElement | null;
  toggle: HTMLElement;
  collapsed: boolean;
}

export class TaskTreeUI {
  private opts: TaskTreeOptions;
  private nodes = new Map<number, TaskNodeRefs>();
  private selectedId: number | null = null;
  private totalRangeMs = 1;
  private startMs = 0;

  constructor(opts: TaskTreeOptions) {
    this.opts = opts;
    this.applySchedule(opts.schedule);
    this.render();
  }

  /** Substitui o cronograma (novo IFC importado) e reconstrói a árvore. */
  setSchedule(schedule: ScheduleData, keepSelection = false): void {
    const keep = keepSelection ? this.selectedId : null;
    if (!keepSelection) {
      this.selectedId = null;
      this.opts.onSelect(null);
    }
    this.applySchedule(schedule);
    this.render();
    if (keep != null && schedule.byId.has(keep)) this.select(keep, false, false);
  }

  /** Seleciona uma tarefa sem alternar (ex.: clique no 3D). `emit: false` só destaca a linha. */
  selectById(taskId: number | null, emit = true): void {
    if (taskId == null) {
      this.clearSelection();
      return;
    }
    this.select(taskId, false, emit);
  }

  private applySchedule(schedule: ScheduleData) {
    this.opts.schedule = schedule;
    this.startMs = schedule.minDate.getTime();
    this.totalRangeMs = Math.max(1, schedule.maxDate.getTime() - this.startMs);
    this.nodes.clear();
  }

  private render() {
    const { container, schedule } = this.opts;
    container.innerHTML = "";
    for (const root of schedule.roots) {
      container.appendChild(this.buildNode(root, 0));
    }
  }

  private buildNode(task: Task, depth: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "task";

    const row = document.createElement("div");
    row.className = "task-row";
    row.setAttribute("role", "treeitem");

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "toggle";
    toggle.tabIndex = -1;
    if (task.children.length === 0) {
      toggle.classList.add("leaf");
    } else {
      toggle.innerHTML = ICON_CHEVRON;
      toggle.setAttribute("aria-label", "Expandir ou recolher");
    }

    const pip = document.createElement("span");
    pip.className = "task-pip";
    pip.dataset.state = "pending";
    pip.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "name";
    this.fillName(name, task);

    const duration = document.createElement("span");
    duration.className = "duration";
    duration.textContent = fmtDuration(task.start, task.end);

    row.append(toggle, pip, name, duration);

    const barWrap = document.createElement("div");
    barWrap.className = "task-bar-wrapper";
    const bar = document.createElement("div");
    bar.className = "task-bar state-pending";
    const progress = document.createElement("div");
    progress.className = "task-bar-progress";
    barWrap.append(bar, progress);
    this.positionBar(bar, task);

    let childrenWrap: HTMLElement | null = null;
    if (task.children.length > 0) {
      childrenWrap = document.createElement("div");
      childrenWrap.className = "task-children";
      const collapse = depth >= 2;
      if (collapse) childrenWrap.classList.add("collapsed");
      for (const c of task.children) childrenWrap.appendChild(this.buildNode(c, depth + 1));
    }

    const collapsed = !!childrenWrap?.classList.contains("collapsed");
    if (collapsed) toggle.classList.add("is-collapsed");

    row.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".toggle") && childrenWrap) {
        const isCollapsed = childrenWrap.classList.toggle("collapsed");
        toggle.classList.toggle("is-collapsed", isCollapsed);
        const ref = this.nodes.get(task.id);
        if (ref) ref.collapsed = isCollapsed;
        e.stopPropagation();
        return;
      }
      this.select(task.id, false);
    });
    barWrap.addEventListener("click", () => this.select(task.id, false));

    wrap.append(row, barWrap);
    if (childrenWrap) wrap.appendChild(childrenWrap);

    this.nodes.set(task.id, {
      root: wrap,
      row,
      pip,
      bar,
      progress,
      barWrap,
      nameEl: name,
      durationEl: duration,
      childrenWrap,
      toggle,
      collapsed,
    });

    return wrap;
  }

  /** Filtra a árvore por texto (nome ou identificação); expande ramos com correspondência. */
  setFilter(query: string): void {
    const needle = query.trim().toLowerCase();
    const visit = (t: Task): boolean => {
      const selfMatch =
        !needle ||
        t.name.toLowerCase().includes(needle) ||
        displayTaskName(t).toLowerCase().includes(needle) ||
        (t.identification?.toLowerCase().includes(needle) ?? false);
      let childMatch = false;
      for (const c of t.children) {
        if (visit(c)) childMatch = true;
      }
      const show = selfMatch || childMatch;
      const ref = this.nodes.get(t.id);
      if (ref?.root) ref.root.style.display = show ? "" : "none";
      if (needle && childMatch && ref?.childrenWrap && ref.collapsed) {
        ref.childrenWrap.classList.remove("collapsed");
        ref.toggle.classList.remove("is-collapsed");
        ref.collapsed = false;
      }
      return show;
    };
    for (const r of this.opts.schedule.roots) visit(r);
  }

  /** Recoloca barras e atualiza nomes após o IFC mudar no editor de planejamento. */
  refreshLayout(): void {
    this.startMs = this.opts.schedule.minDate.getTime();
    this.totalRangeMs = Math.max(1, this.opts.schedule.maxDate.getTime() - this.startMs);
    for (const [id, ref] of this.nodes) {
      const task = this.opts.schedule.byId.get(id);
      if (!task) continue;
      this.fillName(ref.nameEl, task);
      ref.durationEl.textContent = fmtDuration(task.start, task.end);
      this.positionBar(ref.bar, task);
    }
  }

  /** Reconstrói a árvore após criar/apagar IfcTask, mantendo a seleção. */
  rebuild(): void {
    const keep = this.selectedId;
    this.selectedId = null;
    this.applySchedule(this.opts.schedule);
    this.render();
    if (keep != null && this.opts.schedule.byId.has(keep)) this.select(keep, false);
  }

  private fillName(el: HTMLElement, task: Task): void {
    el.replaceChildren();
    if (task.identification && !isInternalProjectCode(task.identification)) {
      const ident = document.createElement("span");
      ident.className = "ident";
      ident.textContent = task.identification;
      el.appendChild(ident);
    }
    el.appendChild(document.createTextNode(displayTaskName(task)));
    if (task.isFederationRoot) {
      const badge = document.createElement("span");
      badge.className = "task-file";
      badge.textContent = "IFC";
      el.appendChild(badge);
    } else if (task.sourceFileName && this.opts.schedule.roots.some((r) => r.isFederationRoot)) {
      const badge = document.createElement("span");
      badge.className = "task-file";
      badge.textContent = task.sourceFileName.replace(/\.ifc$/i, "");
      el.appendChild(badge);
    }
    const roll = treeCost(task);
    el.title =
      `${displayTaskName(task)}${task.identification ? ` (${task.identification})` : ""}\n` +
      (task.start ? `Início: ${fmtDate(task.start)}\n` : "") +
      (task.end ? `Fim: ${fmtDate(task.end)}\n` : "") +
      (roll > 0 ? `Custo 5D: ${formatMoney(roll, this.opts.schedule.currency)}` : "");
  }

  private positionBar(bar: HTMLElement, task: Task) {
    if (!task.start || !task.end) {
      bar.style.left = "0%";
      bar.style.width = "100%";
      bar.classList.remove("state-pending", "state-active", "state-done", "is-timed");
      bar.classList.add("state-pending");
      bar.style.opacity = "0.25";
      return;
    }
    const left = ((task.start.getTime() - this.startMs) / this.totalRangeMs) * 100;
    const width = ((task.end.getTime() - task.start.getTime()) / this.totalRangeMs) * 100;
    bar.style.left = `${Math.max(0, Math.min(100, left))}%`;
    bar.style.width = `${Math.max(0.5, Math.min(100, width))}%`;
    bar.classList.add("is-timed");
    bar.style.opacity = "1";
  }

  /** Atualiza cores das barras + progresso para a data atual. */
  update(currentDate: Date) {
    const t = currentDate.getTime();
    const visit = (task: Task) => {
      const ref = this.nodes.get(task.id);
      if (!ref) return;
      const state = getTaskState(task, currentDate);
      ref.bar.classList.remove("state-pending", "state-active", "state-done");
      ref.bar.classList.add(`state-${state}`);
      if (task.start && task.end) ref.bar.classList.add("is-timed");
      ref.bar.style.opacity = task.start && task.end ? "1" : "0.25";
      ref.pip.dataset.state = state;

      if (task.start && task.end) {
        const s = task.start.getTime();
        const e = task.end.getTime();
        const span = Math.max(1, e - s);
        const pct = Math.max(0, Math.min(1, (t - s) / span));
        const left = ((s - this.startMs) / this.totalRangeMs) * 100;
        const fullW = ((e - s) / this.totalRangeMs) * 100;
        ref.progress.style.left = `${Math.max(0, Math.min(100, left))}%`;
        ref.progress.style.width = `${fullW * pct}%`;
        ref.progress.style.opacity = state === "active" ? "0.85" : state === "done" ? "0.35" : "0";
      } else {
        ref.progress.style.width = "0";
      }

      for (const c of task.children) visit(c);
    };
    for (const r of this.opts.schedule.roots) visit(r);
  }

  private clearSelection() {
    if (this.selectedId == null) return;
    const prev = this.nodes.get(this.selectedId);
    prev?.row.classList.remove("is-selected");
    prev?.root.classList.remove("is-selected");
    this.selectedId = null;
    this.opts.onSelect(null);
  }

  private select(taskId: number, toggleOff: boolean, emit = true) {
    if (this.selectedId === taskId) {
      if (toggleOff) this.clearSelection();
      else {
        this.expandAncestors(taskId);
        this.nodes.get(taskId)?.row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      return;
    }

    if (this.selectedId != null) {
      const prev = this.nodes.get(this.selectedId);
      prev?.row.classList.remove("is-selected");
      prev?.root.classList.remove("is-selected");
    }
    this.selectedId = taskId;
    const ref = this.nodes.get(taskId);
    const task = this.opts.schedule.byId.get(taskId);
    if (ref && task) {
      this.expandAncestors(taskId);
      ref.row.classList.add("is-selected");
      ref.root.classList.add("is-selected");
      ref.row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    if (emit) this.opts.onSelect(task ?? null);
  }

  /** Destaca tarefas 4D ligadas aos GUIDs selecionados no modelo / árvore IFC. */
  markHits(taskIds: Iterable<number>, scroll = true): void {
    const want = new Set(taskIds);
    for (const [id, ref] of this.nodes) {
      const on = want.has(id);
      ref.row.classList.toggle("is-hit", on);
      ref.root.classList.toggle("is-hit", on);
      if (on) this.expandAncestors(id);
    }
    if (!want.size) return;
    if (scroll) {
      this.opts.container.querySelector<HTMLElement>(".task-row.is-hit")?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }

  private expandAncestors(taskId: number): void {
    let current = this.opts.schedule.byId.get(taskId);
    while (current?.parentId != null) {
      const parent = this.nodes.get(current.parentId);
      if (parent?.childrenWrap?.classList.contains("collapsed")) {
        parent.childrenWrap.classList.remove("collapsed");
        parent.toggle.classList.remove("is-collapsed");
        parent.collapsed = false;
      }
      current = this.opts.schedule.byId.get(current.parentId);
    }
  }
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtDuration(start?: Date, end?: Date): string {
  if (!start || !end) return "—";
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  if (days < 60) return `${days}d`;
  const months = Math.round(days / 30);
  return `${months}m`;
}
