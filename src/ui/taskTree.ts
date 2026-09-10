import type { ScheduleData, Task } from "../schedule/types";
import { getTaskState } from "../schedule/simulation";
import { formatMoney, treeCost } from "../schedule/cost";
import { displayTaskName, isInternalProjectCode } from "./taskLabels";
import type { TaskPatch } from "../ifc/ifcSession";

const ICON_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export interface TaskTreeOptions {
  container: HTMLElement;
  schedule: ScheduleData;
  onSelect: (task: Task | null) => void;
  onEdit?: (task: Task, patch: TaskPatch) => void;
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
  editor: HTMLElement;
  nameInput: HTMLInputElement;
  identInput: HTMLInputElement;
  startInput: HTMLInputElement;
  endInput: HTMLInputElement;
  costInput: HTMLInputElement;
  childrenWrap: HTMLElement | null;
  toggle: HTMLElement;
  collapsed: boolean;
}

interface BarDrag {
  taskId: number;
  mode: "move" | "start" | "end";
  originX: number;
  startMs: number;
  endMs: number;
  width: number;
  preview?: { start: Date; end: Date };
}

export class TaskTreeUI {
  private opts: TaskTreeOptions;
  private nodes = new Map<number, TaskNodeRefs>();
  private selectedId: number | null = null;
  private totalRangeMs = 1;
  private startMs = 0;
  private drag: BarDrag | null = null;
  private fillingEditor = false;

  constructor(opts: TaskTreeOptions) {
    this.opts = opts;
    this.applySchedule(opts.schedule);
    this.render();
    window.addEventListener("pointermove", this.onBarMove);
    window.addEventListener("pointerup", this.onBarUp);
  }

  /** Substitui o cronograma (novo IFC importado) e reconstrói a árvore. */
  setSchedule(schedule: ScheduleData): void {
    this.selectedId = null;
    this.opts.onSelect(null);
    this.applySchedule(schedule);
    this.render();
  }

  /** Seleciona uma tarefa sem alternar (ex.: clique no 3D). */
  selectById(taskId: number | null): void {
    if (taskId == null) {
      this.clearSelection();
      return;
    }
    this.select(taskId, false);
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
    const handleStart = document.createElement("span");
    handleStart.className = "bar-handle is-start";
    handleStart.title = "Arraste para alterar o início";
    const handleEnd = document.createElement("span");
    handleEnd.className = "bar-handle is-end";
    handleEnd.title = "Arraste para alterar o fim";
    const progress = document.createElement("div");
    progress.className = "task-bar-progress";
    bar.append(handleStart, handleEnd);
    barWrap.append(bar, progress);
    this.positionBar(bar, task);

    const editor = this.buildEditor(task);

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

    bar.addEventListener("pointerdown", (e) => this.beginBarDrag(e, task.id));

    wrap.append(row, barWrap, editor);
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
      editor,
      nameInput: editor.querySelector(".te-name") as HTMLInputElement,
      identInput: editor.querySelector(".te-ident") as HTMLInputElement,
      startInput: editor.querySelector(".te-start") as HTMLInputElement,
      endInput: editor.querySelector(".te-end") as HTMLInputElement,
      costInput: editor.querySelector(".te-cost") as HTMLInputElement,
      childrenWrap,
      toggle,
      collapsed,
    });

    return wrap;
  }

  private buildEditor(task: Task): HTMLElement {
    const editor = document.createElement("div");
    editor.className = "task-editor";
    editor.hidden = true;
    editor.innerHTML = `
      <p class="te-kicker">Editar propriedades da atividade</p>
      <label class="te-field">
        <span>Nome</span>
        <input class="te-name" type="text" spellcheck="false" />
      </label>
      <label class="te-field">
        <span>Identificação</span>
        <input class="te-ident" type="text" spellcheck="false" placeholder="Opcional" />
      </label>
      <div class="te-dates">
        <label class="te-field">
          <span>Início</span>
          <input class="te-start" type="date" />
        </label>
        <label class="te-field">
          <span>Fim</span>
          <input class="te-end" type="date" />
        </label>
      </div>
      <label class="te-field">
        <span>Custo 5D (IfcCostItem)</span>
        <input class="te-cost" type="number" step="0.01" min="0" inputmode="decimal" placeholder="Opcional" />
      </label>
      <p class="te-hint">O valor grava em IfcCostValue.AppliedValue. Também pode arrastar a barra para mudar as datas.</p>
    `;

    const nameInput = editor.querySelector(".te-name") as HTMLInputElement;
    const identInput = editor.querySelector(".te-ident") as HTMLInputElement;
    const startInput = editor.querySelector(".te-start") as HTMLInputElement;
    const endInput = editor.querySelector(".te-end") as HTMLInputElement;
    const costInput = editor.querySelector(".te-cost") as HTMLInputElement;

    nameInput.addEventListener("change", () => {
      if (this.fillingEditor) return;
      this.opts.onEdit?.(task, { name: nameInput.value });
    });
    identInput.addEventListener("change", () => {
      if (this.fillingEditor) return;
      this.opts.onEdit?.(task, { identification: identInput.value });
    });
    const commitDates = () => {
      if (this.fillingEditor) return;
      this.commitEditorDates(task, startInput, endInput);
    };
    startInput.addEventListener("change", commitDates);
    endInput.addEventListener("change", commitDates);
    costInput.addEventListener("change", () => {
      if (this.fillingEditor) return;
      this.commitEditorCost(task, costInput);
    });
    editor.addEventListener("click", (e) => e.stopPropagation());
    editor.addEventListener("pointerdown", (e) => e.stopPropagation());
    return editor;
  }

  private commitEditorDates(task: Task, startInput: HTMLInputElement, endInput: HTMLInputElement) {
    if (!startInput.value || !endInput.value) return;
    const start = combineDateInput(startInput.value, task.start, 9, 0);
    const end = combineDateInput(endInput.value, task.end, 17, 0);
    if (end.getTime() < start.getTime()) return;
    this.opts.onEdit?.(task, { start, end });
  }

  private commitEditorCost(task: Task, costInput: HTMLInputElement) {
    const raw = costInput.value.trim().replace(",", ".");
    if (!raw) {
      if (task.cost == null) return;
      this.opts.onEdit?.(task, { cost: 0 });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    this.opts.onEdit?.(task, { cost: n });
  }

  private fillEditor(ref: TaskNodeRefs, task: Task) {
    this.fillingEditor = true;
    ref.nameInput.value = task.name;
    ref.identInput.value = task.identification ?? "";
    ref.startInput.value = task.start ? toDateInput(task.start) : "";
    ref.endInput.value = task.end ? toDateInput(task.end) : "";
    ref.costInput.value = task.cost == null ? "" : String(task.cost);
    this.fillingEditor = false;
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

  /** Recoloca barras e atualiza nomes após editar datas/identidade no IFC. */
  refreshLayout(): void {
    this.startMs = this.opts.schedule.minDate.getTime();
    this.totalRangeMs = Math.max(1, this.opts.schedule.maxDate.getTime() - this.startMs);
    for (const [id, ref] of this.nodes) {
      const task = this.opts.schedule.byId.get(id);
      if (!task) continue;
      this.fillName(ref.nameEl, task);
      ref.durationEl.textContent = fmtDuration(task.start, task.end);
      this.positionBar(ref.bar, task);
      if (id === this.selectedId) this.fillEditor(ref, task);
    }
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
    const roll = treeCost(task);
    el.title =
      `${displayTaskName(task)}${task.identification ? ` (${task.identification})` : ""}\n` +
      (task.start ? `Início: ${fmtDate(task.start)}\n` : "") +
      (task.end ? `Fim: ${fmtDate(task.end)}\n` : "") +
      (roll > 0 ? `Custo 5D: ${formatMoney(roll, this.opts.schedule.currency)}\n` : "") +
      "Clique para editar · arraste a barra para as datas";
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

  private beginBarDrag(e: PointerEvent, taskId: number) {
    if (e.button !== 0) return;
    const task = this.opts.schedule.byId.get(taskId);
    const ref = this.nodes.get(taskId);
    if (!task?.start || !task.end || !ref) return;
    e.preventDefault();
    e.stopPropagation();
    this.select(taskId, false);
    const target = e.target as HTMLElement;
    const mode: BarDrag["mode"] = target.classList.contains("is-start")
      ? "start"
      : target.classList.contains("is-end")
        ? "end"
        : "move";
    this.drag = {
      taskId,
      mode,
      originX: e.clientX,
      startMs: task.start.getTime(),
      endMs: task.end.getTime(),
      width: Math.max(1, ref.barWrap.getBoundingClientRect().width),
    };
    ref.bar.classList.add("is-dragging");
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  private onBarMove = (e: PointerEvent) => {
    if (!this.drag) return;
    const task = this.opts.schedule.byId.get(this.drag.taskId);
    const ref = this.nodes.get(this.drag.taskId);
    if (!task || !ref) return;
    const deltaMs = ((e.clientX - this.drag.originX) / this.drag.width) * this.totalRangeMs;
    const day = 86400000;
    let start = this.drag.startMs;
    let end = this.drag.endMs;
    const duration = end - start;
    if (this.drag.mode === "move") {
      start = this.drag.startMs + deltaMs;
      end = start + duration;
    } else if (this.drag.mode === "start") {
      start = Math.min(this.drag.startMs + deltaMs, this.drag.endMs - day);
    } else {
      end = Math.max(this.drag.endMs + deltaMs, this.drag.startMs + day);
    }
    const preview = { start: new Date(start), end: new Date(end) };
    this.positionBar(ref.bar, { ...task, start: preview.start, end: preview.end });
    ref.durationEl.textContent = fmtDuration(preview.start, preview.end);
    this.fillingEditor = true;
    ref.startInput.value = toDateInput(preview.start);
    ref.endInput.value = toDateInput(preview.end);
    this.fillingEditor = false;
    this.drag.preview = preview;
  };

  private onBarUp = () => {
    if (!this.drag) return;
    const { taskId } = this.drag;
    const preview = this.drag.preview;
    const ref = this.nodes.get(taskId);
    ref?.bar.classList.remove("is-dragging");
    this.drag = null;
    const task = this.opts.schedule.byId.get(taskId);
    if (!task || !preview) return;
    this.opts.onEdit?.(task, { start: preview.start, end: preview.end });
  };

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
    if (prev) prev.editor.hidden = true;
    this.selectedId = null;
    this.opts.onSelect(null);
  }

  private select(taskId: number, toggleOff: boolean) {
    if (this.selectedId === taskId) {
      if (toggleOff) this.clearSelection();
      return;
    }

    if (this.selectedId != null) {
      const prev = this.nodes.get(this.selectedId);
      prev?.row.classList.remove("is-selected");
      prev?.root.classList.remove("is-selected");
      if (prev) prev.editor.hidden = true;
    }
    this.selectedId = taskId;
    const ref = this.nodes.get(taskId);
    const task = this.opts.schedule.byId.get(taskId);
    if (ref && task) {
      ref.row.classList.add("is-selected");
      ref.root.classList.add("is-selected");
      ref.editor.hidden = false;
      this.fillEditor(ref, task);
      ref.row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    this.opts.onSelect(task ?? null);
  }
}

function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function combineDateInput(
  dateStr: string,
  previous: Date | undefined,
  fallbackH: number,
  fallbackM: number,
): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const h = previous?.getHours() ?? fallbackH;
  const min = previous?.getMinutes() ?? fallbackM;
  const s = previous?.getSeconds() ?? 0;
  return new Date(y, m - 1, d, h, min, s);
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
