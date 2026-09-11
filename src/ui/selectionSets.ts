import type { SelectionGroup } from "../schedule/types";

export interface SelectionSetsOptions {
  onCreate: () => void;
  onRename: (groupId: number, name: string) => void;
  onDelete: (groupId: number) => void;
  onSelect: (groupId: number) => void;
  onAddSelection: (groupId: number) => void;
  onAssign: (groupId: number) => void;
}

export class SelectionSetsList {
  private root: HTMLElement;
  private opts: SelectionSetsOptions;
  private selectedId: number | null = null;
  private taskId: number | null = null;

  constructor(root: HTMLElement, opts: SelectionSetsOptions) {
    this.root = root;
    this.opts = opts;
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("change", this.onChange);
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

  render(groups: SelectionGroup[]): void {
    if (!groups.length) {
      this.root.innerHTML = `<p class="ms-empty">Nenhum conjunto. Selecione elementos no modelo ou na árvore e clique em «Novo conjunto».</p>`;
      return;
    }
    this.root.innerHTML = groups
      .map((g) => {
        const selected = g.id === this.selectedId ? " is-selected" : "";
        const linked = this.taskId != null && g.taskIds.includes(this.taskId);
        return `<article class="ms-set${selected}" data-id="${g.id}">
          <button type="button" class="ms-set-main" data-act="select">
            <strong>${escapeHtml(g.name)}</strong>
            <span>${g.productGuids.length} elemento${g.productGuids.length === 1 ? "" : "s"}</span>
            ${linked ? `<em>ligado à tarefa</em>` : ""}
          </button>
          <input class="ms-set-name" data-act="rename" value="${escapeAttr(g.name)}" aria-label="Nome do conjunto" />
          <div class="ms-set-actions">
            <button type="button" data-act="add">+ seleção</button>
            <button type="button" data-act="assign">${linked ? "Desligar" : "Ligar à tarefa"}</button>
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
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
