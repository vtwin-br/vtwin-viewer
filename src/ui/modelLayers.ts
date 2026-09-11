import type { LoadedIfc } from "../ifc/modelSet";

export interface ModelLayersOptions {
  onToggle: (id: string, visible: boolean) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

/**
 * Lista de IFCs carregados: ligar/desligar a vista, escolher o modelo ativo e remover.
 */
export class ModelLayersUI {
  private readonly roots: HTMLElement[];
  private readonly opts: ModelLayersOptions;

  constructor(root: HTMLElement | HTMLElement[], opts: ModelLayersOptions) {
    this.roots = Array.isArray(root) ? root : [root];
    this.opts = opts;
    for (const el of this.roots) el.addEventListener("click", this.onClick);
  }

  render(models: LoadedIfc[], activeId: string | null): void {
    for (const el of this.roots) {
      el.hidden = models.length === 0;
      if (!models.length) {
        el.innerHTML = "";
        continue;
      }
      const compact = el.dataset.compact === "1";
      const rows = models
        .map((m) => {
          const on = m.visible;
          const active = m.id === activeId;
          return `<article class="ml-row${on ? "" : " is-off"}${active ? " is-active" : ""}" data-id="${escapeAttr(m.id)}">
            <button type="button" class="ml-eye" data-act="toggle" title="${on ? "Ocultar este IFC" : "Mostrar este IFC"}" aria-pressed="${on ? "true" : "false"}">
              <span class="ml-swatch" style="background:${escapeAttr(m.color)}"></span>
              ${on ? ICON_EYE : ICON_EYE_OFF}
            </button>
            <button type="button" class="ml-name" data-act="select" title="Usar este IFC para edição e georreferência">
              <strong>${escapeHtml(m.displayName)}</strong>
              ${m.session.dirty ? `<em class="ml-dirty">por exportar</em>` : ""}
              ${active ? `<em class="ml-tag">ativo</em>` : ""}
            </button>
            ${compact ? "" : `<button type="button" class="ml-remove" data-act="remove" title="Remover este IFC da vista" aria-label="Remover">×</button>`}
          </article>`;
        })
        .join("");
      const add = compact
        ? ""
        : `<button type="button" class="ml-add" data-act="add">Adicionar IFC</button>`;
      el.innerHTML = `<header class="ml-head"><span>Modelos IFC</span><span class="ml-count">${models.length}</span></header>
        <div class="ml-list">${rows}</div>${add}`;
    }
  }

  private onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const row = btn.closest<HTMLElement>("[data-id]");
    const id = row?.dataset.id;
    if (act === "add") {
      this.opts.onAdd();
      return;
    }
    if (!id) return;
    if (act === "toggle") {
      const on = btn.getAttribute("aria-pressed") !== "true";
      this.opts.onToggle(id, on);
    } else if (act === "select") {
      this.opts.onSelect(id);
    } else if (act === "remove") {
      this.opts.onRemove(id);
    }
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

const ICON_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 3l18 18M10.5 6.2A9 9 0 0121 12s-2 3.5-5.2 5.5M6.2 8.5C4.2 9.9 3 12 3 12s4 7 10 7a10 10 0 003.3-.5"/><path d="M9.9 9.9a3 3 0 104.2 4.2"/></svg>`;
