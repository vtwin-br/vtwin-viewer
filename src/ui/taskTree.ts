import type { ScheduleData, Task, TaskState } from "../schedule/types";
import { getTaskState } from "../schedule/simulation";

export interface TaskTreeOptions {
  container: HTMLElement;
  schedule: ScheduleData;
  /** Chamado ao clicar numa task (para destacar produtos no viewer). */
  onSelect: (task: Task | null) => void;
}

interface TaskNodeRefs {
  root: HTMLElement;
  row: HTMLElement;
  bar: HTMLElement;
  progress: HTMLElement;
  childrenWrap: HTMLElement | null;
  toggle: HTMLElement;
  collapsed: boolean;
}

export class TaskTreeUI {
  private opts: TaskTreeOptions;
  private nodes = new Map<number, TaskNodeRefs>();
  private selectedId: number | null = null;
  private totalRangeMs: number;
  private startMs: number;

  constructor(opts: TaskTreeOptions) {
    this.opts = opts;
    this.startMs = opts.schedule.minDate.getTime();
    this.totalRangeMs = Math.max(1, opts.schedule.maxDate.getTime() - this.startMs);
    this.render();
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

    const toggle = document.createElement("span");
    toggle.className = "toggle";
    if (task.children.length === 0) toggle.classList.add("leaf");
    toggle.textContent = task.children.length > 0 ? "▾" : "•";

    const name = document.createElement("span");
    name.className = "name";
    if (task.identification) {
      const ident = document.createElement("span");
      ident.className = "ident";
      ident.textContent = task.identification;
      name.appendChild(ident);
    }
    name.appendChild(document.createTextNode(task.name));
    name.title = `${task.identification ?? ""} ${task.name}\n` +
      (task.start ? `Inicio: ${fmtDate(task.start)}\n` : "") +
      (task.end ? `Fim:    ${fmtDate(task.end)}\n` : "") +
      `Produtos: ${task.productGuids.length}`;

    const duration = document.createElement("span");
    duration.className = "duration";
    duration.textContent = fmtDuration(task.start, task.end);

    row.appendChild(toggle);
    row.appendChild(name);
    row.appendChild(duration);

    const barWrap = document.createElement("div");
    barWrap.className = "task-bar-wrapper";
    const bar = document.createElement("div");
    bar.className = "task-bar state-pending";
    const progress = document.createElement("div");
    progress.className = "task-bar-progress";
    barWrap.appendChild(bar);
    barWrap.appendChild(progress);
    this.positionBar(bar, task);

    let childrenWrap: HTMLElement | null = null;
    if (task.children.length > 0) {
      childrenWrap = document.createElement("div");
      childrenWrap.className = "task-children";
      // Auto-colapsa se profundidade >= 2 para evitar arvore enorme
      const collapse = depth >= 2;
      if (collapse) childrenWrap.classList.add("collapsed");
      for (const c of task.children) childrenWrap.appendChild(this.buildNode(c, depth + 1));
    }

    const collapsed = !!childrenWrap?.classList.contains("collapsed");
    if (collapsed && childrenWrap) toggle.textContent = "▸";

    row.addEventListener("click", (e) => {
      // clique no toggle expande/colapsa
      if (e.target === toggle && childrenWrap) {
        const isCollapsed = childrenWrap.classList.toggle("collapsed");
        toggle.textContent = isCollapsed ? "▸" : "▾";
        const ref = this.nodes.get(task.id);
        if (ref) ref.collapsed = isCollapsed;
        return;
      }
      this.select(task.id);
    });

    wrap.appendChild(row);
    wrap.appendChild(barWrap);
    if (childrenWrap) wrap.appendChild(childrenWrap);

    this.nodes.set(task.id, {
      root: wrap,
      row,
      bar,
      progress,
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
        ref.toggle.textContent = "▾";
        ref.collapsed = false;
      }
      return show;
    };
    for (const r of this.opts.schedule.roots) visit(r);
  }

  private positionBar(bar: HTMLElement, task: Task) {
    if (!task.start || !task.end) {
      bar.style.left = "0%";
      bar.style.width = "100%";
      bar.classList.remove("state-pending", "state-active", "state-done");
      bar.classList.add("state-pending");
      bar.style.opacity = "0.25";
      return;
    }
    const left = ((task.start.getTime() - this.startMs) / this.totalRangeMs) * 100;
    const width = ((task.end.getTime() - task.start.getTime()) / this.totalRangeMs) * 100;
    bar.style.left = `${Math.max(0, Math.min(100, left))}%`;
    bar.style.width = `${Math.max(0.5, Math.min(100, width))}%`;
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
      ref.bar.style.opacity = task.start && task.end ? "1" : "0.25";

      // progress overlay (so para tasks com tempo)
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

  private select(taskId: number) {
    if (this.selectedId === taskId) {
      // toggle off
      this.selectedId = null;
      const ref = this.nodes.get(taskId);
      ref?.row.classList.remove("is-selected");
      this.opts.onSelect(null);
      return;
    }

    if (this.selectedId != null) {
      this.nodes.get(this.selectedId)?.row.classList.remove("is-selected");
    }
    this.selectedId = taskId;
    const ref = this.nodes.get(taskId);
    ref?.row.classList.add("is-selected");
    const task = this.opts.schedule.byId.get(taskId);
    this.opts.onSelect(task ?? null);
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
  if (days < 7) return `${days}d`;
  if (days < 60) return `${days}d`;
  const months = Math.round(days / 30);
  return `${months}m`;
}
