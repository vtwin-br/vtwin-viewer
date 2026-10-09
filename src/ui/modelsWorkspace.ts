import type { LoadedIfc } from "../ifc/modelSet";

export interface ModelsWorkspaceOptions {
  models: () => LoadedIfc[];
  onAdd: () => void;
  onUpdateVersion: (id: string) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, displayName: string) => void;
}

/**
 * Listagem das disciplinas IFC: nome, ficheiro, versão e atualização
 * (novo IFC → novo `.frag`, mesmo `modelId`). Sem viewport 3D.
 */
export class ModelsWorkspace {
  private root: HTMLElement;
  private opts: ModelsWorkspaceOptions;
  private busyId: string | null = null;
  private busyHint = "";
  private notices = new Map<string, string>();
  private pageBusy = false;

  constructor(root: HTMLElement, opts: ModelsWorkspaceOptions) {
    this.root = root;
    this.opts = opts;
    this.render();
  }

  setBusy(id: string | null, hint = ""): void {
    this.busyId = id;
    this.busyHint = hint;
    this.render();
  }

  setPageBusy(on: boolean, hint = ""): void {
    this.pageBusy = on;
    if (on) this.busyHint = hint;
    else if (!this.busyId) this.busyHint = "";
    this.render();
  }

  setNotice(id: string, text: string | null): void {
    if (text) this.notices.set(id, text);
    else this.notices.delete(id);
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    const models = this.opts.models();
    const busy = this.busyId;
    const converting = models.find((m) => m.id === busy);
    const overlayOn = this.pageBusy || !!converting;
    const overlayTitle = converting
      ? `A converter «${converting.displayName}»`
      : "A converter IFC";

    this.root.innerHTML = `
      <div class="mm-page">
        <header class="mm-head">
          <div>
            <h2>Modelos</h2>
            <p>Cada linha é uma disciplina. Atualizar a versão converte o IFC novo e substitui o .frag deste membro.</p>
          </div>
          <button type="button" class="mm-btn mm-btn-primary" id="mm-add"${busy || this.pageBusy ? " disabled" : ""}>Adicionar IFC</button>
        </header>
        ${
          !models.length
            ? `<p class="mm-empty">Ainda não há disciplinas. Abre um IFC ou um projeto .vtwin.</p>`
            : `<div class="mm-table-wrap">
                <table class="mm-table">
                  <thead>
                    <tr>
                      <th>Disciplina</th>
                      <th>Ficheiro</th>
                      <th>Versão</th>
                      <th>Atualizado</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${models.map((m) => this.rowHtml(m, busy || this.pageBusy ? busy ?? "__page" : null)).join("")}
                  </tbody>
                </table>
              </div>`
        }
        ${
          overlayOn
            ? `<div class="mm-overlay" aria-live="polite">
                <span class="spinner" aria-hidden="true"></span>
                <strong>${escapeHtml(overlayTitle)}</strong>
                <span>${escapeHtml(this.busyHint || "O IFC novo vira o .frag desta disciplina.")}</span>
              </div>`
            : ""
        }
      </div>
    `;

    this.root.querySelector("#mm-add")?.addEventListener("click", () => this.opts.onAdd());
    this.root.querySelectorAll<HTMLElement>("[data-mm]").forEach((el) => {
      const id = el.closest<HTMLElement>("[data-id]")?.dataset.id;
      if (!id) return;
      const act = el.dataset.mm;
      if (act === "update") el.addEventListener("click", () => this.opts.onUpdateVersion(id));
      else if (act === "remove") el.addEventListener("click", () => this.opts.onRemove(id));
    });
    this.root.querySelectorAll<HTMLInputElement>(".mm-name").forEach((input) => {
      const id = input.closest<HTMLElement>("[data-id]")?.dataset.id;
      if (!id) return;
      input.addEventListener("change", () => this.opts.onRename(id, input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        }
      });
    });
  }

  private rowHtml(m: LoadedIfc, busyId: string | null): string {
    const locked = !!busyId;
    const notice = this.notices.get(m.id);
    const prev = m.history.length ? m.history[m.history.length - 1] : null;
    return `<tr data-id="${escapeAttr(m.id)}"${m.id === busyId ? ` class="is-busy"` : ""}>
      <td>
        <input class="mm-name" type="text" value="${escapeAttr(m.displayName)}" ${locked ? "disabled" : ""} aria-label="Nome da disciplina" />
      </td>
      <td>
        <span class="mm-file" title="${escapeAttr(m.fileName)}">${escapeHtml(m.fileName)}</span>
        ${notice ? `<span class="mm-note">${escapeHtml(notice)}</span>` : ""}
      </td>
      <td>
        <span class="mm-ver">v${m.revision}</span>
        ${prev ? `<span class="mm-prev">antes v${prev.version}</span>` : ""}
      </td>
      <td class="mm-when">${formatWhen(m.revisedAt)}</td>
      <td class="mm-ops">
        <button type="button" class="mm-btn mm-btn-primary" data-mm="update"${locked ? " disabled" : ""}>Atualizar versão</button>
        <button type="button" class="mm-btn" data-mm="remove"${locked ? " disabled" : ""}>Remover</button>
      </td>
    </tr>`;
  }
}

function formatWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
