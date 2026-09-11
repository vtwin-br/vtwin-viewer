import type { ScheduleData } from "../schedule/types";
import {
  applyDuration,
  applyEnd,
  applyStart,
  formatBytes,
  indentTasks,
  outlineParentIndex,
  outlinePrevSiblingIndex,
  outdentTasks,
  rebuildWbs,
  selectionRootIndices,
  visibleTasks,
} from "../projectPlan/buildPlan";
import { addDays, diffDays, formatDay, fromInputDate, startOfDay, toInputDate } from "../projectPlan/dates";
import { importPlanFile } from "../projectPlan/importPlan";
import { planToOutlineRows, scheduleToPlan } from "../projectPlan/fromIfc";
import {
  CSV_FIELDS,
  planFromMappedCsv,
  reinspect,
  sampleCell,
  type ColMap,
  type CsvField,
  type CsvInspection,
} from "../projectPlan/parseCsv";
import { fileToAttachment } from "../projectPlan/buildPlan";
import type { PlanTask, ProjectPlan } from "../projectPlan/types";
import type { IfcSession, TaskPatch } from "../ifc/ifcSession";

const ZOOM = [8, 14, 22, 32];
const ROW_H = 36;
const ICON_TOGGLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_OUTDENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 7h11M9 12h11M9 17h7" stroke-linecap="round"/><path d="M6 9L3 12l3 3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_INDENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h11M4 12h11M4 17h7" stroke-linecap="round"/><path d="M18 9l3 3-3 3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export interface ProjectWorkspaceOptions {
  getIfcSchedule: () => ScheduleData | null;
  getIfcFileName: () => string | null;
  getSession: () => IfcSession | null;
  resolveIfcTask?: (federatedId: number) => { session: IfcSession; nativeId: number } | null;
  federateIfcId?: (session: IfcSession, nativeId: number) => number;
  onRequestIfcImport: () => void;
  onPlanChange?: (name: string | null) => void;
  onSelectTask?: (task: PlanTask | null) => void;
  onToggleModel?: () => void;
  onHideGantt?: () => void;
  onNativeChange?: (info: { timeChanged?: boolean; structure?: boolean }) => void;
}

export class ProjectWorkspace {
  private root: HTMLElement;
  private opts: ProjectWorkspaceOptions;
  private plan: ProjectPlan | null = null;
  private selectedId: string | null = null;
  private selectedIds = new Set<string>();
  private selectionAnchorId: string | null = null;
  private pxPerDay = 14;
  private toastTimer = 0;
  private fileInput: HTMLInputElement | null = null;
  private csvDraft: CsvInspection | null = null;
  private csvFile: File | null = null;
  private modelOpen = false;
  private hitIfcIds = new Set<number>();

  constructor(root: HTMLElement, opts: ProjectWorkspaceOptions) {
    this.root = root;
    this.opts = opts;
    this.fileInput = document.getElementById("plan-file-input") as HTMLInputElement | null;
    this.fileInput?.addEventListener("change", () => {
      const files = [...(this.fileInput?.files ?? [])];
      if (this.fileInput) this.fileInput.value = "";
      if (files.length) void this.importFiles(files);
    });
    this.mount();
    this.bindShellEvents();
  }

  setActive(active: boolean): void {
    this.root.classList.toggle("is-active", active);
    if (active && !this.plan) this.render();
  }

  getPlan(): ProjectPlan | null {
    return this.plan;
  }

  getSelected(): PlanTask | null {
    if (!this.plan || !this.selectedId) return null;
    return this.plan.tasks.find((t) => t.id === this.selectedId) ?? null;
  }

  getSelectedTasks(): PlanTask[] {
    if (!this.plan || !this.selectedIds.size) return [];
    return this.plan.tasks.filter((t) => this.selectedIds.has(t.id));
  }

  setModelOpen(open: boolean): void {
    this.modelOpen = open;
    this.root.querySelectorAll("[data-act='model']").forEach((btn) => {
      btn.classList.toggle("is-active", open);
      btn.setAttribute("aria-pressed", open ? "true" : "false");
    });
  }

  selectByIfcTaskId(ifcId: number): void {
    const task = this.plan?.tasks.find((t) => t.linkedIfcTaskId === ifcId);
    if (!task || !this.plan) return;
    this.expandAncestors(task.id);
    this.selectedId = task.id;
    this.selectedIds = new Set([task.id]);
    this.selectionAnchorId = task.id;
    this.renderBoard();
    this.el("table-body")
      ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(task.id)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /** Destaca no Gantt as IfcTask ligadas aos elementos selecionados (árvore / 3D / conjuntos). */
  markHits(ifcTaskIds: Iterable<number>, scroll = true): void {
    const next = new Set(ifcTaskIds);
    this.hitIfcIds = next;
    if (!this.plan) return;
    let expanded = false;
    for (const ifcId of this.hitIfcIds) {
      const task = this.plan.tasks.find((t) => t.linkedIfcTaskId === ifcId);
      if (task && this.expandAncestors(task.id)) expanded = true;
    }
    if (expanded) this.renderBoard();
    else this.paintHits();
    if (!scroll || !this.hitIfcIds.size) return;
    this.el("table-body")
      ?.querySelector<HTMLElement>(".pw-row.is-hit, .pw-row.is-selected")
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private expandAncestors(id: string): boolean {
    if (!this.plan) return false;
    const tasks = this.plan.tasks;
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    let level = tasks[idx].outlineLevel;
    let changed = false;
    for (let i = idx - 1; i >= 0 && level > 1; i--) {
      if (tasks[i].outlineLevel < level) {
        if (tasks[i].collapsed) {
          tasks[i].collapsed = false;
          changed = true;
        }
        level = tasks[i].outlineLevel;
      }
    }
    return changed;
  }

  applyProductGuids(ifcTaskId: number, _guids: string[]): void {
    const schedule = this.opts.getIfcSchedule();
    if (this.plan && schedule) {
      for (const t of this.plan.tasks) {
        if (t.linkedIfcTaskId == null) continue;
        t.linkedProductGuids = [...(schedule.productGuidsByTask.get(t.linkedIfcTaskId) ?? [])];
        const ifcTask = schedule.byId.get(t.linkedIfcTaskId);
        t.linkedGroupIds = [...(ifcTask?.groupIds ?? [])];
        t.linkedGroupNames = (ifcTask?.groupIds ?? [])
          .map((id) => schedule.groups.find((g) => g.id === id)?.name)
          .filter((n): n is string => !!n);
      }
    } else {
      const task = this.plan?.tasks.find((t) => t.linkedIfcTaskId === ifcTaskId);
      if (task) task.linkedProductGuids = [..._guids];
    }
    this.renderBoard();
  }

  notify(message: string): void {
    this.toast(message);
  }

  /** Abre o IfcWorkSchedule do modelo no Gantt (mesmas tarefas e datas do Cronograma 4D). */
  bindFromIfc(schedule: ScheduleData, fileName?: string, _force = false): void {
    if (!schedule.roots.length) {
      this.plan = null;
      this.selectedId = null;
      this.selectedIds.clear();
      this.selectionAnchorId = null;
      this.render();
      return;
    }
    const keepIfc = this.getSelected()?.linkedIfcTaskId;
    const keepIds = new Set(
      [...this.selectedIds]
        .map((id) => this.plan?.tasks.find((t) => t.id === id)?.linkedIfcTaskId)
        .filter((id): id is number => id != null),
    );
    this.plan = scheduleToPlan(schedule, fileName);
    this.selectedId =
      (keepIfc != null ? this.plan.tasks.find((t) => t.linkedIfcTaskId === keepIfc)?.id : undefined) ??
      this.plan.tasks[0]?.id ??
      null;
    this.selectedIds = new Set(
      this.plan.tasks.filter((t) => t.linkedIfcTaskId != null && keepIds.has(t.linkedIfcTaskId)).map((t) => t.id),
    );
    if (this.selectedId) this.selectedIds.add(this.selectedId);
    this.selectionAnchorId = this.selectedId;
    this.render();
    if (this.modelOpen) this.opts.onSelectTask?.(this.getSelected());
  }

  private mount(): void {
    this.root.innerHTML = `
      <div class="pw-empty" data-pane="empty">
        <div class="pw-empty-card">
          <div class="pw-empty-visual" aria-hidden="true">
            <svg viewBox="0 0 64 64" fill="none">
              <rect x="8" y="16" width="22" height="36" rx="6" stroke="currentColor" stroke-width="1.7"/>
              <path d="M14 26h10M14 34h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
              <rect x="34" y="22" width="18" height="8" rx="2" fill="currentColor" opacity="0.16" stroke="currentColor" stroke-width="1.6"/>
              <rect x="38" y="34" width="14" height="8" rx="2" fill="currentColor" opacity="0.1" stroke="currentColor" stroke-width="1.6"/>
              <rect x="36" y="46" width="20" height="6" rx="2" stroke="currentColor" stroke-width="1.6" opacity="0.45"/>
            </svg>
          </div>
          <h3>Planejamento de projeto</h3>
          <p data-el="empty-copy">O Gantt é o editor nativo do IfcWorkSchedule. Abrir, criar ou importar CSV grava IfcTask no IFC — exporte o ficheiro para ver noutro software openBIM.</p>
          <div class="pw-empty-actions" data-el="empty-actions">
            <button type="button" class="btn-primary" data-act="from-ifc">Abrir cronograma do IFC</button>
            <button type="button" class="btn-secondary" data-act="import">Importar CSV / XML para o IFC</button>
            <button type="button" class="btn-secondary" data-act="new">Novo cronograma no IFC</button>
          </div>
        </div>
      </div>
      <div class="pw-board is-hidden" data-pane="board">
        <header class="pw-toolbar">
          <div class="pw-toolbar-left">
            <input class="pw-title" data-el="title" spellcheck="false" aria-label="Nome do cronograma" />
            <span class="pw-meta" data-el="meta"></span>
            <div class="pw-attach" data-el="attach" hidden></div>
          </div>
          <div class="pw-toolbar-right">
            <button type="button" class="btn-primary" data-act="add">Nova tarefa</button>
            <button type="button" class="btn-secondary" data-act="model" aria-pressed="false" title="Mostrar o modelo 3D ao lado do Gantt (M)">Modelo 3D</button>
            <button type="button" class="btn-secondary pw-act-wide" data-act="from-ifc">Abrir IFC</button>
            <button type="button" class="btn-ghost pw-act-wide" data-act="import">Importar CSV</button>
            <div class="pw-overflow">
              <button type="button" class="icon-btn-plain pw-overflow-btn" data-act="more" aria-label="Mais ações" aria-haspopup="true" title="Mais ações">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></svg>
              </button>
              <div class="pw-overflow-menu" hidden data-el="more-menu">
                <button type="button" data-act="outdent">Subir nível da EAP</button>
                <button type="button" data-act="indent">Rebaixar nível da EAP</button>
                <button type="button" data-act="model">Modelo 3D</button>
                <button type="button" data-act="from-ifc">Abrir IFC</button>
                <button type="button" data-act="import">Importar CSV / XML</button>
              </div>
            </div>
            <div class="pw-eap" role="group" aria-label="Nível da EAP">
              <button type="button" class="pw-zoom-btn" data-act="outdent" title="Subir nível da EAP (Alt+Shift+←)" aria-label="Subir nível da EAP">${ICON_OUTDENT}</button>
              <button type="button" class="pw-zoom-btn" data-act="indent" title="Rebaixar nível da EAP (Alt+Shift+→)" aria-label="Rebaixar nível da EAP">${ICON_INDENT}</button>
            </div>
            <div class="pw-zoom" role="group" aria-label="Zoom do Gantt">
              <button type="button" class="pw-zoom-btn" data-act="zoom-out" title="Afastar" aria-label="Afastar">−</button>
              <button type="button" class="pw-zoom-btn" data-act="zoom-in" title="Aproximar" aria-label="Aproximar">+</button>
            </div>
            <button type="button" class="panel-collapse pw-hide-gantt" data-act="hide-gantt" title="Ocultar Gantt" aria-label="Ocultar Gantt">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </header>
        <div class="pw-gantt" data-el="gantt">
          <div class="pw-table">
            <div class="pw-table-head">
              <span class="pw-col-wbs">WBS</span>
              <span class="pw-col-name">Nome</span>
              <span class="pw-col-prod">3D</span>
              <span class="pw-col-set">Conjunto</span>
              <span class="pw-col-dur">Dias</span>
              <span class="pw-col-date">Início</span>
              <span class="pw-col-date">Término</span>
            </div>
            <div class="pw-table-body" data-el="table-body"></div>
          </div>
          <div class="pw-gantt-split" data-el="gantt-split" role="separator" aria-orientation="vertical" aria-label="Largura da tabela" tabindex="0"></div>
          <div class="pw-chart">
            <div class="pw-scale" data-el="scale"></div>
            <div class="pw-chart-body" data-el="chart-body"></div>
          </div>
        </div>
      </div>
      <div class="pw-sync is-hidden" data-el="mapper" role="dialog" aria-modal="true" aria-labelledby="pw-map-title"></div>
      <div class="pw-toast" data-el="toast" hidden></div>
    `;
    this.root.querySelector("[data-pane='empty']")?.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
      if (act === "new") this.newPlan();
      if (act === "import") this.fileInput?.click();
      if (act === "from-ifc") this.openIfcSchedule();
    });
    this.root.querySelector(".pw-toolbar")?.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
      if (act === "add") this.addTask();
      if (act === "import") this.fileInput?.click();
      if (act === "from-ifc") this.openIfcSchedule();
      if (act === "model") this.opts.onToggleModel?.();
      if (act === "hide-gantt") this.opts.onHideGantt?.();
      if (act === "indent") this.changeOutline(1);
      if (act === "outdent") this.changeOutline(-1);
      if (act === "zoom-in") this.nudgeZoom(1);
      if (act === "zoom-out") this.nudgeZoom(-1);
      if (act === "more") {
        const menu = this.el("more-menu");
        if (menu) menu.hidden = !menu.hidden;
      } else {
        const menu = this.el("more-menu");
        if (menu) menu.hidden = true;
      }
    });
    this.root.querySelector("[data-el='title']")?.addEventListener("change", (e) => {
      if (!this.plan) return;
      const name = (e.target as HTMLInputElement).value.trim() || this.plan.name;
      this.plan.name = name;
      const session = this.opts.getSession();
      if (!session) return;
      session.renameWorkSchedule(name);
      this.opts.onNativeChange?.({});
    });
    this.bindGantt();
    this.el("mapper")?.addEventListener("click", this.onMapperClick);
    this.el("mapper")?.addEventListener("change", this.onMapperChange);
    document.addEventListener("pointerdown", (e) => {
      const menu = this.el("more-menu");
      const wrap = this.root.querySelector(".pw-overflow");
      if (!menu || menu.hidden) return;
      if (wrap && !wrap.contains(e.target as Node)) menu.hidden = true;
    });
  }

  private bindShellEvents(): void {
    const onDrag = (e: DragEvent) => {
      e.preventDefault();
      this.root.classList.add("is-drop-target");
    };
    this.root.addEventListener("dragenter", onDrag);
    this.root.addEventListener("dragover", onDrag);
    this.root.addEventListener("dragleave", (e) => {
      const next = e.relatedTarget as Node | null;
      if (next && this.root.contains(next)) return;
      this.root.classList.remove("is-drop-target");
    });
    this.root.addEventListener("drop", (e) => {
      e.preventDefault();
      this.root.classList.remove("is-drop-target");
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void this.importFiles(files);
    });
  }

  private bindGantt(): void {
    const table = this.el("table-body");
    const chart = this.el("chart-body");
    table?.addEventListener("scroll", () => {
      if (chart) chart.scrollTop = table.scrollTop;
    });
    chart?.addEventListener("scroll", () => {
      if (table) table.scrollTop = chart.scrollTop;
      const scale = this.el("scale");
      if (scale) scale.scrollLeft = chart.scrollLeft;
    });

    const hover = (id: string | null) => {
      this.root.querySelectorAll(".pw-row, .pw-bar, .pw-mile").forEach((el) => {
        el.classList.toggle("is-hover", id != null && (el as HTMLElement).dataset.id === id);
      });
    };
    table?.addEventListener("pointerover", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      hover(row?.dataset.id ?? null);
    });
    table?.addEventListener("pointerleave", () => hover(null));
    chart?.addEventListener("pointerover", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      hover(row?.dataset.id ?? null);
    });
    chart?.addEventListener("pointerleave", () => hover(null));
    chart?.addEventListener("click", (e) => {
      const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (!hit) return;
      this.setSelected(hit.dataset.id!, true, this.clickMode(e));
    });

    this.bindTableSplit();

    table?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>("[data-id]");
      if (!row || !this.plan) return;
      const id = row.dataset.id!;
      if (target.closest("[data-act='toggle']")) {
        const task = this.plan.tasks.find((t) => t.id === id);
        if (task?.isSummary) {
          task.collapsed = !task.collapsed;
          this.renderBoard();
        }
        return;
      }
      this.setSelected(id, true, this.clickMode(e));
    });

    table?.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const row = input.closest<HTMLElement>("[data-id]");
      const task = this.plan?.tasks.find((t) => t.id === row?.dataset.id);
      if (!task || !this.plan) return;
      const field = input.dataset.field;
      const patch: TaskPatch = {};
      if (field === "name") {
        task.name = input.value;
        patch.name = input.value;
      }
      if (field === "wbs") {
        task.wbs = input.value.trim() || undefined;
        patch.identification = input.value;
      }
      if (field === "dur") {
        applyDuration(task, Number(input.value) || 0);
        if (task.start) patch.start = task.start;
        if (task.end) patch.end = task.end;
      }
      if (field === "start") {
        const d = fromInputDate(input.value);
        if (d) {
          applyStart(task, d);
          patch.start = task.start;
          if (task.end) patch.end = task.end;
        }
      }
      if (field === "end") {
        const d = fromInputDate(input.value);
        if (d) {
          applyEnd(task, d);
          if (task.start) patch.start = task.start;
          patch.end = task.end;
        }
      }
      this.syncPlanRange();
      this.renderBoard();
      const ifcId = task.linkedIfcTaskId;
      const resolved = this.native(ifcId);
      if (ifcId != null && resolved && Object.keys(patch).length) {
        try {
          const { timeChanged } = resolved.session.applyTaskEdit(resolved.nativeId, patch);
          this.opts.onNativeChange?.({ timeChanged });
        } catch (err) {
          this.toast((err as Error).message);
        }
      }
    });

    this.root.addEventListener("keydown", (e) => {
      if (!this.root.contains(e.target as Node)) return;
      this.onGanttKey(e);
    });
  }

  private newPlan(): void {
    const session = this.withSession();
    if (!session) return;
    if (session.schedule.roots.length) {
      this.bindFromIfc(session.schedule, session.fileName);
      this.toast("Este IFC já tem IfcWorkSchedule — aberto no Gantt.");
      return;
    }
    try {
      const name = this.opts.getIfcFileName()?.replace(/\.ifc$/i, "") || "Cronograma";
      session.ensureWorkSchedule(name);
      const start = startOfDay(new Date());
      const root = session.createTask({
        name,
        start,
        end: addDays(start, 20),
      });
      session.createTask({
        name: "Nova tarefa",
        parentId: root.id,
        start,
        end: addDays(start, 5),
      });
      this.opts.onNativeChange?.({ structure: true, timeChanged: true });
      this.rebind(this.fedId(session, root.id));
      this.toast("IfcWorkSchedule e IfcTask gravados no modelo. Exporte o IFC para confirmar noutro programa.");
    } catch (err) {
      this.toast((err as Error).message);
    }
  }

  private addTask(): void {
    const session = this.withSession(this.getSelected()?.linkedIfcTaskId);
    if (!session) return;
    if (!this.plan) {
      this.newPlan();
      return;
    }
    const selected = this.getSelected();
    const start = startOfDay(selected?.start ?? this.plan.minDate);
    const end = addDays(start, selected?.durationDays || 5);
    let parentFed: number | undefined;
    if (selected?.linkedIfcTaskId != null && this.plan) {
      const idx = this.plan.tasks.findIndex((t) => t.id === selected.id);
      for (let i = idx - 1; i >= 0; i--) {
        if (this.plan.tasks[i]!.outlineLevel < selected.outlineLevel) {
          parentFed = this.plan.tasks[i]!.linkedIfcTaskId;
          break;
        }
      }
    }
    const parent = this.native(parentFed);
    const after = this.native(selected?.linkedIfcTaskId);
    if (parent && parent.session !== session) {
      this.toast("Não é possível criar a tarefa noutro modelo IFC. Selecione uma linha do mesmo ficheiro.");
      return;
    }
    try {
      const task = session.createTask({
        name: "Nova tarefa",
        start,
        end,
        parentId: parent && parent.nativeId > 0 ? parent.nativeId : undefined,
        afterId: after?.session === session && after.nativeId > 0 ? after.nativeId : undefined,
      });
      this.opts.onNativeChange?.({ structure: true, timeChanged: true });
      this.rebind(this.fedId(session, task.id));
      requestAnimationFrame(() => {
        this.el("table-body")
          ?.querySelector<HTMLInputElement>(`[data-id="${CSS.escape(`ifc-${this.fedId(session, task.id)}`)}"] input[data-field="name"]`)
          ?.focus();
      });
    } catch (err) {
      this.toast((err as Error).message);
    }
  }

  private deleteSelected(): void {
    if (!this.plan || !this.selectedIds.size) return;
    const roots = selectionRootIndices(this.plan.tasks, this.selectedIds)
      .map((i) => this.plan!.tasks[i])
      .filter((t) => t.linkedIfcTaskId != null);
    if (!roots.length) return;
    const names = roots.slice(0, 3).map((t) => t.name).join(", ");
    const extra = roots.length > 3 ? ` e mais ${roots.length - 3}` : "";
    const label =
      roots.length === 1
        ? `Apagar «${roots[0]!.name}» e subtarefas do IFC (IfcTask)?`
        : `Apagar ${roots.length} tarefas (${names}${extra}) e subtarefas do IFC?`;
    if (!window.confirm(label)) return;
    try {
      for (const task of roots) {
        const resolved = this.native(task.linkedIfcTaskId);
        if (resolved && resolved.nativeId > 0) resolved.session.deleteTask(resolved.nativeId);
      }
      this.opts.onNativeChange?.({ structure: true, timeChanged: true });
      this.rebind();
    } catch (err) {
      this.toast((err as Error).message);
    }
  }

  private openIfcSchedule(): void {
    const schedule = this.opts.getIfcSchedule();
    if (!this.opts.getSession()) {
      this.toast("Importe um IFC para editar o cronograma nativo.");
      this.opts.onRequestIfcImport();
      return;
    }
    if (!schedule?.roots.length) {
      this.toast("Este IFC ainda não tem IfcTask. Crie um cronograma ou importe CSV/XML.");
      return;
    }
    this.bindFromIfc(schedule, this.opts.getIfcFileName() ?? undefined);
  }

  private native(federatedId: number | undefined | null): { session: IfcSession; nativeId: number } | null {
    if (federatedId == null) return null;
    return this.opts.resolveIfcTask?.(federatedId) ?? (this.opts.getSession() ? { session: this.opts.getSession()!, nativeId: federatedId } : null);
  }

  private withSession(federatedId?: number): IfcSession | null {
    const resolved = federatedId != null ? this.native(federatedId) : null;
    if (resolved) return resolved.session;
    const session = this.opts.getSession();
    if (session) return session;
    this.toast("Abra um IFC para gravar o cronograma no modelo.");
    this.opts.onRequestIfcImport();
    return null;
  }

  private rebind(selectIfcId?: number): void {
    const schedule = this.opts.getIfcSchedule();
    if (!schedule?.roots.length) {
      this.plan = null;
      this.selectedId = null;
      this.selectedIds.clear();
      this.selectionAnchorId = null;
      this.render();
      return;
    }
    this.plan = scheduleToPlan(schedule, this.opts.getIfcFileName() ?? undefined);
    this.selectedId =
      (selectIfcId != null ? this.plan.tasks.find((t) => t.linkedIfcTaskId === selectIfcId)?.id : undefined) ??
      this.plan.tasks[0]?.id ??
      null;
    this.selectedIds = this.selectedId ? new Set([this.selectedId]) : new Set();
    this.selectionAnchorId = this.selectedId;
    this.render();
  }

  private fedId(session: IfcSession, nativeId: number): number {
    return this.opts.federateIfcId?.(session, nativeId) ?? nativeId;
  }

  private syncPlanRange(): void {
    if (!this.plan) return;
    const dates = this.plan.tasks.flatMap((t) => [t.start, t.end]).filter((d): d is Date => !!d);
    if (!dates.length) return;
    const times = dates.map((d) => d.getTime());
    this.plan.minDate = new Date(Math.min(...times));
    this.plan.maxDate = new Date(Math.max(...times));
  }

  private writeImportedPlan(plan: ProjectPlan): void {
    const session = this.withSession();
    if (!session) return;
    try {
      const { created, updated } = session.importOutline(planToOutlineRows(plan), plan.name);
      this.opts.onNativeChange?.({ structure: true, timeChanged: true });
      this.rebind();
      this.toast(
        `${created} IfcTask criada${created === 1 ? "" : "s"}, ${updated} atualizada${updated === 1 ? "" : "s"} no IFC. Exporte para confirmar.`,
      );
    } catch (err) {
      this.toast((err as Error).message);
    }
  }

  private async importFiles(files: File[]): Promise<void> {
    const warnings: string[] = [];
    let imported: ProjectPlan | null = null;
    const extra = [];
    for (const file of files) {
      try {
        const result = await importPlanFile(file);
        if (result.kind === "csv-preview" && result.csv) {
          this.csvFile = file;
          this.openMapper(result.csv);
          return;
        }
        if (result.kind === "plan" && result.plan) imported = result.plan;
        if (result.attachment) extra.push(result.attachment);
        if (result.message) warnings.push(result.message);
      } catch (err) {
        warnings.push(`${file.name}: ${(err as Error).message}`);
      }
    }

    if (imported) {
      this.writeImportedPlan(imported);
    } else if (extra.length) {
      this.toast(
        extra.map((a) => a.note || `${a.name} anexado só nesta sessão (ainda não é IfcDocumentReference).`).join(" "),
      );
    }

    if (warnings.length) this.toast(warnings.join(" "));
  }

  private nudgeZoom(dir: number): void {
    const i = ZOOM.indexOf(this.pxPerDay);
    const next = ZOOM[Math.max(0, Math.min(ZOOM.length - 1, (i < 0 ? 1 : i) + dir))];
    this.pxPerDay = next;
    this.renderBoard();
  }

  private render(): void {
    const empty = this.root.querySelector("[data-pane='empty']");
    const board = this.root.querySelector("[data-pane='board']");
    const has = !!this.plan;
    empty?.classList.toggle("is-hidden", has);
    board?.classList.toggle("is-hidden", !has);
    this.opts.onPlanChange?.(this.plan?.name ?? null);
    if (has) this.renderBoard();
    else this.renderEmpty();
  }

  private renderEmpty(): void {
    const schedule = this.opts.getIfcSchedule();
    const copy = this.el("empty-copy");
    const actions = this.el("empty-actions");
    if (copy) {
      copy.innerHTML = schedule?.roots.length
        ? `Este IFC já tem cronograma nativo (<strong>${escapeHtml(schedule.workPlanName || schedule.name)}</strong> · ${schedule.byId.size} IfcTask). Abra-o no Gantt, ou importe CSV/XML — as linhas viram IfcTask no ficheiro.`
        : this.opts.getSession()
          ? `Este IFC ainda não tem <strong>IfcWorkSchedule</strong>. Crie um cronograma no modelo ou importe CSV/XML para gravar IfcTask no STEP.`
          : `O Gantt edita o cronograma nativo do IFC. Importe um ficheiro <strong>.ifc</strong> primeiro; CSV/XML e tarefas novas gravam-se nesse modelo.`;
    }
    if (actions) {
      const hasIfc = !!schedule?.roots.length;
      actions.querySelector<HTMLButtonElement>("[data-act='from-ifc']")?.classList.toggle("btn-primary", hasIfc);
      actions.querySelector<HTMLButtonElement>("[data-act='from-ifc']")?.classList.toggle("btn-secondary", !hasIfc);
    }
  }

  private renderBoard(): void {
    const plan = this.plan;
    if (!plan) return;
    const title = this.root.querySelector<HTMLInputElement>("[data-el='title']");
    const meta = this.el("meta");
    if (title && title !== document.activeElement) title.value = plan.name;
    if (meta) {
      const n = plan.tasks.length;
      const sel = this.selectedIds.size;
      meta.textContent =
        sel > 1
          ? `${n} IfcTask · ${sel} selecionadas · ${formatDay(plan.minDate)} – ${formatDay(plan.maxDate)}`
          : `${n} IfcTask · ${formatDay(plan.minDate)} – ${formatDay(plan.maxDate)}`;
    }
    this.renderAttachments();
    this.renderTableAndChart();
  }

  private renderAttachments(): void {
    const box = this.el("attach");
    if (!box || !this.plan) return;
    if (this.plan.attachments.length === 0) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = this.plan.attachments
      .map(
        (a) => `
        <span class="pw-chip" title="${escapeHtml(a.note || a.name)}${a.size ? ` · ${formatBytes(a.size)}` : ""}">
          <em>${escapeHtml(a.name.split(".").pop()?.toUpperCase() || "IFC")}</em>
          <span>${escapeHtml(a.name)}</span>
        </span>`,
      )
      .join("");
  }

  private renderTableAndChart(): void {
    const plan = this.plan;
    if (!plan) return;
    const rows = visibleTasks(plan.tasks);
    const table = this.el("table-body");
    const chart = this.el("chart-body");
    const scale = this.el("scale");
    if (!table || !chart || !scale) return;

    const days = Math.max(1, diffDays(plan.minDate, plan.maxDate));
    const width = Math.max(640, days * this.pxPerDay);
    scale.innerHTML = this.timescaleHtml(plan, width);
    table.innerHTML = rows.map((t, i) => this.rowHtml(t, i)).join("");
    chart.innerHTML = `<div class="pw-chart-canvas" style="width:${width}px;height:${rows.length * ROW_H}px">${this.todayLine(plan, width)}${this.gridHtml(plan, width, rows.length)}${rows.map((t, i) => this.barHtml(t, i, plan)).join("")}</div>`;
    this.paintSelection();
  }

  private bindTableSplit(): void {
    const handle = this.el("gantt-split");
    const gantt = this.el("gantt");
    if (!handle || !gantt) return;
    const apply = (w: number) => {
      const next = Math.max(280, Math.min(960, w));
      gantt.style.setProperty("--pw-table-w", `${next}px`);
    };
    handle.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const startX = ev.clientX;
      const startW = gantt.querySelector(".pw-table")?.getBoundingClientRect().width ?? 420;
      handle.setPointerCapture(ev.pointerId);
      const onMove = (e: PointerEvent) => apply(startW + (e.clientX - startX));
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
    handle.addEventListener("dblclick", () => apply(560));
  }

  private rowHtml(task: PlanTask, _index: number): string {
    const selected = this.selectedIds.has(task.id) ? " is-selected" : "";
    const hit = task.linkedIfcTaskId != null && this.hitIfcIds.has(task.linkedIfcTaskId) ? " is-hit" : "";
    const pad = 8 + (task.outlineLevel - 1) * 14;
    const toggle = task.isSummary
      ? `<button type="button" class="pw-toggle${task.collapsed ? " is-collapsed" : ""}" data-act="toggle" aria-label="${task.collapsed ? "Expandir" : "Recolher"}">${ICON_TOGGLE}</button>`
      : `<span class="pw-toggle-ph"></span>`;
    const prod = task.linkedProductGuids.length;
    const sets = task.linkedGroupNames ?? [];
    return `
      <div class="pw-row${selected}${hit}${task.isSummary ? " is-summary" : ""}" data-id="${escapeHtml(task.id)}" data-ifc="${task.linkedIfcTaskId ?? ""}" style="height:${ROW_H}px">
        <span class="pw-col-wbs" title="${escapeAttr(task.wbs || "")}"><input data-field="wbs" value="${escapeAttr(task.wbs || "")}" spellcheck="false" aria-label="WBS / Identification" /></span>
        <span class="pw-col-name" style="padding-left:${pad}px">${toggle}
          <span class="pw-ifc-dot" title="IfcTask nativa"></span>
          <input data-field="name" value="${escapeAttr(task.name)}" spellcheck="false" title="${escapeAttr(task.name)}" />
        </span>
        <span class="pw-col-prod">${prod ? `<span class="pw-prod" title="${prod} elementos 3D">${prod}</span>` : ""}</span>
        <span class="pw-col-set">${
          sets.length
            ? `<span class="pw-set" title="Conjuntos IFC: ${escapeAttr(sets.join(", "))}">${escapeHtml(sets.join(", "))}</span>`
            : ""
        }</span>
        <span class="pw-col-dur"><input data-field="dur" type="number" min="0" step="0.5" value="${task.durationDays ?? ""}" aria-label="Duração em dias" /></span>
        <span class="pw-col-date"><input data-field="start" type="date" value="${task.start ? toInputDate(task.start) : ""}" aria-label="Início" /></span>
        <span class="pw-col-date"><input data-field="end" type="date" value="${task.end ? toInputDate(task.end) : ""}" aria-label="Término" /></span>
      </div>`;
  }

  private barHtml(task: PlanTask, index: number, plan: ProjectPlan): string {
    if (!task.start) return "";
    const left = diffDays(plan.minDate, task.start) * this.pxPerDay;
    const dur = Math.max(task.isMilestone ? 0 : (task.durationDays ?? (task.end ? diffDays(task.start, task.end) : 1)), 0);
    const top = index * ROW_H + (task.isSummary ? 12 : 8);
    if (task.isMilestone) {
      const hit = task.linkedIfcTaskId != null && this.hitIfcIds.has(task.linkedIfcTaskId) ? " is-hit" : "";
      return `<div class="pw-mile${hit}" data-id="${escapeHtml(task.id)}" data-ifc="${task.linkedIfcTaskId ?? ""}" style="left:${left}px;top:${index * ROW_H + 10}px" title="${escapeAttr(task.name)}"></div>`;
    }
    const w = Math.max(dur * this.pxPerDay, 6);
    const pct = Math.max(0, Math.min(100, task.progress));
    const kind = task.isSummary ? "summary" : barState(task);
    const hit = task.linkedIfcTaskId != null && this.hitIfcIds.has(task.linkedIfcTaskId) ? " is-hit" : "";
    return `<div class="pw-bar is-${kind}${hit}" data-id="${escapeHtml(task.id)}" data-ifc="${task.linkedIfcTaskId ?? ""}" style="left:${left}px;top:${top}px;width:${w}px" title="${escapeAttr(task.name)}">
      <i style="width:${pct}%"></i>
    </div>`;
  }

  private gridHtml(plan: ProjectPlan, width: number, rows: number): string {
    const lines: string[] = [];
    const cursor = new Date(plan.minDate.getFullYear(), plan.minDate.getMonth(), 1);
    if (cursor < plan.minDate) cursor.setMonth(cursor.getMonth() + 1);
    while (cursor <= plan.maxDate) {
      const x = diffDays(plan.minDate, cursor) * this.pxPerDay;
      if (x > 0 && x < width) {
        lines.push(`<span class="pw-grid-line" style="left:${x}px;height:${rows * ROW_H}px"></span>`);
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return lines.join("");
  }

  private todayLine(plan: ProjectPlan, width: number): string {
    const x = diffDays(plan.minDate, new Date()) * this.pxPerDay;
    if (x < 0 || x > width) return "";
    return `<div class="pw-today" style="left:${x}px"></div>`;
  }

  private timescaleHtml(plan: ProjectPlan, width: number): string {
    const months: string[] = [];
    const ticks: string[] = [];
    const cursor = new Date(plan.minDate);
    let monthStart = 0;
    let monthLabel = cursor.toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
    while (cursor <= plan.maxDate) {
      const x = diffDays(plan.minDate, cursor) * this.pxPerDay;
      const isMonth = cursor.getDate() === 1;
      if (isMonth && x > 0) {
        months.push(
          `<span class="pw-month" style="left:${monthStart}px;width:${x - monthStart}px">${escapeHtml(monthLabel)}</span>`,
        );
        monthStart = x;
        monthLabel = cursor.toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
      }
      const showDay = this.pxPerDay >= 22;
      if (showDay || isMonth || ticks.length === 0) {
        ticks.push(
          `<span class="pw-tick${isMonth ? " is-month" : ""}" style="left:${x}px">${showDay ? cursor.getDate() : isMonth || ticks.length === 0 ? cursor.toLocaleDateString("pt-BR", { month: "short" }) : ""}</span>`,
        );
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    months.push(
      `<span class="pw-month" style="left:${monthStart}px;width:${Math.max(0, width - monthStart)}px">${escapeHtml(monthLabel)}</span>`,
    );
    return `<div class="pw-scale-inner" style="width:${width}px"><div class="pw-scale-months">${months.join("")}</div><div class="pw-scale-days">${ticks.join("")}</div></div>`;
  }

  private clickMode(e: MouseEvent): "replace" | "toggle" | "range" {
    if (e.shiftKey) return "range";
    if (e.ctrlKey || e.metaKey) return "toggle";
    return "replace";
  }

  private setSelected(id: string | null, emit = true, mode: "replace" | "toggle" | "range" = "replace"): void {
    if (!id || !this.plan) {
      this.selectedId = null;
      this.selectedIds.clear();
      this.selectionAnchorId = null;
      this.paintSelection();
      if (emit) this.opts.onSelectTask?.(null);
      return;
    }
    if (mode === "toggle") {
      if (this.selectedIds.has(id) && this.selectedIds.size > 1) {
        this.selectedIds.delete(id);
        this.selectedId = [...this.selectedIds][this.selectedIds.size - 1] ?? null;
      } else {
        this.selectedIds.add(id);
        this.selectedId = id;
      }
      this.selectionAnchorId = id;
    } else if (mode === "range") {
      const vis = visibleTasks(this.plan.tasks);
      const anchor = this.selectionAnchorId ?? this.selectedId ?? id;
      const a = vis.findIndex((t) => t.id === anchor);
      const b = vis.findIndex((t) => t.id === id);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        this.selectedIds = new Set(vis.slice(lo, hi + 1).map((t) => t.id));
      } else {
        this.selectedIds = new Set([id]);
      }
      this.selectedId = id;
    } else {
      this.selectedIds = new Set([id]);
      this.selectedId = id;
      this.selectionAnchorId = id;
    }
    this.paintSelection();
    if (emit) this.opts.onSelectTask?.(this.getSelected());
    const meta = this.el("meta");
    if (meta && this.plan) {
      const n = this.plan.tasks.length;
      const sel = this.selectedIds.size;
      meta.textContent =
        sel > 1
          ? `${n} IfcTask · ${sel} selecionadas · ${formatDay(this.plan.minDate)} – ${formatDay(this.plan.maxDate)}`
          : `${n} IfcTask · ${formatDay(this.plan.minDate)} – ${formatDay(this.plan.maxDate)}`;
    }
  }

  private paintHits(): void {
    this.root.querySelectorAll<HTMLElement>("[data-ifc]").forEach((el) => {
      const ifc = Number(el.dataset.ifc);
      el.classList.toggle("is-hit", Number.isFinite(ifc) && this.hitIfcIds.has(ifc));
    });
  }

  private paintSelection(): void {
    this.root.querySelectorAll(".pw-row, .pw-bar, .pw-mile").forEach((el) => {
      el.classList.toggle("is-selected", this.selectedIds.has((el as HTMLElement).dataset.id || ""));
    });
  }

  private onGanttKey(e: KeyboardEvent): void {
    const inField = (e.target as HTMLElement).matches("input, textarea, select");
    if (e.key === "Enter" && inField) {
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === "Delete" && this.selectedIds.size && !inField) {
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !inField && this.plan) {
      e.preventDefault();
      const vis = visibleTasks(this.plan.tasks);
      this.selectedIds = new Set(vis.map((t) => t.id));
      this.selectedId = vis[0]?.id ?? null;
      this.paintSelection();
      this.opts.onSelectTask?.(this.getSelected());
      return;
    }
    const inGantt = !!(e.target as HTMLElement).closest(".pw-gantt");
    const indentKey =
      (e.altKey && e.shiftKey && e.key === "ArrowRight") ||
      (!inField && inGantt && e.key === "Tab" && !e.shiftKey);
    const outdentKey =
      (e.altKey && e.shiftKey && e.key === "ArrowLeft") ||
      (!inField && inGantt && e.key === "Tab" && e.shiftKey);
    if (indentKey) {
      e.preventDefault();
      this.changeOutline(1);
      return;
    }
    if (outdentKey) {
      e.preventDefault();
      this.changeOutline(-1);
    }
  }

  private changeOutline(dir: 1 | -1): void {
    if (!this.plan || !this.selectedIds.size) return;
    const moved = dir === 1 ? indentTasks(this.plan.tasks, this.selectedIds) : outdentTasks(this.plan.tasks, this.selectedIds);
    if (!moved.length) {
      this.toast(dir === 1 ? "Não é possível rebaixar a seleção." : "Não é possível subir a seleção.");
      return;
    }
    const ids = moved.map((i) => this.plan!.tasks[i].id);
    this.persistOutline(ids);
    this.renderBoard();
  }

  private persistOutline(movedRootIds: string[]): void {
    const plan = this.plan;
    if (!plan) return;
    try {
      for (const id of movedRootIds) {
        const idx = plan.tasks.findIndex((t) => t.id === id);
        if (idx < 0) continue;
        const resolved = this.native(plan.tasks[idx]!.linkedIfcTaskId);
        if (!resolved || resolved.nativeId <= 0) continue;
        const pIdx = outlineParentIndex(plan.tasks, idx);
        const sIdx = outlinePrevSiblingIndex(plan.tasks, idx);
        const parent = pIdx >= 0 ? this.native(plan.tasks[pIdx]!.linkedIfcTaskId) : null;
        const after = sIdx >= 0 ? this.native(plan.tasks[sIdx]!.linkedIfcTaskId) : null;
        if (parent && parent.session !== resolved.session) {
          this.toast("Não é possível aninhar tarefas de IFCs diferentes.");
          continue;
        }
        resolved.session.reparentTask(
          resolved.nativeId,
          parent?.nativeId,
          after?.session === resolved.session ? after.nativeId : undefined,
        );
      }
      for (const [id, wbs] of rebuildWbs(plan.tasks)) {
        const task = plan.tasks.find((t) => t.id === id);
        const resolved = this.native(task?.linkedIfcTaskId);
        if (resolved && resolved.nativeId > 0) resolved.session.applyTaskEdit(resolved.nativeId, { identification: wbs });
      }
      this.opts.onNativeChange?.({ structure: true });
    } catch (err) {
      this.toast((err as Error).message);
    }
  }

  private openMapper(insp: CsvInspection): void {
    this.csvDraft = insp;
    this.renderMapper();
    this.el("mapper")?.classList.remove("is-hidden");
  }

  private renderMapper(): void {
    const panel = this.el("mapper");
    const insp = this.csvDraft;
    if (!panel || !insp) return;
    const map = insp.guessed;
    const colOptions = (selected?: number) => {
      const opts = [`<option value="">— ignorar —</option>`];
      insp.headers.forEach((h, i) => {
        const sample = sampleCell(insp, i);
        const label = sample ? `${h}  ·  ${sample}` : h;
        opts.push(`<option value="${i}" ${selected === i ? "selected" : ""}>${escapeHtml(label)}</option>`);
      });
      return opts.join("");
    };
    const previewRows = mappedPreview(insp, map).slice(0, 6);
    panel.innerHTML = `
      <div class="pw-sync-card pw-map-card">
        <header>
          <h3 id="pw-map-title">Mapear colunas</h3>
          <button type="button" class="pw-sync-close" data-act="close" aria-label="Fechar">×</button>
        </header>
        <p class="pw-sync-lead"><strong>${escapeHtml(insp.fileName)}</strong> · ${insp.dataRowCount} linhas · delimitador «${escapeHtml(insp.delimiter === "\t" ? "tab" : insp.delimiter)}». Cada linha vira <strong>IfcTask</strong> no modelo aberto (WBS → Identification, datas → IfcTaskTime).</p>
        <label class="pw-map-check">
          <input type="checkbox" data-act="header" ${insp.hasHeader ? "checked" : ""} />
          A primeira linha é o cabeçalho
        </label>
        <div class="pw-map-fields">
          ${CSV_FIELDS.map(
            (f) => `
            <label class="pw-map-field">
              <span>${escapeHtml(f.label)}${f.required ? " *" : ""}</span>
              <select data-field="${f.key}">${colOptions(map[f.key])}</select>
              <small>${escapeHtml(f.hint)}</small>
            </label>`,
          ).join("")}
        </div>
        <h4 class="pw-map-preview-title">Pré-visualização</h4>
        <div class="pw-map-preview">
          <table>
            <thead><tr><th>Nome</th><th>Item</th><th>Início</th><th>Término</th></tr></thead>
            <tbody>
              ${
                previewRows.length
                  ? previewRows
                      .map(
                        (r) =>
                          `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.wbs)}</td><td>${escapeHtml(r.start)}</td><td>${escapeHtml(r.end)}</td></tr>`,
                      )
                      .join("")
                  : `<tr><td colspan="4">Nada para pré-visualizar — escolha a coluna do nome.</td></tr>`
              }
            </tbody>
          </table>
        </div>
        <div class="pw-sync-actions">
          <button type="button" class="btn-primary" data-act="apply" ${map.name == null ? "disabled" : ""}>Gravar no IFC</button>
          <button type="button" class="btn-secondary" data-act="close">Cancelar</button>
        </div>
      </div>`;
  }

  private onMapperClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("pw-sync")) {
      this.closeMapper();
      return;
    }
    const act = target.closest("[data-act]")?.getAttribute("data-act");
    if (act === "close") this.closeMapper();
    if (act === "apply") this.commitMapper();
  };

  private onMapperChange = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (!this.csvDraft) return;
    if (target.getAttribute("data-act") === "header" && target instanceof HTMLInputElement) {
      this.csvDraft = reinspect(this.csvDraft, target.checked);
      this.renderMapper();
      return;
    }
    const select = target.closest("select[data-field]") as HTMLSelectElement | null;
    if (!select) return;
    const key = select.dataset.field as CsvField;
    const value = select.value === "" ? undefined : Number(select.value);
    this.csvDraft.guessed = { ...this.csvDraft.guessed, [key]: value };
    this.renderMapper();
  };

  private commitMapper(): void {
    if (!this.csvDraft) return;
    if (!this.opts.getSession()) {
      this.toast("Abra um IFC antes de gravar o CSV no cronograma nativo.");
      this.opts.onRequestIfcImport();
      return;
    }
    try {
      const plan = planFromMappedCsv(this.csvDraft, this.csvDraft.guessed);
      if (this.csvFile) plan.attachments.push(fileToAttachment(this.csvFile, "schedule"));
      this.closeMapper();
      this.writeImportedPlan(plan);
    } catch (err) {
      this.toast((err as Error).message);
    }
  }

  private closeMapper(): void {
    this.el("mapper")?.classList.add("is-hidden");
    this.csvDraft = null;
    this.csvFile = null;
  }

  private toast(msg: string): void {
    const el = this.el("toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 5200);
  }

  private el(name: string): HTMLElement | null {
    return this.root.querySelector(`[data-el="${name}"]`);
  }
}

function mappedPreview(
  insp: CsvInspection,
  map: ColMap,
): Array<{ name: string; wbs: string; start: string; end: string }> {
  return insp.preview.map((row) => ({
    name: (row[map.name ?? -1] ?? "").trim() || "—",
    wbs: (row[map.wbs ?? -1] ?? "").trim(),
    start: (row[map.start ?? -1] ?? "").trim(),
    end: (row[map.end ?? -1] ?? "").trim(),
  }));
}

function barState(task: PlanTask): string {
  if (!task.start || !task.end) return "pending";
  const today = new Date();
  if (today < task.start) return "pending";
  if (today > task.end) return "done";
  return "active";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
