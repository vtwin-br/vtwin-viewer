import type { LoadedIfc } from "../ifc/modelSet";
import { DND_LAYER, clearDrops, getDragJson, hasType, markDrop, setDragJson } from "./dnd";

export interface ModelLayersOptions {
  onToggle: (id: string, visible: boolean) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onReorder?: (id: string, beforeId: string | null) => void;
}

/**
 * Menu do cabeçalho: modelos carregados, visibilidade, modelo ativo e importação.
 */
export class ModelLayersUI {
  private readonly root: HTMLElement;
  private readonly opts: ModelLayersOptions;

  constructor(root: HTMLElement, opts: ModelLayersOptions) {
    this.root = root;
    this.opts = opts;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Modelos IFC");
    root.addEventListener("click", this.onClick);
    root.addEventListener("dragstart", this.onDragStart);
    root.addEventListener("dragend", this.onDragEnd);
    root.addEventListener("dragover", this.onDragOver);
    root.addEventListener("drop", this.onDrop);
  }

  render(models: LoadedIfc[], activeId: string | null): void {
    if (!models.length) {
      this.root.innerHTML = "";
      return;
    }
    const rows = models
      .map((m) => {
        const on = m.visible;
        const active = m.id === activeId;
        return `<article class="ml-row${on ? "" : " is-off"}${active ? " is-active" : ""}" data-id="${escapeAttr(m.id)}" draggable="true">
          <span class="ml-grip" title="Reordenar" aria-hidden="true"></span>
          <button type="button" class="ml-eye" data-act="toggle" title="${on ? "Ocultar no viewer" : "Mostrar no viewer"}" aria-pressed="${on ? "true" : "false"}" aria-label="${on ? "Ocultar" : "Mostrar"} ${escapeAttr(m.displayName)}">
            <span class="ml-swatch" style="background:${escapeAttr(m.color)}"></span>
            ${on ? ICON_EYE : ICON_EYE_OFF}
          </button>
          <button type="button" class="ml-name" data-act="select" title="${active ? "Modelo ativo" : "Definir como ativo"}">
            <strong>${escapeHtml(m.displayName)}</strong>
            ${active ? `<span class="ml-tag">Ativo</span>` : ""}
            ${m.session.dirty ? `<em class="ml-dirty">•</em>` : ""}
          </button>
          <button type="button" class="ml-remove" data-act="remove" title="Remover" aria-label="Remover ${escapeAttr(m.displayName)}">${ICON_CLOSE}</button>
        </article>`;
      })
      .join("");
    this.root.innerHTML = `<header class="ml-head">
        <span>Modelos</span>
        <span class="ml-count">${models.length}</span>
      </header>
      <div class="ml-list">${rows}</div>
      <button type="button" class="ml-add" data-act="add">${ICON_PLUS} Adicionar IFC</button>`;
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

  private onDragStart = (e: DragEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!row?.dataset.id || !e.dataTransfer) return;
    setDragJson(e.dataTransfer, DND_LAYER, row.dataset.id, "move");
    row.classList.add("is-dragging");
  };

  private onDragEnd = () => {
    this.root.querySelectorAll(".is-dragging, .is-drop-ready").forEach((el) => {
      el.classList.remove("is-dragging", "is-drop-ready");
    });
  };

  private onDragOver = (e: DragEvent) => {
    if (!hasType(e, DND_LAYER)) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!row) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearDrops(this.root);
    markDrop(row, true);
  };

  private onDrop = (e: DragEvent) => {
    clearDrops(this.root);
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const fromId = getDragJson<string>(e.dataTransfer, DND_LAYER);
    if (!fromId) return;
    e.preventDefault();
    this.opts.onReorder?.(fromId, row?.dataset.id ?? null);
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>`;
const ICON_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 3l18 18M10.5 6.2A9 9 0 0121 12s-2 3.5-5.2 5.5M6.2 8.5C4.2 9.9 3 12 3 12s4 7 10 7a10 10 0 003.3-.5"/><path d="M9.9 9.9a3 3 0 104.2 4.2"/></svg>`;
