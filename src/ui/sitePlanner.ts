import type { WorkspaceId } from "../app/catalog";
import type { IfcSession } from "../ifc/ifcSession";
import { SITE_LIBRARY } from "../site/library";
import { formatQuantity, phaseQuantities, sitePhases } from "../site/phases";
import type { ScheduleData } from "../schedule/types";

export interface SitePlannerOptions {
  getWorkspace: () => WorkspaceId;
  hasModel: () => boolean;
  sessions: () => IfcSession[];
  getSchedule: () => ScheduleData | null;
  onAssetAction: (action: "rotate" | "remove") => void;
  onMode?: (placing: boolean) => void;
}

/** Painel curto do plano de canteiro: biblioteca, fase e quantidades. */
export class SitePlanner {
  private libraryKey = "";
  private phaseId = 0;
  private selectedGuid = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: SitePlannerOptions,
  ) {
    this.root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLElement>("[data-act]");
      if (!button) return;
      this.onClick(button.dataset.act || "", button);
    });
  }

  placing(): boolean {
    return this.opts.getWorkspace() === "site-plan" && !!this.libraryKey && this.phaseId > 0;
  }

  phaseTaskId(): number {
    return this.phaseId;
  }

  library(): string {
    return this.libraryKey;
  }

  setSelected(guid: string): void {
    this.selectedGuid = guid;
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
    const assets = this.opts.sessions().flatMap((session) => session.listSiteAssets());
    const lines = schedule && phase ? phaseQuantities(schedule, assets, phase) : [];
    this.root.innerHTML = `
      <div class="site-library" role="listbox" aria-label="Peças">
        ${SITE_LIBRARY.map(
          (item) =>
            `<button type="button" class="site-piece${item.key === this.libraryKey ? " is-on" : ""}" data-act="library" data-key="${item.key}" role="option" aria-selected="${item.key === this.libraryKey}">
              ${mark(item.key)}
              <span>${escapeHtml(item.name)}</span>
            </button>`,
        ).join("")}
      </div>
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
                  `<li><span>${escapeHtml(line.name)}</span><span class="site-qty">${escapeHtml(formatQuantity(line))}</span></li>`,
              )
              .join("")}</ul>`
          : ""
      }
      ${
        this.selectedGuid
          ? `<div class="site-tools">
              <button type="button" class="site-icon" data-act="rotate" aria-label="Rodar" title="Rodar">${ICON_ROTATE}</button>
              <button type="button" class="site-icon" data-act="remove" aria-label="Apagar" title="Apagar">${ICON_REMOVE}</button>
            </div>`
          : ""
      }
    `;
    this.opts.onMode?.(active && !!this.libraryKey && this.phaseId > 0);
  }

  private onClick(act: string, button: HTMLElement): void {
    if (act === "library") {
      const key = button.dataset.key || "";
      this.libraryKey = this.libraryKey === key ? "" : key;
      this.refresh();
      return;
    }
    if (act === "phase") {
      this.phaseId = Number(button.dataset.id) || 0;
      this.refresh();
      return;
    }
    if (act === "rotate" || act === "remove") this.opts.onAssetAction(act);
  }
}

const ICON_ROTATE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M19 12a7 7 0 11-2.1-5" stroke-linecap="round"/><path d="M19 4v5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_REMOVE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function mark(key: string): string {
  const svg = MARKS[key] ?? MARKS.grua;
  return `<span class="site-mark" aria-hidden="true">${svg}</span>`;
}

const MARKS: Record<string, string> = {
  grua: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 20V6M5 6h14M16 6v5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  camiao: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 15V9h10v6M13 11h4l3 3v1h-7" stroke-linejoin="round"/><circle cx="7" cy="16.5" r="1.4"/><circle cx="17" cy="16.5" r="1.4"/></svg>`,
  betoneira: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="10" cy="12" rx="5" ry="3.2"/><path d="M15 12h5M6 18h8" stroke-linecap="round"/></svg>`,
  vedacao: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 19V6M12 19V6M18 19V6M6 9h12M6 14h12" stroke-linecap="round"/></svg>`,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
