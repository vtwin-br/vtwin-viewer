import type { SelectionGroup } from "../schedule/types";
import { DND_GROUP, DND_GUIDS, clearDrops, getDragJson, hasType, markDrop, setDragJson } from "./dnd";

export interface SelectionSetsOptions {
  onCreate: () => void;
  onRename: (groupId: number, name: string) => void;
  onDelete: (groupId: number) => void;
  onSelect: (groupId: number) => void;
  onAddSelection: (groupId: number) => void;
  onAssign: (groupId: number) => void;
  onDropGuids?: (groupId: number, guids: string[]) => void;
  onReorder?: (fromId: number, beforeId: number | null) => void;
}

export class SelectionSetsList {
  private root: HTMLElement;
  private opts: SelectionSetsOptions;
  private selectedId: number | null = null;
  private taskId: number | null = null;
  private hitIds = new Set<number>();

  constructor(root: HTMLElement, opts: SelectionSetsOptions) {
    this.root = root;
    this.opts = opts;
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("change", this.onChange);
    this.root.addEventListener("dragstart", this.onDragStart);
    this.root.addEventListener("dragend", this.onDragEnd);
    this.root.addEventListener("dragover", this.onDragOver);
    this.root.addEventListener("dragleave", this.onDragLeave);
    this.root.addEventListener("drop", this.onDrop);
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
  }

  getSelected(): number | null {
    return this.selectedId;
  }

  setTaskId(id: number | null): void {
    this.taskId = id;
  }

  private lastGroups: SelectionGroup[] = [];

  /** Destaca conjuntos que contêm algum GUID da seleção 3D. */
  markHits(guids: Iterable<string>, groups: SelectionGroup[]): void {
    const list = groups.length ? groups : this.lastGroups;
    const want = new Set(guids);
    this.hitIds = new Set(list.filter((g) => g.productGuids.some((id) => want.has(id))).map((g) => g.id));
    this.lastGroups = list;
    if (!this.root.querySelector(".ms-set")) {
      this.render(list);
      return;
    }
    this.root.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      const id = Number(el.dataset.id);
      el.classList.toggle("is-hit", this.hitIds.has(id));
    });
    this.root.querySelector<HTMLElement>(".ms-set.is-hit")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  hasHits(): boolean {
    return this.hitIds.size > 0;
  }

  render(groups: SelectionGroup[]): void {
    this.lastGroups = groups;
    if (!groups.length) {
      this.root.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M8 7V5h8v2" stroke-linecap="round"/></svg><span>Conjuntos</span></div>`;
      return;
    }
    this.root.innerHTML = groups
      .map((g) => {
        const selected = g.id === this.selectedId ? " is-selected" : "";
        const hit = this.hitIds.has(g.id) ? " is-hit" : "";
        const linked = this.taskId != null && g.taskIds.includes(this.taskId);
        return `<article class="ms-set${selected}${hit}" data-id="${g.id}" draggable="true">
          <button type="button" class="ms-set-main" data-act="select">
            <strong>${escapeHtml(g.name)}</strong>
            <span>${g.productGuids.length}</span>
            ${linked ? `<em>ligado</em>` : ""}
          </button>
          <input class="ms-set-name" data-act="rename" value="${escapeAttr(g.name)}" aria-label="Nome" />
          <div class="ms-set-actions">
            <button type="button" data-act="add">+</button>
            <button type="button" data-act="assign">${linked ? "Desligar" : "Ligar"}</button>
            <button type="button" data-act="delete" class="is-danger">Apagar</button>
          </div>
        </article>`;
      })
      .join("");
  }

  private onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!btn || !card) return;
    const id = Number(card.dataset.id);
    if (!Number.isFinite(id)) return;
    const act = btn.dataset.act;
    if (act === "select") {
      this.selectedId = id;
      this.opts.onSelect(id);
    }
    if (act === "add") this.opts.onAddSelection(id);
    if (act === "assign") this.opts.onAssign(id);
    if (act === "delete") this.opts.onDelete(id);
  };

  private onChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.act !== "rename") return;
    const card = input.closest<HTMLElement>("[data-id]");
    const id = Number(card?.dataset.id);
    if (!Number.isFinite(id)) return;
    this.opts.onRename(id, input.value);
  };

  private onDragStart = (e: DragEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, button")) {
      e.preventDefault();
      return;
    }
    const card = t.closest<HTMLElement>("[data-id]");
    if (!card || !e.dataTransfer) return;
    const id = Number(card.dataset.id);
    if (!Number.isFinite(id)) return;
    setDragJson(e.dataTransfer, DND_GROUP, id, "move");
    card.classList.add("is-dragging");
  };

  private onDragEnd = () => {
    this.root.querySelectorAll(".is-dragging, .is-drop-ready").forEach((el) => {
      el.classList.remove("is-dragging", "is-drop-ready");
    });
  };

  private onDragOver = (e: DragEvent) => {
    if (!hasType(e, DND_GUIDS) && !hasType(e, DND_GROUP)) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!card) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = hasType(e, DND_GUIDS) ? "copy" : "move";
    clearDrops(this.root);
    markDrop(card, true);
  };

  private onDragLeave = (e: DragEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const next = e.relatedTarget as Node | null;
    if (card && next && card.contains(next)) return;
    markDrop(card, false);
  };

  private onDrop = (e: DragEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    clearDrops(this.root);
    if (!card) return;
    const id = Number(card.dataset.id);
    if (!Number.isFinite(id)) return;
    const guids = getDragJson<string[]>(e.dataTransfer, DND_GUIDS);
    if (guids?.length) {
      e.preventDefault();
      this.opts.onDropGuids?.(id, guids);
      return;
    }
    const fromId = getDragJson<number>(e.dataTransfer, DND_GROUP);
    if (fromId != null && fromId !== id) {
      e.preventDefault();
      this.opts.onReorder?.(fromId, id);
    }
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
