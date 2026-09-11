import type { ScheduleData } from "../schedule/types";
import {
  applyDuration,
  applyEnd,
  applyStart,
  emptyPlan,
  finalizePlan,
  formatBytes,
  insertTaskAfter,
  removeTask,
  visibleTasks,
} from "../projectPlan/buildPlan";
import { diffDays, formatDay, fromInputDate, toInputDate } from "../projectPlan/dates";
import { importPlanFile } from "../projectPlan/importPlan";
import { scheduleToPlan } from "../projectPlan/fromIfc";
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

const ZOOM = [8, 14, 22, 32];
const ROW_H = 36;
const ICON_TOGGLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export interface ProjectWorkspaceOptions {
  getIfcSchedule: () => ScheduleData | null;
  getIfcFileName: () => string | null;
  onRequestIfcImport: () => void;
  onPlanChange?: (name: string | null) => void;
  onSelectTask?: (task: PlanTask | null) => void;
  onToggleModel?: () => void;
}

export class ProjectWorkspace {
  private root: HTMLElement;
  private opts: ProjectWorkspaceOptions;
  private plan: ProjectPlan | null = null;
  private selectedId: string | null = null;
  private pxPerDay = 14;
  private toastTimer = 0;
  private fileInput: HTMLInputElement | null = null;
  private csvDraft: CsvInspection | null = null;
  private csvFile: File | null = null;
  private modelOpen = false;

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

  setModelOpen(open: boolean): void {
    this.modelOpen = open;
    this.root.querySelectorAll("[data-act='model']").forEach((btn) => {
      btn.classList.toggle("is-active", open);
      btn.setAttribute("aria-pressed", open ? "true" : "false");
    });
  }

  selectByIfcTaskId(ifcId: number): void {
    const task = this.plan?.tasks.find((t) => t.linkedIfcTaskId === ifcId);
    if (!task) return;
    this.setSelected(task.id, false);
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
  bindFromIfc(schedule: ScheduleData, fileName?: string, force = false): void {
    if (!schedule.roots.length) return;
    if (this.plan?.sourceKind === "import" && !force) {
      this.toast("O IFC tem cronograma nativo. Use «Abrir cronograma do IFC» para o ver neste Gantt.");
      this.render();
      return;
    }
    this.plan = scheduleToPlan(schedule, fileName);
    this.selectedId = this.plan.tasks[0]?.id ?? null;
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
          <p data-el="empty-copy">O Gantt lê o cronograma nativo do IFC (IfcWorkPlan → IfcWorkSchedule → IfcTask), com as datas já ligadas aos elementos 3D. Também pode importar CSV/XML com mapeamento de colunas.</p>
          <div class="pw-empty-actions" data-el="empty-actions">
            <button type="button" class="btn-primary" data-act="from-ifc">Abrir cronograma do IFC</button>
            <button type="button" class="btn-secondary" data-act="import">Importar CSV / XML</button>
            <button type="button" class="btn-secondary" data-act="new">Novo em branco</button>
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
            <button type="button" class="btn-ghost pw-act-wide" data-act="import">Importar</button>
            <button type="button" class="btn-ghost pw-act-wide" data-act="sync">Sincronizar</button>
            <div class="pw-overflow">
              <button type="button" class="icon-btn-plain pw-overflow-btn" data-act="more" aria-label="Mais ações" aria-haspopup="true" title="Mais ações">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></svg>
              </button>
              <div class="pw-overflow-menu" hidden data-el="more-menu">
                <button type="button" data-act="model">Modelo 3D</button>
                <button type="button" data-act="from-ifc">Abrir IFC</button>
                <button type="button" data-act="import">Importar</button>
                <button type="button" data-act="sync">Sincronizar</button>
              </div>
            </div>
            <div class="pw-zoom" role="group" aria-label="Zoom do Gantt">
              <button type="button" class="pw-zoom-btn" data-act="zoom-out" title="Afastar" aria-label="Afastar">−</button>
              <button type="button" class="pw-zoom-btn" data-act="zoom-in" title="Aproximar" aria-label="Aproximar">+</button>
            </div>
          </div>
        </header>
        <div class="pw-gantt" data-el="gantt">
          <div class="pw-table">
            <div class="pw-table-head">
              <span class="pw-col-wbs">#</span>
              <span class="pw-col-name">Nome</span>
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
      <div class="pw-sync is-hidden" data-el="sync" role="dialog" aria-modal="true" aria-labelledby="pw-sync-title"></div>
      <div class="pw-sync is-hidden" data-el="mapper" role="dialog" aria-modal="true" aria-labelledby="pw-map-title"></div>
      <div class="pw-toast" data-el="toast" hidden></div>
    `;
    this.root.querySelector("[data-pane='empty']")?.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
      if (act === "new") this.newPlan();
      if (act === "import") this.fileInput?.click();
      if (act === "from-ifc") this.openIfcSchedule(true);
    });
    this.root.querySelector(".pw-toolbar")?.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
      if (act === "add") this.addTask();
      if (act === "import") this.fileInput?.click();
      if (act === "sync") this.openSync();
      if (act === "from-ifc") this.openIfcSchedule(true);
      if (act === "model") this.opts.onToggleModel?.();
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
      this.plan.name = (e.target as HTMLInputElement).value.trim() || this.plan.name;
    });
    this.bindGantt();
    this.el("sync")?.addEventListener("click", this.onSyncClick);
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
      this.setSelected(hit.dataset.id!);
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
      this.setSelected(id);
    });

    table?.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const row = input.closest<HTMLElement>("[data-id]");
      const task = this.plan?.tasks.find((t) => t.id === row?.dataset.id);
      if (!task || !this.plan) return;
      const field = input.dataset.field;
      if (field === "name") task.name = input.value;
      if (field === "dur") applyDuration(task, Number(input.value) || 0);
      if (field === "start") {
        const d = fromInputDate(input.value);
        if (d) applyStart(task, d);
      }
      if (field === "end") {
        const d = fromInputDate(input.value);
        if (d) applyEnd(task, d);
      }
      this.plan = finalizePlan(this.plan);
      this.renderBoard();
    });

    table?.addEventListener("keydown", (e) => {
      if (e.key === "Delete" && this.selectedId && !(e.target as HTMLElement).matches("input")) {
        e.preventDefault();
        this.deleteSelected();
      }
      if (e.key === "Enter" && (e.target as HTMLElement).matches("input")) {
        (e.target as HTMLInputElement).blur();
      }
    });
  }

  private newPlan(): void {
    this.plan = emptyPlan("Novo planejamento");
    this.selectedId = this.plan.tasks[1]?.id ?? this.plan.tasks[0]?.id ?? null;
    this.render();
  }

  private addTask(): void {
    if (!this.plan) this.plan = emptyPlan("Novo planejamento");
    const task = insertTaskAfter(this.plan, this.selectedId);
    this.selectedId = task.id;
    this.plan = finalizePlan(this.plan);
    this.renderBoard();
    this.el("table-body")
      ?.querySelector<HTMLInputElement>(`[data-id="${CSS.escape(task.id)}"] input[data-field="name"]`)
      ?.focus();
  }

  private deleteSelected(): void {
    if (!this.plan || !this.selectedId) return;
    removeTask(this.plan, this.selectedId);
    this.selectedId = this.plan.tasks[0]?.id ?? null;
    this.plan = finalizePlan(this.plan);
    this.renderBoard();
  }

  private openIfcSchedule(force = false): void {
    const schedule = this.opts.getIfcSchedule();
    if (!schedule?.roots.length) {
      this.toast("Importe um IFC com IfcWorkSchedule para abrir o cronograma nativo.");
      this.opts.onRequestIfcImport();
      return;
    }
    this.bindFromIfc(schedule, this.opts.getIfcFileName() ?? undefined, force);
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
      this.plan = imported;
      for (const att of extra) {
        if (!this.plan.attachments.some((a) => a.name === att.name && a.size === att.size)) {
          this.plan.attachments.push(att);
        }
      }
      this.selectedId = this.plan.tasks[0]?.id ?? null;
    } else if (extra.length) {
      if (!this.plan) this.plan = emptyPlan(files[0]?.name.replace(/\.[^.]+$/, "") || "Planejamento");
      this.plan.attachments.push(...extra);
    }

    if (!this.plan && extra.length) {
      this.plan = emptyPlan("Novo planejamento");
      this.plan.attachments.push(...extra);
    }

    this.render();
    if (warnings.length) this.toast(warnings.join(" "));
    else if (imported) this.toast(`${imported.tasks.length} tarefas importadas de ${imported.sourceLabel ?? "arquivo"}.`);
    else if (extra.length) this.toast("Arquivo anexado ao planejamento.");
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
        ? `Este IFC já tem cronograma nativo (<strong>${escapeHtml(schedule.workPlanName || schedule.name)}</strong> · ${schedule.byId.size} IfcTask), com datas ligadas aos elementos 3D. Abra-o no Gantt ou importe um CSV mapeando as colunas.`
        : `O Gantt lê o cronograma nativo do IFC (<strong>IfcWorkPlan → IfcWorkSchedule → IfcTask</strong>). Importe um IFC, ou um CSV/XML com seletor de colunas.`;
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
      const linked = plan.tasks.filter((t) => t.linkedIfcTaskId != null).length;
      meta.textContent = `${n} tarefa${n === 1 ? "" : "s"}${linked ? ` · ${linked} no 3D` : ""} · ${formatDay(plan.minDate)} – ${formatDay(plan.maxDate)}`;
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
      const next = Math.max(220, Math.min(640, w));
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
    handle.addEventListener("dblclick", () => apply(420));
  }

  private rowHtml(task: PlanTask, index: number): string {
    const selected = task.id === this.selectedId ? " is-selected" : "";
    const pad = 8 + (task.outlineLevel - 1) * 14;
    const toggle = task.isSummary
      ? `<button type="button" class="pw-toggle${task.collapsed ? " is-collapsed" : ""}" data-act="toggle" aria-label="${task.collapsed ? "Expandir" : "Recolher"}">${ICON_TOGGLE}</button>`
      : `<span class="pw-toggle-ph"></span>`;
    return `
      <div class="pw-row${selected}${task.isSummary ? " is-summary" : ""}" data-id="${escapeHtml(task.id)}" style="height:${ROW_H}px">
        <span class="pw-col-wbs" title="${escapeAttr(task.wbs || "")}">${escapeHtml(task.wbs || String(index + 1))}</span>
        <span class="pw-col-name" style="padding-left:${pad}px">${toggle}
          ${task.linkedIfcTaskId != null ? `<span class="pw-ifc-dot" title="IfcTask nativa"></span>` : ""}
          <input data-field="name" value="${escapeAttr(task.name)}" spellcheck="false" title="${escapeAttr(task.name)}" />
          ${
            task.linkedProductGuids.length
              ? `<span class="pw-prod" title="${task.linkedProductGuids.length} elementos 3D">${task.linkedProductGuids.length}</span>`
              : ""
          }
          ${
            task.linkedGroupNames?.length
              ? `<span class="pw-set" title="Conjuntos IFC: ${escapeAttr(task.linkedGroupNames.join(", "))}">${escapeHtml(task.linkedGroupNames[0])}${task.linkedGroupNames.length > 1 ? ` +${task.linkedGroupNames.length - 1}` : ""}</span>`
              : ""
          }
        </span>
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
      return `<div class="pw-mile" data-id="${escapeHtml(task.id)}" style="left:${left}px;top:${index * ROW_H + 10}px" title="${escapeAttr(task.name)}"></div>`;
    }
    const w = Math.max(dur * this.pxPerDay, 6);
    const pct = Math.max(0, Math.min(100, task.progress));
    const kind = task.isSummary ? "summary" : barState(task);
    return `<div class="pw-bar is-${kind}" data-id="${escapeHtml(task.id)}" style="left:${left}px;top:${top}px;width:${w}px" title="${escapeAttr(task.name)}">
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

  private setSelected(id: string | null, emit = true): void {
    this.selectedId = id;
    this.paintSelection();
    if (!emit) return;
    const task = this.getSelected();
    this.opts.onSelectTask?.(task);
  }

  private paintSelection(): void {
    this.root.querySelectorAll(".pw-row, .pw-bar, .pw-mile").forEach((el) => {
      el.classList.toggle("is-selected", (el as HTMLElement).dataset.id === this.selectedId);
    });
  }

  private openSync(): void {
    const panel = this.el("sync");
    if (!panel || !this.plan) return;
    const schedule = this.opts.getIfcSchedule();
    const fileName = this.opts.getIfcFileName();
    const planCount = this.plan.tasks.filter((t) => !t.isSummary).length;
    const ifcTasks = schedule ? [...schedule.byId.values()].filter((t) => t.children.length === 0) : [];
    const matches = schedule ? matchTasks(this.plan.tasks, schedule) : [];

    panel.innerHTML = `
      <div class="pw-sync-card">
        <header>
          <h3 id="pw-sync-title">Sincronizar com o modelo</h3>
          <button type="button" class="pw-sync-close" data-act="close" aria-label="Fechar">×</button>
        </header>
        <p class="pw-sync-lead">O Gantt externo vira cronograma 4D: cada tarefa liga-se a elementos do IFC e, no passo seguinte, grava-se como <strong>IfcTask</strong> nativo.</p>
        <dl class="pw-sync-stats">
          <div><dt>Planejamento</dt><dd>${planCount} tarefas</dd></div>
          <div><dt>Modelo IFC</dt><dd>${fileName ? escapeHtml(fileName) : "nenhum arquivo aberto"}</dd></div>
          <div><dt>IfcTask no modelo</dt><dd>${schedule ? ifcTasks.length : "—"}</dd></div>
          <div><dt>Correspondências por nome</dt><dd>${matches.length}</dd></div>
        </dl>
        ${
          !schedule
            ? `<p class="pw-sync-note">Importe um IFC para pré-visualizar as ligações. A gravação nativa no arquivo entra a seguir — as correspondências já ficam neste planejamento.</p>
               <div class="pw-sync-actions">
                 <button type="button" class="btn-primary" data-act="import-ifc">Importar IFC</button>
                 <button type="button" class="btn-secondary" data-act="close">Agora não</button>
               </div>`
            : `<div class="pw-sync-matches">${
                matches.length
                  ? matches
                      .slice(0, 40)
                      .map(
                        (m) => `<div class="pw-sync-row"><span>${escapeHtml(m.planName)}</span><span>→</span><span>${escapeHtml(m.ifcName)}</span></div>`,
                      )
                      .join("") + (matches.length > 40 ? `<p class="pw-sync-note">+${matches.length - 40} outras</p>` : "")
                  : `<p class="pw-sync-note">Nenhum nome coincidiu ainda. Pode ligar à mão mais tarde, ou gravar o Gantt como IfcWorkSchedule novo.</p>`
              }</div>
              <div class="pw-sync-actions">
                <button type="button" class="btn-primary" data-act="apply" ${matches.length ? "" : "disabled"}>Ligar correspondências</button>
                <button type="button" class="btn-secondary" data-act="close">Fechar</button>
              </div>
              <p class="pw-sync-note">A escrita no STEP (IfcRelAssignsToProcess / IfcTaskTime) fica para o próximo passo — hoje a ligação fica na sessão de planejamento.</p>`
        }
      </div>`;
    panel.classList.remove("is-hidden");
  }

  private onSyncClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("pw-sync")) {
      this.closeSync();
      return;
    }
    const act = target.closest("[data-act]")?.getAttribute("data-act");
    if (act === "close") this.closeSync();
    if (act === "import-ifc") {
      this.closeSync();
      this.opts.onRequestIfcImport();
    }
    if (act === "apply") this.applyMatches();
  };

  private applyMatches(): void {
    if (!this.plan) return;
    const schedule = this.opts.getIfcSchedule();
    if (!schedule) return;
    const matches = matchTasks(this.plan.tasks, schedule);
    const byId = new Map(this.plan.tasks.map((t) => [t.id, t]));
    for (const m of matches) {
      const task = byId.get(m.planId);
      if (!task) continue;
      task.linkedIfcTaskId = m.ifcId;
      task.linkedProductGuids = [...(schedule.productGuidsByTask.get(m.ifcId) ?? [])];
    }
    this.closeSync();
    this.toast(`${matches.length} tarefa${matches.length === 1 ? "" : "s"} ligadas ao modelo nesta sessão.`);
    this.renderBoard();
  }

  private closeSync(): void {
    this.el("sync")?.classList.add("is-hidden");
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
        <p class="pw-sync-lead"><strong>${escapeHtml(insp.fileName)}</strong> · ${insp.dataRowCount} linhas · delimitador «${escapeHtml(insp.delimiter === "\t" ? "tab" : insp.delimiter)}». Diga qual coluna é o nome da tarefa — o número do item não deve ir para a descrição.</p>
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
          <button type="button" class="btn-primary" data-act="apply" ${map.name == null ? "disabled" : ""}>Importar para o Gantt</button>
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
    try {
      const plan = planFromMappedCsv(this.csvDraft, this.csvDraft.guessed);
      if (this.csvFile) plan.attachments.push(fileToAttachment(this.csvFile, "schedule"));
      this.plan = plan;
      this.selectedId = plan.tasks[0]?.id ?? null;
      this.closeMapper();
      this.render();
      this.toast(`${plan.tasks.length} tarefas importadas. Confira se o nome veio da coluna de descrição.`);
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

function matchTasks(planTasks: PlanTask[], schedule: ScheduleData): Array<{ planId: string; planName: string; ifcId: number; ifcName: string }> {
  const ifc = [...schedule.byId.values()].map((t) => ({
    id: t.id,
    name: t.name,
    key: norm(t.name),
  }));
  const used = new Set<number>();
  const out: Array<{ planId: string; planName: string; ifcId: number; ifcName: string }> = [];
  for (const t of planTasks) {
    if (t.isSummary) continue;
    const key = norm(t.name);
    if (!key) continue;
    const hit = ifc.find((i) => !used.has(i.id) && (i.key === key || i.key.includes(key) || key.includes(i.key)));
    if (!hit) continue;
    used.add(hit.id);
    out.push({ planId: t.id, planName: t.name, ifcId: hit.id, ifcName: hit.name });
  }
  return out;
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
