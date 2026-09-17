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
import type { PlanPredecessor, PlanTask, ProjectPlan } from "../projectPlan/types";
import type { IfcSession, SequenceType, TaskPatch } from "../ifc/ifcSession";
import { DND_GROUP, DND_GUIDS, clearDrops, getDragJson, hasType, isFileDrag, markDrop } from "./dnd";
import {
  cascadeDates,
  clampToPredecessors,
  formatPredecessors,
  parsePredecessorList,
  resolvePredecessorToken,
  wouldCreateCycle,
} from "../schedule/links";

const ZOOM = [8, 14, 22, 32];
const ROW_H = 36;
const ICON_TOGGLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_OUTDENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 7h11M9 12h11M9 17h7" stroke-linecap="round"/><path d="M6 9L3 12l3 3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_INDENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h11M4 12h11M4 17h7" stroke-linecap="round"/><path d="M18 9l3 3-3 3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_LINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9.5 14.5l5-5" stroke-linecap="round"/><rect x="3.5" y="12.5" width="8" height="6" rx="1.2"/><rect x="12.5" y="5.5" width="8" height="6" rx="1.2"/></svg>`;
const ICON_UNLINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9.5 14.5l2-2M14.5 9.5l-2 2" stroke-linecap="round"/><rect x="3.5" y="12.5" width="8" height="6" rx="1.2"/><rect x="12.5" y="5.5" width="8" height="6" rx="1.2"/></svg>`;

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
  onDropGuids?: (ifcTaskId: number, guids: string[]) => void;
  onDropGroup?: (ifcTaskId: number, groupId: number) => void;
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
  private virtRaf = 0;
  private virtFrom = -1;
  private virtTo = -1;
  private virtCount = -1;
  private virtViewH = 0;
  private syncingScroll = false;
  private selectedLink: { pred: string; succ: string } | null = null;
  private suppressChartClick = false;

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
          <h3>Gantt</h3>
          <p data-el="empty-copy" class="sr-only"></p>
          <div class="pw-empty-actions" data-el="empty-actions">
            <button type="button" class="btn-primary" data-act="from-ifc">IFC</button>
            <button type="button" class="btn-secondary" data-act="import">CSV</button>
            <button type="button" class="btn-secondary" data-act="new">Novo</button>
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
            <button type="button" class="btn-primary" data-act="add">+</button>
            <button type="button" class="btn-secondary" data-act="model" aria-pressed="false" title="Pré-visualização BIM para ligar elementos">3D</button>
            <button type="button" class="btn-secondary pw-act-wide" data-act="from-ifc">IFC</button>
            <button type="button" class="btn-ghost pw-act-wide" data-act="import">CSV</button>
            <div class="pw-overflow">
              <button type="button" class="icon-btn-plain pw-overflow-btn" data-act="more" aria-label="Mais ações" aria-haspopup="true" title="Mais ações">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></svg>
              </button>
              <div class="pw-overflow-menu" hidden data-el="more-menu">
                <button type="button" data-act="outdent">Subir</button>
                <button type="button" data-act="indent">Descer</button>
                <button type="button" data-act="link">Ligar</button>
                <button type="button" data-act="unlink">Desligar</button>
                <button type="button" data-act="model">Pré-visualização 3D</button>
                <button type="button" data-act="from-ifc">IFC</button>
                <button type="button" data-act="import">CSV</button>
              </div>
            </div>
            <div class="pw-eap" role="group" aria-label="Nível da EAP">
              <button type="button" class="pw-zoom-btn" data-act="outdent" title="Subir nível da EAP (Alt+Shift+←)" aria-label="Subir nível da EAP">${ICON_OUTDENT}</button>
              <button type="button" class="pw-zoom-btn" data-act="indent" title="Rebaixar nível da EAP (Alt+Shift+→)" aria-label="Rebaixar nível da EAP">${ICON_INDENT}</button>
            </div>
            <div class="pw-eap" role="group" aria-label="Ligações">
              <button type="button" class="pw-zoom-btn" data-act="link" title="Ligar tarefas (Ctrl+L) — Finish-to-Start" aria-label="Ligar tarefas">${ICON_LINK}</button>
              <button type="button" class="pw-zoom-btn" data-act="unlink" title="Desligar tarefas (Ctrl+Shift+L)" aria-label="Desligar tarefas">${ICON_UNLINK}</button>
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
              <span class="pw-col-pred">Pred.</span>
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
      <div class="pw-link-pop" data-el="link-pop" hidden>
        <label>Tipo
          <select data-el="link-type" aria-label="Tipo de ligação">
            <option value="FS">Término → Início (FS)</option>
            <option value="SS">Início → Início (SS)</option>
            <option value="FF">Término → Término (FF)</option>
            <option value="SF">Início → Término (SF)</option>
          </select>
        </label>
        <label>Folga (d)
          <input data-el="link-lag" type="number" step="1" aria-label="Folga em dias" />
        </label>
        <button type="button" class="btn-ghost" data-act="link-del">Remover</button>
      </div>
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
      if (act === "link") this.linkSelected();
      if (act === "unlink") this.unlinkSelected();
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
      if (!isFileDrag(e)) return;
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
      if (!isFileDrag(e)) return;
      e.preventDefault();
      this.root.classList.remove("is-drop-target");
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void this.importFiles(files);
    });
  }

  private bindGantt(): void {
    const table = this.el("table-body");
    const chart = this.el("chart-body");
    table?.addEventListener(
      "scroll",
      () => {
        if (this.syncingScroll) return;
        this.syncingScroll = true;
        if (chart) chart.scrollTop = table.scrollTop;
        this.syncingScroll = false;
        this.scheduleVirtualWindow();
      },
      { passive: true },
    );
    chart?.addEventListener(
      "scroll",
      () => {
        if (this.syncingScroll) return;
        this.syncingScroll = true;
        if (table) table.scrollTop = chart.scrollTop;
        const scale = this.el("scale");
        if (scale) scale.scrollLeft = chart.scrollLeft;
        this.syncingScroll = false;
        this.scheduleVirtualWindow();
      },
      { passive: true },
    );
    if (table && typeof ResizeObserver !== "undefined") {
      let lastH = table.clientHeight;
      new ResizeObserver(() => {
        const h = table.clientHeight;
        if (Math.abs(h - lastH) < 2) return;
        lastH = h;
        this.scheduleVirtualWindow();
      }).observe(table);
    }

    const hover = (id: string | null) => {
      this.root.querySelectorAll(".is-hover").forEach((el) => el.classList.remove("is-hover"));
      if (!id) return;
      this.root.querySelectorAll(`.pw-row[data-id="${cssEscape(id)}"], .pw-bar[data-id="${cssEscape(id)}"], .pw-mile[data-id="${cssEscape(id)}"]`).forEach((el) => {
        el.classList.add("is-hover");
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
      if (this.suppressChartClick) {
        this.suppressChartClick = false;
        return;
      }
      const link = (e.target as HTMLElement).closest<SVGElement>("[data-pred]");
      if (link?.dataset.pred && link.dataset.succ) {
        this.openLinkEditor(link.dataset.pred, link.dataset.succ, e.clientX, e.clientY);
        return;
      }
      const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (!hit) {
        this.closeLinkEditor();
        return;
      }
      this.closeLinkEditor();
      this.setSelected(hit.dataset.id!, true, this.clickMode(e));
    });

    this.bindBarDrag(chart);
    this.bindLinkPop();
    this.bindTaskDrop(table, chart);

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
      if (field === "pred") {
        this.applyPredecessorText(task, input.value);
        return;
      }
      if (field === "dur") {
        applyDuration(task, Number(input.value) || 0);
        this.commitDateEdit(task);
        return;
      }
      if (field === "start") {
        const d = fromInputDate(input.value);
        if (d) applyStart(task, d);
        this.commitDateEdit(task);
        return;
      }
      if (field === "end") {
        const d = fromInputDate(input.value);
        if (d) applyEnd(task, d);
        this.commitDateEdit(task);
        return;
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
    if (has) {
      this.renderBoard();
      this.scheduleVirtualWindow();
    } else this.renderEmpty();
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

  private scheduleVirtualWindow(): void {
    if (this.virtRaf) return;
    this.virtRaf = requestAnimationFrame(() => {
      this.virtRaf = 0;
      this.renderTableAndChart(true);
    });
  }

  private renderTableAndChart(keepWindow = false): void {
    const plan = this.plan;
    if (!plan) return;
    const rows = visibleTasks(plan.tasks);
    const table = this.el("table-body");
    const chart = this.el("chart-body");
    const scale = this.el("scale");
    if (!table || !chart || !scale) return;

    const days = Math.max(1, diffDays(plan.minDate, plan.maxDate));
    const width = Math.max(640, days * this.pxPerDay);
    const scrollTop = table.scrollTop;
    const viewH = table.clientHeight || 480;
    const viewStart = Math.max(0, Math.floor(scrollTop / ROW_H));
    const viewEnd = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H));
    if (
      keepWindow &&
      this.virtCount === rows.length &&
      viewH <= this.virtViewH + 2 &&
      viewStart >= this.virtFrom &&
      viewEnd <= this.virtTo
    ) {
      this.paintSelection();
      this.paintHits();
      return;
    }
    const overscan = 28;
    const start = Math.max(0, viewStart - overscan);
    const end = Math.min(rows.length, viewEnd + overscan);
    this.virtFrom = start;
    this.virtTo = end;
    this.virtCount = rows.length;
    this.virtViewH = viewH;
    const slice = rows.slice(start, end);
    const height = Math.max(ROW_H, rows.length * ROW_H);

    if (!keepWindow) scale.innerHTML = this.timescaleHtml(plan, width);
    const tableHost = this.ensureVirtHost(table, "pw-table-virt");
    const chartHost = this.ensureVirtHost(chart, "pw-chart-virt");
    this.paintTableWindow(tableHost, slice, start, height);
    chartHost.innerHTML = `<div class="pw-chart-canvas" style="width:${width}px;height:${height}px">${this.todayLine(plan, width)}${this.gridHtml(plan, width, rows.length)}${this.linksSvg(plan, rows, width, height)}${slice.map((t, i) => this.barHtml(t, start + i, plan)).join("")}</div>`;
    if (Math.abs(chart.scrollTop - scrollTop) > 0.5) {
      this.syncingScroll = true;
      chart.scrollTop = scrollTop;
      this.syncingScroll = false;
    }
    this.paintSelection();
    this.paintHits();
  }

  private paintTableWindow(host: HTMLElement, slice: PlanTask[], start: number, height: number): void {
    let spacer = host.querySelector<HTMLElement>(".pw-table-spacer");
    let windowEl = host.querySelector<HTMLElement>(".pw-table-window");
    if (!spacer || !windowEl) {
      host.innerHTML = `<div class="pw-table-spacer"></div><div class="pw-table-window"></div>`;
      spacer = host.querySelector(".pw-table-spacer");
      windowEl = host.querySelector(".pw-table-window");
    }
    if (!spacer || !windowEl) return;
    if (spacer.style.height !== `${height}px`) spacer.style.height = `${height}px`;
    windowEl.style.transform = `translateY(${start * ROW_H}px)`;
    windowEl.innerHTML = slice.map((t, i) => this.rowHtml(t, start + i)).join("");
  }

  private ensureVirtHost(scrollEl: HTMLElement, className: string): HTMLElement {
    const first = scrollEl.firstElementChild as HTMLElement | null;
    if (first?.classList.contains(className)) return first;
    const host = document.createElement("div");
    host.className = className;
    scrollEl.replaceChildren(host);
    return host;
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
      const startW = gantt.querySelector(".pw-table")?.getBoundingClientRect().width ?? 540;
      handle.setPointerCapture(ev.pointerId);
      const onMove = (e: PointerEvent) => apply(startW + (e.clientX - startX));
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
    handle.addEventListener("dblclick", () => apply(640));
  }

  private bindBarDrag(chart: HTMLElement | null): void {
    if (!chart) return;
    chart.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (ev.button !== 0 || !this.plan) return;
      const target = ev.target as HTMLElement;
      if (target.closest("[data-pred]")) return;
      const handle = target.closest<HTMLElement>("[data-handle]");
      const grip = target.closest<HTMLElement>("[data-link]");
      const bar = target.closest<HTMLElement>(".pw-bar, .pw-mile");
      if (grip && bar) {
        this.beginLinkDraw(ev, bar, grip.dataset.link === "start" ? "start" : "end");
        return;
      }
      if (!bar) return;
      const task = this.plan.tasks.find((t) => t.id === bar.dataset.id);
      if (!task?.start || task.isSummary) return;
      if (handle && !task.isMilestone) {
        this.beginBarResize(ev, bar, task, handle.dataset.handle === "start" ? "start" : "end");
        return;
      }
      this.beginBarMove(ev, bar, task);
    });
  }

  private beginBarMove(ev: PointerEvent, bar: HTMLElement, task: PlanTask): void {
    const startX = ev.clientX;
    const orig = task.start!;
    let days = 0;
    let moved = false;
    bar.classList.add("is-dragging");
    bar.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    const onMove = (e: PointerEvent) => {
      days = Math.round((e.clientX - startX) / this.pxPerDay);
      if (Math.abs(e.clientX - startX) < 4 && !moved) return;
      moved = true;
      bar.style.transform = `translateX(${days * this.pxPerDay}px)`;
    };
    const onUp = () => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.classList.remove("is-dragging");
      bar.style.transform = "";
      if (!moved) return;
      this.suppressChartClick = true;
      applyStart(task, addDays(orig, days));
      this.commitDateEdit(task);
    };
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
  }

  private beginBarResize(ev: PointerEvent, bar: HTMLElement, task: PlanTask, edge: "start" | "end"): void {
    const startX = ev.clientX;
    const origStart = task.start!;
    const origEnd = task.end ?? addDays(origStart, task.durationDays ?? 1);
    const origLeft = Number.parseFloat(bar.style.left) || 0;
    let moved = false;
    bar.classList.add("is-resizing");
    bar.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    const onMove = (e: PointerEvent) => {
      const days = Math.round((e.clientX - startX) / this.pxPerDay);
      if (Math.abs(e.clientX - startX) < 3 && !moved) return;
      moved = true;
      if (edge === "end") {
        const next = Math.max(0, diffDays(origStart, addDays(origEnd, days)));
        bar.style.width = `${Math.max(6, next * this.pxPerDay)}px`;
      } else {
        const nextStart = addDays(origStart, days);
        if (nextStart > origEnd) return;
        const next = Math.max(0, diffDays(nextStart, origEnd));
        bar.style.left = `${origLeft + days * this.pxPerDay}px`;
        bar.style.width = `${Math.max(6, next * this.pxPerDay)}px`;
      }
    };
    const onUp = (e: PointerEvent) => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.classList.remove("is-resizing");
      if (!moved) return;
      this.suppressChartClick = true;
      const days = Math.round((e.clientX - startX) / this.pxPerDay);
      if (edge === "end") applyEnd(task, addDays(origEnd, days));
      else {
        const nextStart = addDays(origStart, days);
        applyStartKeepEnd(task, nextStart > origEnd ? origEnd : nextStart, origEnd);
      }
      this.commitDateEdit(task);
    };
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
  }

  private beginLinkDraw(ev: PointerEvent, fromBar: HTMLElement, fromSide: "start" | "end"): void {
    const fromId = fromBar.dataset.id;
    if (!fromId || !this.plan) return;
    const canvas = fromBar.closest(".pw-chart-canvas") ?? fromBar.parentElement;
    if (!canvas) return;
    const rubber = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    rubber.classList.add("pw-rubber");
    const cw = (canvas as HTMLElement).offsetWidth;
    const ch = (canvas as HTMLElement).offsetHeight;
    rubber.setAttribute("width", String(cw));
    rubber.setAttribute("height", String(ch));
    rubber.setAttribute("viewBox", `0 0 ${cw} ${ch}`);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "pw-rubber-line");
    rubber.appendChild(line);
    canvas.appendChild(rubber);
    const origin = canvas.getBoundingClientRect();
    const fromRect = fromBar.getBoundingClientRect();
    const x1 = (fromSide === "start" ? fromRect.left : fromRect.right) - origin.left;
    const y1 = fromRect.top + fromRect.height / 2 - origin.top;
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x1));
    line.setAttribute("y2", String(y1));
    fromBar.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    let moved = false;
    const onMove = (e: PointerEvent) => {
      moved = moved || Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) > 4;
      const live = canvas.getBoundingClientRect();
      line.setAttribute("x2", String(e.clientX - live.left));
      line.setAttribute("y2", String(e.clientY - live.top));
      canvas.querySelectorAll(".is-link-target").forEach((el) => el.classList.remove("is-link-target"));
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".pw-bar, .pw-mile");
      if (hit && hit.dataset.id !== fromId) hit.classList.add("is-link-target");
    };
    const onUp = (e: PointerEvent) => {
      fromBar.removeEventListener("pointermove", onMove);
      fromBar.removeEventListener("pointerup", onUp);
      rubber.remove();
      canvas.querySelectorAll(".is-link-target").forEach((el) => el.classList.remove("is-link-target"));
      if (!moved) return;
      this.suppressChartClick = true;
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".pw-bar, .pw-mile");
      const toId = hit?.dataset.id;
      if (!toId || toId === fromId) return;
      const hitRect = hit.getBoundingClientRect();
      const toSide: "start" | "end" = e.clientX < hitRect.left + hitRect.width / 2 ? "start" : "end";
      const type = sequenceFromSides(fromSide, toSide);
      this.connectTasks(fromId, toId, type);
    };
    fromBar.addEventListener("pointermove", onMove);
    fromBar.addEventListener("pointerup", onUp);
  }

  private bindLinkPop(): void {
    const pop = this.el("link-pop");
    if (!pop) return;
    pop.addEventListener("change", () => {
      if (!this.selectedLink || !this.plan) return;
      const type = (this.el("link-type") as HTMLSelectElement | null)?.value as SequenceType;
      const lag = Number((this.el("link-lag") as HTMLInputElement | null)?.value || 0);
      this.connectTasks(this.selectedLink.pred, this.selectedLink.succ, type || "FS", lag);
    });
    pop.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-act='link-del']") && this.selectedLink) {
        this.disconnectTasks(this.selectedLink.pred, this.selectedLink.succ);
        this.closeLinkEditor();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!pop.hidden && !pop.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-pred]")) {
        this.closeLinkEditor();
      }
    });
  }

  private bindTaskDrop(table: HTMLElement | null, chart: HTMLElement | null): void {
    const onOver = (e: DragEvent) => {
      if (!hasType(e, DND_GUIDS) && !hasType(e, DND_GROUP)) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (!row) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      const root = e.currentTarget as HTMLElement;
      clearDrops(root);
      markDrop(row, true);
    };
    const onLeave = (e: DragEvent) => {
      const root = e.currentTarget as HTMLElement;
      const next = e.relatedTarget as Node | null;
      if (next && root.contains(next)) return;
      clearDrops(root);
    };
    const onDrop = (e: DragEvent) => {
      const root = e.currentTarget as HTMLElement;
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      clearDrops(root);
      const task = this.plan?.tasks.find((t) => t.id === row?.dataset.id);
      if (!task) return;
      const ifcId = task.linkedIfcTaskId;
      const resolved = this.native(ifcId);
      if (ifcId == null || !resolved || resolved.nativeId === 0) return;
      const guids = getDragJson<string[]>(e.dataTransfer, DND_GUIDS);
      if (guids?.length) {
        e.preventDefault();
        this.setSelected(task.id, true, "replace");
        this.opts.onDropGuids?.(ifcId, guids);
        return;
      }
      const groupId = getDragJson<number>(e.dataTransfer, DND_GROUP);
      if (groupId != null) {
        e.preventDefault();
        this.setSelected(task.id, true, "replace");
        this.opts.onDropGroup?.(ifcId, groupId);
      }
    };
    for (const el of [table, chart]) {
      el?.addEventListener("dragover", onOver);
      el?.addEventListener("dragleave", onLeave);
      el?.addEventListener("drop", onDrop);
    }
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
        <span class="pw-col-pred"><input data-field="pred" value="${escapeAttr(this.plan ? formatPredecessors(task, this.plan.tasks) : "")}" spellcheck="false" aria-label="Predecessores" title="Ex. 3FS+2d" /></span>
        <span class="pw-col-date"><input data-field="start" type="date" value="${task.start ? toInputDate(task.start) : ""}" aria-label="Início" /></span>
        <span class="pw-col-date"><input data-field="end" type="date" value="${task.end ? toInputDate(task.end) : ""}" aria-label="Término" /></span>
      </div>`;
  }

  private barHtml(task: PlanTask, index: number, plan: ProjectPlan): string {
    if (!task.start && !task.end) return "";
    const start = task.start ?? task.end!;
    const left = diffDays(plan.minDate, start) * this.pxPerDay;
    const dur = Math.max(
      task.isMilestone ? 0 : (task.durationDays ?? (task.end ? diffDays(start, task.end) : 1)),
      0,
    );
    const top = index * ROW_H + (task.isSummary ? 12 : 8);
    if (task.isMilestone) {
      const hit = task.linkedIfcTaskId != null && this.hitIfcIds.has(task.linkedIfcTaskId) ? " is-hit" : "";
      return `<div class="pw-mile${hit}" data-id="${escapeHtml(task.id)}" data-ifc="${task.linkedIfcTaskId ?? ""}" style="left:${left}px;top:${index * ROW_H + 10}px" title="${escapeAttr(task.name)}">
        <span class="pw-bar-link is-start" data-link="start"></span>
        <span class="pw-bar-link is-end" data-link="end"></span>
      </div>`;
    }
    const w = Math.max(dur * this.pxPerDay, 6);
    const pct = Math.max(0, Math.min(100, task.progress));
    const kind = task.isSummary ? "summary" : barState(task);
    const hit = task.linkedIfcTaskId != null && this.hitIfcIds.has(task.linkedIfcTaskId) ? " is-hit" : "";
    const handles = task.isSummary
      ? ""
      : `<span class="pw-bar-handle is-start" data-handle="start"></span><span class="pw-bar-handle is-end" data-handle="end"></span>`;
    return `<div class="pw-bar is-${kind}${hit}" data-id="${escapeHtml(task.id)}" data-ifc="${task.linkedIfcTaskId ?? ""}" style="left:${left}px;top:${top}px;width:${w}px" title="${escapeAttr(task.name)}">
      <span class="pw-bar-link is-start" data-link="start" title="Arrastar para ligar (início)"></span>
      ${handles}
      <i style="width:${pct}%"></i>
      <span class="pw-bar-link is-end" data-link="end" title="Arrastar para ligar (término)"></span>
    </div>`;
  }

  private linksSvg(plan: ProjectPlan, rows: PlanTask[], width: number, height: number): string {
    const indexById = new Map(rows.map((t, i) => [t.id, i]));
    const parts: string[] = [];
    for (const succ of rows) {
      const si = indexById.get(succ.id);
      if (si == null || !succ.start) continue;
      for (const pred of succ.predecessors) {
        const predTask = plan.tasks.find((t) => t.id === pred.id);
        const pi = indexById.get(pred.id);
        if (!predTask?.start || pi == null) continue;
        const fromSide: "start" | "end" = pred.type === "SS" || pred.type === "SF" ? "start" : "end";
        const toSide: "start" | "end" = pred.type === "FS" || pred.type === "SS" ? "start" : "end";
        const a = barAnchor(predTask, plan, pi, this.pxPerDay, fromSide);
        const b = barAnchor(succ, plan, si, this.pxPerDay, toSide);
        const d = sequencePath(a.x, a.y, fromSide, b.x, b.y, toSide);
        const on = this.selectedLink?.pred === pred.id && this.selectedLink?.succ === succ.id ? " is-selected" : "";
        const lag = pred.lagDays ? ` ${pred.lagDays > 0 ? "+" : ""}${pred.lagDays}d` : "";
        parts.push(
          `<path class="pw-link-hit" data-pred="${escapeHtml(pred.id)}" data-succ="${escapeHtml(succ.id)}" d="${d}" />` +
            `<path class="pw-link${on}" data-pred="${escapeHtml(pred.id)}" data-succ="${escapeHtml(succ.id)}" d="${d}">` +
            `<title>${escapeHtml(predTask.name)} → ${escapeHtml(succ.name)} · ${pred.type}${lag}</title></path>`,
        );
      }
    }
    if (!parts.length) return "";
    return `<svg class="pw-links" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <marker id="pw-arr" viewBox="0 0 8 8" markerWidth="5" markerHeight="5" refX="7" refY="4" orient="auto">
          <path d="M0 1.2 L8 4 L0 6.8 Z" fill="#5f7379"></path>
        </marker>
        <marker id="pw-arr-on" viewBox="0 0 8 8" markerWidth="5" markerHeight="5" refX="7" refY="4" orient="auto">
          <path d="M0 1.2 L8 4 L0 6.8 Z" fill="var(--accent)"></path>
        </marker>
      </defs>
      ${parts.join("")}
    </svg>`;
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
    const showDay = this.pxPerDay >= 22;
    const showWeek = this.pxPerDay >= 10 && !showDay;
    const stepDays = showDay ? 1 : showWeek ? 7 : 32;

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
      if (showDay || isMonth || ticks.length === 0 || (showWeek && cursor.getDay() === 1)) {
        ticks.push(
          `<span class="pw-tick${isMonth ? " is-month" : ""}" style="left:${x}px">${showDay ? cursor.getDate() : isMonth || ticks.length === 0 ? cursor.toLocaleDateString("pt-BR", { month: "short" }) : ""}</span>`,
        );
      }
      if (stepDays >= 32) {
        cursor.setMonth(cursor.getMonth() + 1);
        cursor.setDate(1);
      } else {
        cursor.setDate(cursor.getDate() + (showDay ? 1 : 1));
        if (showWeek && !isMonth && cursor.getDay() !== 1 && cursor.getDate() !== 1) {
          const toMon = (8 - cursor.getDay()) % 7;
          if (toMon) cursor.setDate(cursor.getDate() + toMon);
        }
      }
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
    this.root.querySelectorAll<SVGElement>("[data-pred]").forEach((el) => {
      const on = this.selectedLink?.pred === el.dataset.pred && this.selectedLink?.succ === el.dataset.succ;
      el.classList.toggle("is-selected", on);
    });
  }

  private onGanttKey(e: KeyboardEvent): void {
    const inField = (e.target as HTMLElement).matches("input, textarea, select");
    if (e.key === "Enter" && inField) {
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === "Delete" && this.selectedLink && !inField) {
      e.preventDefault();
      this.disconnectTasks(this.selectedLink.pred, this.selectedLink.succ);
      this.closeLinkEditor();
      return;
    }
    if (e.key === "Delete" && this.selectedIds.size && !inField) {
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l" && !inField) {
      e.preventDefault();
      this.unlinkSelected();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l" && !inField) {
      e.preventDefault();
      this.linkSelected();
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

  private commitDateEdit(task: PlanTask): void {
    if (!this.plan) return;
    clampToPredecessors(task, this.plan.tasks);
    if (!task.isSummary && (task.durationDays ?? 0) === 0) task.isMilestone = true;
    const changed = cascadeDates(this.plan.tasks, [task.id]);
    changed.add(task.id);
    this.syncPlanRange();
    this.renderBoard();
    if (this.persistPlanTimes(changed)) this.opts.onNativeChange?.({ timeChanged: true });
  }

  private persistPlanTimes(ids: Iterable<string>): boolean {
    if (!this.plan) return false;
    let timeChanged = false;
    for (const id of new Set(ids)) {
      const task = this.plan.tasks.find((t) => t.id === id);
      const resolved = this.native(task?.linkedIfcTaskId);
      if (!task || !resolved || resolved.nativeId <= 0) continue;
      const current = resolved.session.schedule.byId.get(resolved.nativeId);
      const patch: TaskPatch = {};
      if (task.start && current?.start?.getTime() !== task.start.getTime()) patch.start = task.start;
      if (task.end && current?.end?.getTime() !== task.end.getTime()) patch.end = task.end;
      if (!!current?.isMilestone !== !!task.isMilestone) patch.isMilestone = !!task.isMilestone;
      if (!Object.keys(patch).length) continue;
      try {
        const result = resolved.session.applyTaskEdit(resolved.nativeId, patch);
        if (result.timeChanged || result.changed) timeChanged = true;
      } catch (err) {
        this.toast((err as Error).message);
      }
    }
    return timeChanged;
  }

  private applyPredecessorText(task: PlanTask, raw: string): void {
    if (!this.plan) return;
    const next: PlanPredecessor[] = [];
    for (const parsed of parsePredecessorList(raw)) {
      const id = resolvePredecessorToken(parsed.token, this.plan.tasks, task.id);
      if (!id) {
        this.toast(`Predecessora «${parsed.token}» não encontrada.`);
        continue;
      }
      if (wouldCreateCycle(this.plan.tasks, id, task.id) && !task.predecessors.some((p) => p.id === id)) {
        this.toast("Essa ligação criaria um ciclo.");
        continue;
      }
      next.push({ id, type: parsed.type, lagDays: parsed.lagDays || undefined });
    }
    this.replacePredecessors(task, next);
  }

  private replacePredecessors(task: PlanTask, next: PlanPredecessor[]): void {
    const prev = [...task.predecessors];
    for (const p of prev) {
      if (!next.some((n) => n.id === p.id)) this.disconnectTasks(p.id, task.id, false);
    }
    for (const n of next) this.connectTasks(n.id, task.id, n.type, n.lagDays ?? 0, false);
    this.finishLinkEdits(task.id);
  }

  private connectTasks(
    predPlanId: string,
    succPlanId: string,
    type: SequenceType,
    lagDays = 0,
    finish = true,
  ): void {
    if (!this.plan) return;
    const pred = this.plan.tasks.find((t) => t.id === predPlanId);
    const succ = this.plan.tasks.find((t) => t.id === succPlanId);
    if (!pred || !succ) return;
    const predN = this.native(pred.linkedIfcTaskId);
    const succN = this.native(succ.linkedIfcTaskId);
    if (!predN || !succN || predN.nativeId <= 0 || succN.nativeId <= 0) {
      this.toast("Só é possível ligar IfcTask nativas do mesmo ficheiro.");
      return;
    }
    if (predN.session !== succN.session) {
      this.toast("Não é possível ligar tarefas de IFCs diferentes.");
      return;
    }
    if (wouldCreateCycle(this.plan.tasks, predPlanId, succPlanId) && !succ.predecessors.some((p) => p.id === predPlanId)) {
      this.toast("Essa ligação criaria um ciclo.");
      return;
    }
    try {
      predN.session.linkSequence(predN.nativeId, succN.nativeId, type, lagDays);
    } catch (err) {
      this.toast((err as Error).message);
      return;
    }
    const existing = succ.predecessors.find((p) => p.id === predPlanId);
    if (existing) {
      existing.type = type;
      existing.lagDays = lagDays || undefined;
    } else {
      succ.predecessors.push({ id: predPlanId, type, lagDays: lagDays || undefined });
    }
    if (finish) this.finishLinkEdits(succPlanId);
  }

  private disconnectTasks(predPlanId: string, succPlanId: string, finish = true): void {
    if (!this.plan) return;
    const pred = this.plan.tasks.find((t) => t.id === predPlanId);
    const succ = this.plan.tasks.find((t) => t.id === succPlanId);
    if (!succ) return;
    const predN = this.native(pred?.linkedIfcTaskId);
    const succN = this.native(succ.linkedIfcTaskId);
    if (predN && succN && predN.session === succN.session && predN.nativeId > 0 && succN.nativeId > 0) {
      succN.session.unlinkSequence(predN.nativeId, succN.nativeId);
    }
    succ.predecessors = succ.predecessors.filter((p) => p.id !== predPlanId);
    if (this.selectedLink?.pred === predPlanId && this.selectedLink?.succ === succPlanId) this.selectedLink = null;
    if (finish) this.finishLinkEdits(succPlanId);
  }

  private finishLinkEdits(seedIds: string | string[]): void {
    if (!this.plan) return;
    const seeds = Array.isArray(seedIds) ? seedIds : [seedIds];
    const changed = cascadeDates(this.plan.tasks, seeds);
    for (const id of seeds) changed.add(id);
    this.syncPlanRange();
    this.renderBoard();
    this.persistPlanTimes(changed);
    this.opts.onNativeChange?.({ timeChanged: true });
  }

  private linkSelected(): void {
    if (!this.plan || this.selectedIds.size < 2) {
      this.toast("Selecione duas ou mais tarefas na ordem do Gantt para ligar (FS).");
      return;
    }
    const ordered = this.plan.tasks.filter((t) => this.selectedIds.has(t.id) && !t.isSummary);
    for (let i = 0; i < ordered.length - 1; i++) {
      this.connectTasks(ordered[i]!.id, ordered[i + 1]!.id, "FS", 0, false);
    }
    const last = ordered[ordered.length - 1];
    if (last) this.finishLinkEdits(last.id);
  }

  private unlinkSelected(): void {
    if (!this.plan || !this.selectedIds.size) return;
    const selected = this.plan.tasks.filter((t) => this.selectedIds.has(t.id));
    const seeds: string[] = [];
    if (selected.length === 1) {
      const task = selected[0]!;
      for (const p of [...task.predecessors]) this.disconnectTasks(p.id, task.id, false);
      for (const other of this.plan.tasks) {
        if (other.predecessors.some((p) => p.id === task.id)) this.disconnectTasks(task.id, other.id, false);
      }
      seeds.push(task.id);
    } else {
      const ids = new Set(selected.map((t) => t.id));
      for (const task of selected) {
        for (const p of [...task.predecessors]) {
          if (ids.has(p.id)) this.disconnectTasks(p.id, task.id, false);
        }
        seeds.push(task.id);
      }
    }
    if (seeds.length) this.finishLinkEdits(seeds);
  }

  private openLinkEditor(pred: string, succ: string, x: number, y: number): void {
    if (!this.plan) return;
    const task = this.plan.tasks.find((t) => t.id === succ);
    const link = task?.predecessors.find((p) => p.id === pred);
    if (!task || !link) return;
    this.selectedLink = { pred, succ };
    const pop = this.el("link-pop");
    const type = this.el("link-type") as HTMLSelectElement | null;
    const lag = this.el("link-lag") as HTMLInputElement | null;
    if (type) type.value = link.type;
    if (lag) lag.value = String(link.lagDays ?? 0);
    if (pop) {
      pop.hidden = false;
      const rect = this.root.getBoundingClientRect();
      pop.style.left = `${Math.min(rect.width - 240, Math.max(8, x - rect.left))}px`;
      pop.style.top = `${Math.min(rect.height - 120, Math.max(8, y - rect.top + 8))}px`;
    }
    this.paintSelection();
  }

  private closeLinkEditor(): void {
    this.selectedLink = null;
    const pop = this.el("link-pop");
    if (pop) pop.hidden = true;
    this.paintSelection();
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

function applyStartKeepEnd(task: PlanTask, start: Date, end: Date): void {
  const next = startOfDay(start);
  const finish = startOfDay(end);
  if (next > finish) {
    task.start = finish;
    task.end = finish;
    task.durationDays = 0;
    task.isMilestone = true;
    return;
  }
  task.start = next;
  task.end = finish;
  task.durationDays = Math.max(0, diffDays(next, finish));
  task.isMilestone = task.durationDays === 0;
}

function sequenceFromSides(from: "start" | "end", to: "start" | "end"): SequenceType {
  if (from === "end" && to === "start") return "FS";
  if (from === "start" && to === "start") return "SS";
  if (from === "end" && to === "end") return "FF";
  return "SF";
}

function barAnchor(
  task: PlanTask,
  plan: ProjectPlan,
  index: number,
  pxPerDay: number,
  side: "start" | "end",
): { x: number; y: number } {
  const left = task.start ? diffDays(plan.minDate, task.start) * pxPerDay : 0;
  const dur = Math.max(task.isMilestone ? 0 : (task.durationDays ?? (task.end && task.start ? diffDays(task.start, task.end) : 1)), 0);
  const width = task.isMilestone ? 12 : Math.max(dur * pxPerDay, 6);
  const y = index * ROW_H + ROW_H / 2;
  const x = side === "start" ? left : left + width;
  return { x, y };
}

/**
 * Ligação ortogonal tipo MS Project: sai da barra, desce/sobe no vão
 * entre linhas e só entra no destino pelo lado certo — sem atravessar barras.
 */
function sequencePath(
  x1: number,
  y1: number,
  fromSide: "start" | "end",
  x2: number,
  y2: number,
  toSide: "start" | "end",
): string {
  const stub = 14;
  const dirOut = fromSide === "end" ? 1 : -1;
  const xOut = x1 + dirOut * stub;
  const xIn = toSide === "start" ? x2 - stub : x2 + stub;
  if (Math.abs(y1 - y2) < 3) {
    return orthoPath([
      [x1, y1],
      [x2, y2],
    ]);
  }
  if (fromSide === "end" && toSide === "start") {
    if (xOut <= xIn) {
      return orthoPath([
        [x1, y1],
        [xOut, y1],
        [xOut, y2],
        [x2, y2],
      ]);
    }
    const gutter = y1 + Math.sign(y2 - y1) * (ROW_H / 2);
    return orthoPath([
      [x1, y1],
      [xOut, y1],
      [xOut, gutter],
      [xIn, gutter],
      [xIn, y2],
      [x2, y2],
    ]);
  }
  if (fromSide === "start" && toSide === "start") {
    const xLane = Math.min(xOut, xIn);
    return orthoPath([
      [x1, y1],
      [xLane, y1],
      [xLane, y2],
      [x2, y2],
    ]);
  }
  if (fromSide === "end" && toSide === "end") {
    const xLane = Math.max(xOut, xIn);
    return orthoPath([
      [x1, y1],
      [xLane, y1],
      [xLane, y2],
      [x2, y2],
    ]);
  }
  const gutter = y1 + Math.sign(y2 - y1) * (ROW_H / 2);
  return orthoPath([
    [x1, y1],
    [xOut, y1],
    [xOut, gutter],
    [xIn, gutter],
    [xIn, y2],
    [x2, y2],
  ]);
}

function orthoPath(pts: Array<[number, number]>, radius = 5): string {
  const points: Array<[number, number]> = [];
  for (const p of pts) {
    const prev = points[points.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 0.5 && Math.abs(prev[1] - p[1]) < 0.5) continue;
    points.push(p);
  }
  if (points.length < 2) return "";
  if (points.length === 2) return `M${fmt(points[0]![0])} ${fmt(points[0]![1])} L${fmt(points[1]![0])} ${fmt(points[1]![1])}`;
  let d = `M${fmt(points[0]![0])} ${fmt(points[0]![1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[i + 1]!;
    const d1 = Math.hypot(x1 - x0, y1 - y0);
    const d2 = Math.hypot(x2 - x1, y2 - y1);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 1.5) {
      d += ` L${fmt(x1)} ${fmt(y1)}`;
      continue;
    }
    d += ` L${fmt(x1 - ((x1 - x0) * r) / d1)} ${fmt(y1 - ((y1 - y0) * r) / d1)}`;
    d += ` Q${fmt(x1)} ${fmt(y1)} ${fmt(x1 + ((x2 - x1) * r) / d2)} ${fmt(y1 + ((y2 - y1) * r) / d2)}`;
  }
  const last = points[points.length - 1]!;
  d += ` L${fmt(last[0])} ${fmt(last[1])}`;
  return d;
}

function fmt(n: number): string {
  return n.toFixed(1);
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

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
