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
  onPlay: () => void;
  onPresent: (on: boolean) => void;
  onAssetAction: (action: "rotate" | "remove") => void;
}

/** Painel curto do plano de canteiro: biblioteca, fase e quantidades. */
export class SitePlanner {
  private libraryKey = "";
  private phaseId = 0;
  private selectedGuid = "";
  private presenting = false;

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
    if (!active) return;
    if (!this.opts.hasModel()) {
      this.root.innerHTML = `<p class="site-lead">Abra o IFC da obra. Depois escolha um equipamento, uma fase, e clique no modelo para o pousar.</p>`;
      return;
    }
    const schedule = this.opts.getSchedule();
    const phases = sitePhases(schedule);
    if (!this.phaseId || !phases.some((phase) => phase.id === this.phaseId)) this.phaseId = phases[0]?.id ?? 0;
    const phase = phases.find((item) => item.id === this.phaseId) ?? null;
    const assets = this.opts.sessions().flatMap((session) => session.listSiteAssets());
    const lines = schedule && phase ? phaseQuantities(schedule, assets, phase) : [];
    const placed = assets.length;
    this.root.innerHTML = `
      <p class="site-lead">Escolha o equipamento e a fase. Clique no modelo para pousar. Exportar IFC grava a peça, a fase e as quantidades.</p>
      <div class="site-library">
        ${SITE_LIBRARY.map(
          (item) =>
            `<button type="button" class="site-card${item.key === this.libraryKey ? " is-on" : ""}" data-act="library" data-key="${item.key}">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.hint)}</span>
            </button>`,
        ).join("")}
      </div>
      <h3 class="site-label">Fase</h3>
      ${
        phases.length
          ? `<div class="site-phases">${phases
              .map(
                (item) =>
                  `<button type="button" class="site-chip${item.id === this.phaseId ? " is-on" : ""}" data-act="phase" data-id="${item.id}">${escapeHtml(item.name)}</button>`,
              )
              .join("")}</div>`
          : `<p class="site-note">Este cronograma não tem fases com data. O 4D precisa de IfcTask com IfcTaskTime.</p>`
      }
      <div class="site-tools">
        <button type="button" class="btn-secondary" data-act="rotate" ${this.selectedGuid ? "" : "disabled"}>Rodar 45°</button>
        <button type="button" class="btn-secondary" data-act="remove" ${this.selectedGuid ? "" : "disabled"}>Apagar</button>
        <button type="button" class="btn-secondary" data-act="play">Reproduzir</button>
        <button type="button" class="btn-primary${this.presenting ? " is-on" : ""}" data-act="present">${this.presenting ? "Sair da apresentação" : "Apresentar"}</button>
      </div>
      <h3 class="site-label">Quantidades${phase ? ` · ${escapeHtml(phase.name)}` : ""}</h3>
      ${
        lines.length
          ? `<ul class="site-quantities">${lines
              .map(
                (line) =>
                  `<li><span>${escapeHtml(line.name)}</span><strong>${escapeHtml(formatQuantity(line))}</strong></li>`,
              )
              .join("")}</ul>`
          : `<p class="site-note">${placed ? "Nada desta fase no canteiro." : "Ainda não há equipamentos pousados."}</p>`
      }
    `;
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
    if (act === "play") {
      this.opts.onPlay();
      return;
    }
    if (act === "present") {
      this.presenting = !this.presenting;
      this.opts.onPresent(this.presenting);
      this.refresh();
      return;
    }
    if (act === "rotate" || act === "remove") this.opts.onAssetAction(act);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
