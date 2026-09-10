import type { ScheduleData, Task } from "../schedule/types";
import { getTaskState } from "../schedule/simulation";
import { computeCostProjection, formatMoney, treeCost } from "../schedule/cost";
import { countLeafStates, findDisciplineGroups } from "./disciplineDonuts";
import { displayTaskName } from "./taskLabels";

export interface SimHudOptions {
  root: HTMLElement;
  onPhaseSelect: (task: Task) => void;
}

interface ChartRow {
  root: HTMLElement;
  planned: HTMLElement;
  realized: HTMLElement;
  value: HTMLElement;
}

/**
 * HUD 4D/5D sobre o viewport: fases à esquerda e gráfico de custo à direita.
 */
export class SimHud {
  private readonly opts: SimHudOptions;
  private schedule: ScheduleData | null = null;
  private selectedId: number | null = null;
  private date = new Date();
  private rowRefs: ChartRow[] = [];
  private plannedLine: SVGPolylineElement | null = null;
  private lineRaf = 0;

  private readonly phasesEl: HTMLElement;
  private readonly costEl: HTMLElement;
  private readonly budgetEl: HTMLElement;
  private readonly realizedEl: HTMLElement;
  private readonly chartBody: HTMLElement;
  private readonly plotEl: HTMLElement;
  private readonly lineSvg: SVGSVGElement;
  private readonly axisEl: HTMLElement;
  private readonly emptyEl: HTMLElement;

  constructor(opts: SimHudOptions) {
    this.opts = opts;
    const root = opts.root;
    root.classList.add("sim-hud");
    root.innerHTML = `
      <nav class="hud-phases" aria-label="Fases da obra"></nav>
      <aside class="hud-cost" aria-label="Custo 5D">
        <p class="hud-cost-kicker">Projeção mensal de custo</p>
        <div class="hud-cost-totals">
          <span><em>Orçamento</em><strong data-hud-budget>—</strong></span>
          <span><em>Realizado</em><strong data-hud-realized>—</strong></span>
        </div>
        <p class="hud-cost-empty">Sem custos 5D neste IFC</p>
        <div class="hud-chart">
          <span class="hud-months-label">mês</span>
          <div class="hud-chart-plot" data-hud-plot>
            <div class="hud-chart-rows" data-hud-rows></div>
            <svg class="hud-chart-lines" data-hud-lines aria-hidden="true">
              <polyline data-line="planned" fill="none" points="" />
            </svg>
          </div>
          <div class="hud-chart-axis" data-hud-axis></div>
          <p class="hud-axis-title">percentual do orçamento</p>
        </div>
      </aside>
    `;

    this.phasesEl = root.querySelector(".hud-phases")!;
    this.costEl = root.querySelector(".hud-cost")!;
    this.budgetEl = root.querySelector("[data-hud-budget]")!;
    this.realizedEl = root.querySelector("[data-hud-realized]")!;
    this.chartBody = root.querySelector("[data-hud-rows]")!;
    this.plotEl = root.querySelector("[data-hud-plot]")!;
    this.lineSvg = root.querySelector("[data-hud-lines]")!;
    this.axisEl = root.querySelector("[data-hud-axis]")!;
    this.emptyEl = root.querySelector(".hud-cost-empty")!;
    this.plannedLine = root.querySelector('[data-line="planned"]');
    new ResizeObserver(() => this.drawPlannedLine()).observe(this.plotEl);
    this.setIdle(true);
  }

  setIdle(idle: boolean): void {
    this.opts.root.classList.toggle("is-idle", idle);
  }

  setCostPanelOpen(open: boolean): void {
    this.opts.root.classList.toggle("is-cost-off", !open);
  }

  setChartOpen(open: boolean): void {
    this.setCostPanelOpen(open);
  }

  get chartVisible(): boolean {
    return !this.opts.root.classList.contains("is-cost-off");
  }

  bind(schedule: ScheduleData | null): void {
    this.schedule = schedule;
    this.selectedId = null;
    this.buildPhases();
    this.buildChartRows();
    if (!schedule || schedule.roots.length === 0) {
      this.setIdle(true);
      return;
    }
    this.setIdle(false);
    this.update(this.date, null);
  }

  setSelected(taskId: number | null): void {
    this.selectedId = taskId;
    for (const btn of this.phasesEl.querySelectorAll<HTMLElement>(".hud-phase")) {
      const id = Number(btn.dataset.taskId);
      btn.classList.toggle("is-selected", taskId != null && id === taskId);
    }
  }

  update(date: Date, selectedId: number | null): void {
    this.date = date;
    if (selectedId !== undefined) this.selectedId = selectedId;
    if (!this.schedule || this.schedule.roots.length === 0) return;
    this.updatePhases();
    this.updateCost();
  }

  private buildPhases(): void {
    this.phasesEl.innerHTML = "";
    if (!this.schedule) return;
    const groups = findDisciplineGroups(this.schedule);
    this.phasesEl.classList.toggle("is-empty", groups.length === 0);
    for (const g of groups) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hud-phase";
      btn.dataset.taskId = String(g.id);
      btn.innerHTML = `
        <span class="hud-phase-label">${escapeHtml(hudPhaseLabel(g))}</span>
        <span class="hud-phase-donut">
          <svg viewBox="0 0 56 56" aria-hidden="true">
            <circle class="hud-donut-track" cx="28" cy="28" r="20" />
            <circle class="hud-donut-fill" cx="28" cy="28" r="20" />
            <circle class="hud-donut-active" cx="28" cy="28" r="20" />
          </svg>
          <span class="hud-phase-icon">${phaseIcon(g)}</span>
        </span>
      `;
      btn.addEventListener("click", () => this.opts.onPhaseSelect(g));
      this.phasesEl.appendChild(btn);
    }
  }

  private updatePhases(): void {
    if (!this.schedule) return;
    for (const btn of this.phasesEl.querySelectorAll<HTMLElement>(".hud-phase")) {
      const id = Number(btn.dataset.taskId);
      const task = this.schedule.byId.get(id);
      if (!task) continue;
      const { pending, active, done } = countLeafStates(task, this.date);
      const n = pending + active + done;
      const pct = n > 0 ? Math.round((100 * done) / n) : 0;
      btn.dataset.state = getTaskState(task, this.date);
      btn.classList.toggle("is-selected", this.selectedId === id);
      const fill = btn.querySelector(".hud-donut-fill") as SVGCircleElement | null;
      const activeRing = btn.querySelector(".hud-donut-active") as SVGCircleElement | null;
      const c = 2 * Math.PI * 20;
      const doneLen = n > 0 ? (done / n) * c : 0;
      const activeLen = n > 0 ? (active / n) * c : 0;
      if (fill) {
        fill.style.strokeDasharray = `${doneLen} ${c}`;
        fill.style.strokeDashoffset = "0";
      }
      if (activeRing) {
        activeRing.style.strokeDasharray = `${activeLen} ${c}`;
        activeRing.style.strokeDashoffset = String(-doneLen);
      }
      const cost = treeCost(task);
      btn.title =
        `${displayTaskName(task)}\n` +
        `${pct}% concluído` +
        (cost > 0 ? `\n${formatMoney(cost, this.schedule.currency)}` : "");
    }
  }

  private buildChartRows(): void {
    this.chartBody.innerHTML = "";
    this.rowRefs = [];
    if (!this.schedule) return;
    const { months } = computeCostProjection(this.schedule, this.date);
    this.costEl.style.setProperty("--hud-rows", String(Math.max(months.length, 1)));
    for (const m of months) {
      const row = document.createElement("div");
      row.className = "hud-chart-row";
      row.innerHTML = `
        <span class="hud-chart-idx">${m.index}</span>
        <div class="hud-chart-track">
          <span class="hud-bar is-planned"></span>
          <span class="hud-bar is-realized"></span>
        </div>
        <span class="hud-chart-val">—</span>
      `;
      this.chartBody.appendChild(row);
      this.rowRefs.push({
        root: row,
        planned: row.querySelector(".hud-bar.is-planned") as HTMLElement,
        realized: row.querySelector(".hud-bar.is-realized") as HTMLElement,
        value: row.querySelector(".hud-chart-val") as HTMLElement,
      });
    }
  }

  private updateCost(): void {
    if (!this.schedule) return;
    const currency = this.schedule.currency;
    const proj = computeCostProjection(this.schedule, this.date);
    if (proj.months.length !== this.rowRefs.length) this.buildChartRows();

    this.costEl.classList.toggle("is-empty", proj.total <= 0);
    this.emptyEl.hidden = proj.total > 0;
    if (proj.total <= 0) {
      this.budgetEl.textContent = "—";
      this.realizedEl.textContent = "—";
      this.plannedLine?.setAttribute("points", "");
      return;
    }

    this.budgetEl.textContent = formatHudMoney(proj.total, currency);
    this.realizedEl.textContent = formatHudMoney(proj.realized, currency);

    const maxShare = Math.max(...proj.months.map((m) => m.planned / proj.total), 0.05);
    const xMax = Math.max(0.15, Math.ceil(maxShare * 20) / 20);

    for (let i = 0; i < this.rowRefs.length; i++) {
      const m = proj.months[i];
      const ref = this.rowRefs[i];
      if (!m || !ref) continue;
      const p = (m.planned / proj.total / xMax) * 100;
      const r = (m.realized / proj.total / xMax) * 100;
      ref.planned.style.width = `${Math.max(0, Math.min(100, p))}%`;
      ref.realized.style.width = `${Math.max(0, Math.min(p, r))}%`;
      ref.value.textContent = formatHudMoney(m.planned, currency);
      const next = proj.months[i + 1];
      const isCurrent =
        this.date.getTime() >= m.start.getTime() &&
        (next == null || this.date.getTime() < next.start.getTime());
      ref.root.classList.toggle("is-current", isCurrent);
      ref.root.title = `${m.label}: planejado ${formatMoney(m.planned, currency)} · realizado ${formatMoney(m.realized, currency)}`;
    }

    this.axisEl.replaceChildren();
    const step = xMax <= 0.2 ? 0.05 : 0.1;
    for (let t = 0; t <= xMax + 1e-9; t += step) {
      const span = document.createElement("span");
      span.textContent = `${Math.round(t * 100)}%`;
      this.axisEl.appendChild(span);
    }

    if (this.lineRaf) cancelAnimationFrame(this.lineRaf);
    this.drawPlannedLine();
    this.lineRaf = requestAnimationFrame(() => this.drawPlannedLine());
  }

  private drawPlannedLine(): void {
    const line = this.plannedLine;
    if (!line || this.rowRefs.length === 0) return;

    const w = this.plotEl.clientWidth;
    const h = this.plotEl.clientHeight;
    if (w < 4 || h < 4) {
      line.setAttribute("points", "");
      return;
    }

    this.lineSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.lineSvg.setAttribute("width", String(w));
    this.lineSvg.setAttribute("height", String(h));

    const plotRect = this.plotEl.getBoundingClientRect();
    const pts: string[] = [];
    for (const row of this.rowRefs) {
      const track = row.planned.parentElement;
      if (!track) continue;
      const tr = track.getBoundingClientRect();
      const br = row.planned.getBoundingClientRect();
      const x = (br.width < 0.5 ? tr.left : br.right) - plotRect.left;
      const y = tr.top + tr.height / 2 - plotRect.top;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    line.setAttribute("points", pts.join(" "));
  }
}

function hudPhaseLabel(task: Task): string {
  const name = displayTaskName(task);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return name;
  return parts.slice(0, 2).join(" ");
}

function formatHudMoney(amount: number, currency = "BRL"): string {
  const code = /^[A-Z]{3}$/i.test(currency) ? currency.toUpperCase() : "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return formatMoney(amount, currency);
  }
}

function phaseIcon(task: Task): string {
  const n = `${task.name} ${task.identification ?? ""}`.toLowerCase();
  if (/foundat|funda|escava|earthwork|terraplen/.test(n)) return ICON_FOUNDATION;
  if (/struct|estrut|steel|a[cç]o|frame|concreto estrut/.test(n)) return ICON_STRUCTURE;
  if (/envelop|alvenar|masonry|wall|fachada|vedaç|brick|core/.test(n)) return ICON_ENVELOPE;
  if (/landscap|paisag|site work|urbaniz|green/.test(n)) return ICON_LANDSCAPE;
  if (/\bmep\b|elet|hidr|hvac|fire|sprinkler|instala/.test(n)) return ICON_MEP;
  return ICON_GENERIC;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const ICON_FOUNDATION = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 18h18M6 18V11l3-2 2 4 3-3 4 4v4" stroke-linejoin="round"/><path d="M8 8V6h2v2"/></svg>`;
const ICON_STRUCTURE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 20V8l7-4 7 4v12"/><path d="M5 20h14M9 20v-6h6v6M12 4v10"/></svg>`;
const ICON_ENVELOPE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V9l8-5 8 5v11H4z"/><path d="M9 20v-5h6v5M8 11h.5M12 11h.5M16 11h.5"/></svg>`;
const ICON_LANDSCAPE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21V10"/><path d="M12 11c-3.5-5-8-4.5-9-4 1.2 5 5 7.5 9 7.5S19.8 12 21 7c-1 .5-5.5 0-9 4z"/></svg>`;
const ICON_MEP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 2L6 13h5l-1 9 8-12h-5l0-8z" stroke-linejoin="round"/></svg>`;
const ICON_GENERIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V8l8-4 8 4v12H4z"/><path d="M9 20v-6h6v6"/></svg>`;
