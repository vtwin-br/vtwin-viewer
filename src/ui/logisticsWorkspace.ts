import { applyExtraToThree, type ModelExtraTransform } from "../ifc/georef";
import { polygonAreaAbs } from "../logistics/polygon";
import { siteLimitElevation, type SiteLimit } from "../logistics/types";

export interface LogisticsWorkspaceOptions {
  hasModel: () => boolean;
  getLimit: () => SiteLimit | null;
  getExtra: () => ModelExtraTransform;
  onDraw: () => void;
  onFinishDraw: () => void;
  onCancelDraw: () => void;
  onPatch: (patch: Partial<SiteLimit>) => void;
  onDelete: () => void;
}

export class LogisticsWorkspace {
  private root: HTMLElement;
  private opts: LogisticsWorkspaceOptions;
  private drawing = false;

  constructor(root: HTMLElement, opts: LogisticsWorkspaceOptions) {
    this.root = root;
    this.opts = opts;
    this.render();
  }

  setDrawing(on: boolean): void {
    this.drawing = on;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    const hasModel = this.opts.hasModel();
    const limit = this.opts.getLimit();
    const extra = this.opts.getExtra();
    const elev = limit ? siteLimitElevation(limit) : 0;
    const area = limit
      ? polygonAreaAbs(limit.points.map((p) => {
          const w = applyExtraToThree(p, extra);
          return { x: w.x, z: w.z };
        }))
      : 0;

    this.root.innerHTML = `
      <div class="log-body">
        <p class="log-lead">Limite de intervenção no terreno. Com o Google ligado, a malha é cortada no perímetro exterior e um talude liga essa aresta ao platô à cota de projeto.</p>
        ${
          !hasModel
            ? `<p class="log-empty">Abre um IFC para gravar o canteiro no <span class="mono">IfcSite</span>.</p>`
            : this.drawing
              ? `<div class="log-draft">
                  <p>Clica no terreno para os vértices. <kbd>Enter</kbd> fecha · <kbd>Esc</kbd> cancela · <kbd>Backspace</kbd> desfaz.</p>
                  <div class="log-actions">
                    <button type="button" class="log-btn log-btn-primary" id="log-finish" disabled>Fechar polígono</button>
                    <button type="button" class="log-btn" id="log-cancel">Cancelar</button>
                  </div>
                </div>`
              : `<div class="log-actions">
                  <button type="button" class="log-btn log-btn-primary" id="log-draw">${limit ? "Redesenhar limite" : "Desenhar limite"}</button>
                  ${limit ? `<button type="button" class="log-btn log-btn-danger" id="log-delete">Apagar</button>` : ""}
                </div>`
        }
        ${
          limit
            ? `<section class="log-card">
                <div class="log-stat">
                  <span>${limit.points.length} vértices</span>
                  <span>${formatArea(area)}</span>
                </div>
                <label class="log-field">
                  <span>Nome</span>
                  <input id="log-name" type="text" value="${escapeAttr(limit.name)}" />
                </label>
                <label class="log-field">
                  <span>Cota do platô</span>
                  <span class="log-unit">m · IFC Z</span>
                  <input id="log-elev" type="number" step="0.05" value="${round(elev, 3)}" />
                </label>
                <label class="log-check">
                  <input id="log-plateau" type="checkbox" ${limit.showPlateau ? "checked" : ""} />
                  <span>Mostrar platô</span>
                </label>
              </section>
              <section class="log-card">
                <h3>Recorte Google</h3>
                <p class="log-hint">O recorte coincide com o pé do talude, um anel estreito à volta do lote.</p>
                <label class="log-field">
                  <span>Abaixo do platô</span>
                  <span class="log-unit">m</span>
                  <input id="log-below" type="number" min="2" max="200" step="1" value="${round(limit.clipBelow, 1)}" />
                </label>
                <label class="log-field">
                  <span>Acima do platô</span>
                  <span class="log-unit">m</span>
                  <input id="log-above" type="number" min="8" max="200" step="1" value="${round(limit.clipAbove, 1)}" />
                </label>
                <label class="log-field">
                  <span>Talude</span>
                  <span class="log-unit">m</span>
                  <input id="log-buffer" type="number" min="0.8" max="2.5" step="0.1" value="${round(limit.clipBuffer > 2.5 ? 1.5 : limit.clipBuffer, 1)}" />
                </label>
              </section>`
            : hasModel && !this.drawing
              ? `<p class="log-empty">Ainda não há limite no IFC. Com o terreno ligado, desenha o lote à volta do modelo.</p>`
              : ""
        }
      </div>
    `;

    const finish = this.root.querySelector("#log-finish") as HTMLButtonElement | null;
    if (finish) finish.disabled = true;
    this.root.querySelector("#log-draw")?.addEventListener("click", () => this.opts.onDraw());
    this.root.querySelector("#log-finish")?.addEventListener("click", () => this.opts.onFinishDraw());
    this.root.querySelector("#log-cancel")?.addEventListener("click", () => this.opts.onCancelDraw());
    this.root.querySelector("#log-delete")?.addEventListener("click", () => this.opts.onDelete());
    this.bindPatch("log-name", (el) => ({ name: el.value.trim() || "Canteiro" }));
    this.bindPatch("log-elev", (el) => {
      const z = Number(el.value);
      if (!Number.isFinite(z) || !limit) return {};
      return { points: limit.points.map((p) => ({ ...p, z })) };
    });
    this.bindPatch("log-below", (el) => ({ clipBelow: num(el.value, 40) }));
    this.bindPatch("log-above", (el) => ({ clipAbove: num(el.value, 80) }));
    this.bindPatch("log-buffer", (el) => ({ clipBuffer: num(el.value, 1.5) }));
    this.root.querySelector("#log-plateau")?.addEventListener("change", (e) => {
      this.opts.onPatch({ showPlateau: (e.target as HTMLInputElement).checked });
    });
  }

  /** O botão Fechar só existe no HTML estático; o fecho real é Enter / duplo clique. */
  setDraftCount(n: number): void {
    const finish = this.root.querySelector("#log-finish") as HTMLButtonElement | null;
    if (finish) finish.disabled = n < 3;
    const p = this.root.querySelector(".log-draft p");
    if (p && this.drawing) {
      p.innerHTML = `${n} vértice${n === 1 ? "" : "s"}. <kbd>Enter</kbd> fecha · <kbd>Esc</kbd> cancela · <kbd>Backspace</kbd> desfaz.`;
    }
  }

  private bindPatch(id: string, read: (el: HTMLInputElement) => Partial<SiteLimit>): void {
    const el = this.root.querySelector(`#${id}`) as HTMLInputElement | null;
    if (!el) return;
    const commit = () => this.opts.onPatch(read(el));
    el.addEventListener("change", commit);
    if (el.type === "text") el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    });
  }
}

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v: number, d: number): string {
  const k = 10 ** d;
  return String(Math.round(v * k) / k);
}

function formatArea(m2: number): string {
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(2)} ha`;
  return `${Math.round(m2)} m²`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
