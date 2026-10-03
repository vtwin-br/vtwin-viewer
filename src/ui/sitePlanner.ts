import type { WorkspaceId } from "../app/catalog";
import { measuresForPhase, type SitePlan } from "../planning/sitePlan";
import { sitePhases } from "../site/phases";
import type { ScheduleData } from "../schedule/types";

export type PlanTool = "crane" | "path" | "terrain" | "note";
export type PlanAction = "rotate" | "remove" | "mast-up" | "mast-down" | "jib-up" | "jib-down" | "cut" | "fill";

export interface SitePlannerOptions {
  getWorkspace: () => WorkspaceId;
  hasModel: () => boolean;
  getPlan: () => SitePlan;
  getSchedule: () => ScheduleData | null;
  onAssetAction: (action: PlanAction) => void;
  onSelect?: (id: string) => void;
  onMode?: (placing: boolean) => void;
}

/** Lista do planejamento de obra. Os parâmetros vivem em planning/site.json. */
export class SitePlanner {
  private toolKey: PlanTool | "" = "";
  private phaseId = 0;
  private selectedId = "";
  private noteDraft = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: SitePlannerOptions,
  ) {
    this.root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLElement>("[data-act]");
      if (!button || button instanceof HTMLInputElement) return;
      this.onClick(button.dataset.act || "", button);
    });
    this.root.addEventListener("input", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.dataset.role === "note") this.noteDraft = target.value;
    });
  }

  placing(): boolean {
    return this.opts.getWorkspace() === "site-plan" && !!this.toolKey && this.phaseId > 0;
  }

  tool(): PlanTool | "" {
    return this.toolKey;
  }

  phaseTaskId(): number {
    return this.phaseId;
  }

  noteText(): string {
    return this.noteDraft.trim();
  }

  setSelected(id: string): void {
    this.selectedId = id;
    this.refresh();
  }

  refresh(): void {
    const active = this.opts.getWorkspace() === "site-plan";
    this.root.hidden = !active;
    if (!active) {
      this.opts.onMode?.(false);
      return;
    }
    const schedule = this.opts.getSchedule();
    const phases = this.opts.hasModel() ? sitePhases(schedule) : [];
    if (!this.phaseId || !phases.some((phase) => phase.id === this.phaseId)) this.phaseId = phases[0]?.id ?? 0;
    const phase = phases.find((item) => item.id === this.phaseId) ?? null;
    const plan = this.opts.getPlan();
    const lines = measuresForPhase(plan, phase);
    const selected = lines.find((line) => line.id === this.selectedId) ?? null;
    const kind = selected ? itemKind(plan, selected.id) : "";
    this.root.innerHTML = `
      <div class="site-library" role="listbox" aria-label="Planejamento">
        ${TOOLS.map(
          (item) =>
            `<button type="button" class="site-piece${item.key === this.toolKey ? " is-on" : ""}" data-act="tool" data-key="${item.key}" role="option" aria-selected="${item.key === this.toolKey}">
              ${mark(item.key)}
              <span>${item.name}</span>
            </button>`,
        ).join("")}
      </div>
      ${
        this.toolKey === "note"
          ? `<input class="site-note-input" data-role="note" value="${escapeHtml(this.noteDraft)}" placeholder="Nota" autocomplete="off" />`
          : ""
      }
      ${
        phases.length
          ? `<div class="site-phases">${phases
              .map(
                (item) =>
                  `<button type="button" class="site-chip${item.id === this.phaseId ? " is-on" : ""}" data-act="phase" data-id="${item.id}">${escapeHtml(item.name)}</button>`,
              )
              .join("")}</div>`
          : ""
      }
      ${
        lines.length
          ? `<ul class="site-quantities">${lines
              .map(
                (line) =>
                  `<li><button type="button" class="site-line${line.id === this.selectedId ? " is-on" : ""}" data-act="item" data-id="${escapeHtml(line.id)}"><span>${escapeHtml(line.name)}</span>${line.measure ? `<span class="site-qty">${escapeHtml(line.measure)}</span>` : ""}</button></li>`,
              )
              .join("")}</ul>`
          : ""
      }
      ${selected ? toolsFor(kind) : ""}
    `;
    this.opts.onMode?.(active && !!this.toolKey && this.phaseId > 0);
  }

  private onClick(act: string, button: HTMLElement): void {
    if (act === "tool") {
      const key = (button.dataset.key || "") as PlanTool;
      this.toolKey = this.toolKey === key ? "" : key;
      this.refresh();
      return;
    }
    if (act === "phase") {
      this.phaseId = Number(button.dataset.id) || 0;
      this.refresh();
      return;
    }
    if (act === "item") {
      this.selectedId = button.dataset.id || "";
      this.opts.onSelect?.(this.selectedId);
      this.refresh();
      return;
    }
    if (
      act === "rotate" ||
      act === "remove" ||
      act === "mast-up" ||
      act === "mast-down" ||
      act === "jib-up" ||
      act === "jib-down" ||
      act === "cut" ||
      act === "fill"
    ) {
      this.opts.onAssetAction(act);
    }
  }
}

const TOOLS: { key: PlanTool; name: string }[] = [
  { key: "crane", name: "Guindaste" },
  { key: "path", name: "Caminho" },
  { key: "terrain", name: "Terreno" },
  { key: "note", name: "Nota" },
];

function itemKind(plan: SitePlan, id: string): PlanTool | "" {
  if (plan.cranes.some((item) => item.id === id)) return "crane";
  if (plan.paths.some((item) => item.id === id)) return "path";
  if (plan.terrains.some((item) => item.id === id)) return "terrain";
  if (plan.notes.some((item) => item.id === id)) return "note";
  return "";
}

function toolsFor(kind: PlanTool | ""): string {
  const extra =
    kind === "crane"
      ? `<button type="button" class="site-icon" data-act="mast-up" aria-label="Mastro" title="Mastro">${ICON_UP}</button>
         <button type="button" class="site-icon" data-act="mast-down" aria-label="Mastro menor" title="Mastro">${ICON_DOWN}</button>
         <button type="button" class="site-icon" data-act="jib-up" aria-label="Lança" title="Lança">${ICON_RIGHT}</button>
         <button type="button" class="site-icon" data-act="jib-down" aria-label="Lança menor" title="Lança">${ICON_LEFT}</button>`
      : kind === "terrain"
        ? `<button type="button" class="site-chip" data-act="cut">Corte</button><button type="button" class="site-chip" data-act="fill">Aterro</button>`
        : "";
  return `<div class="site-tools">
    ${kind === "crane" ? `<button type="button" class="site-icon" data-act="rotate" aria-label="Rodar" title="Rodar">${ICON_ROTATE}</button>` : ""}
    ${extra}
    <button type="button" class="site-icon" data-act="remove" aria-label="Apagar" title="Apagar">${ICON_REMOVE}</button>
  </div>`;
}

const ICON_ROTATE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M19 12a7 7 0 11-2.1-5" stroke-linecap="round"/><path d="M19 4v5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_REMOVE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 14l6-6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 10l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_RIGHT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M10 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_LEFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M14 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function mark(key: PlanTool): string {
  return `<span class="site-mark" aria-hidden="true">${MARKS[key]}</span>`;
}

const MARKS: Record<PlanTool, string> = {
  crane: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 20V6M5 6h14M16 6v5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  path: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 17c4-8 10-8 14 0" stroke-linecap="round"/><circle cx="5" cy="17" r="1.3"/><circle cx="19" cy="17" r="1.3"/></svg>`,
  terrain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 18l6-8 4 5 3-4 5 7" stroke-linejoin="round"/></svg>`,
  note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s6-5.2 6-10a6 6 0 10-12 0c0 4.8 6 10 6 10z" stroke-linejoin="round"/><circle cx="12" cy="11" r="1.6"/></svg>`,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
