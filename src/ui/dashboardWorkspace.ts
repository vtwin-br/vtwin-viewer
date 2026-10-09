import { fetchAiStatus, type AiStatus, type AiThinking } from "../ai/client";
import { consultDashboard, resolveConsultGuids } from "../dashboard/consult";
import { downloadDashFile, type DashFile } from "../dashboard/files";
import { compressChatImage } from "../dashboard/images";
import { guidsForKpi, KPI_DEFAULT_ON, KPI_GROUPS, KPI_LABELS, KPI_ORDER, type DashboardKpis, type KpiId } from "../dashboard/kpis";
import { formatChatMarkdown } from "../dashboard/markdown";
import type { DashPaintPlan } from "../dashboard/paint";
import { buildDashboardSnapshot, type DashboardSnapshot } from "../dashboard/snapshot";
import { fromInputDate } from "../projectPlan/dates";
import type { BimCatalog } from "../projectPlan/bimCatalog";
import type { ScheduleData } from "../schedule/types";
import { navIcon } from "./navIcons";

export type DashLayout = "columns" | "wide";

export interface DashboardWorkspaceOptions {
  getSchedule: () => ScheduleData | null;
  getDate: () => Date;
  getModels: () => Array<{ id: string; name: string; visible: boolean }>;
  getProjectName: () => string;
  getProductCount: () => number;
  getSelectedGuids: () => string[];
  loadCatalog: () => Promise<BimCatalog | null>;
  onDateChange: (date: Date) => void;
  onFocusGuids: (guids: string[], label?: string) => void;
  onPaintModel: (plan: DashPaintPlan) => void;
  getAllGuids: () => string[];
  onRevealAll: () => void;
  onHideKpis: () => void;
  onHideChat: () => void;
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  pending?: boolean;
  actionLabel?: string;
  files?: DashFile[];
  images?: Array<{ name: string; dataUrl: string }>;
}

const LS_LAYOUT = "vista4d.dashLayout";
const LS_KPIS = "vista4d.dashKpis";
const LS_THINKING = "vista4d.dashThinking";
const MAX_CHAT_IMAGES = 4;
const SUGGESTIONS = [
  "Qual o avanço físico e 5D nesta data?",
  "Destaque no modelo os elementos sem vínculo ao cronograma.",
  "Pinta o executado a verde e o que ainda não começou a vermelho.",
  "Mapa de custo das colunas: caro vermelho, barato verde.",
];

export class DashboardWorkspace {
  private kpisRoot: HTMLElement;
  private chatRoot: HTMLElement;
  private opts: DashboardWorkspaceOptions;
  private active = false;
  private layout: DashLayout = readLayout();
  private visibleKpis = readVisibleKpis();
  private kpis: DashboardKpis | null = null;
  private snapshot: DashboardSnapshot | null = null;
  private catalog: BimCatalog | null = null;
  private catalogGen = 0;
  private catalogBusy = false;
  private customizeOpen = false;
  private aiStatus: AiStatus = { configured: false, provider: "", model: "" };
  private turns: ChatTurn[] = [];
  private busy = false;
  private thinking: AiThinking = readThinking();
  private pendingImages: Array<{ name: string; dataUrl: string }> = [];
  private draft = "";
  private abort: AbortController | null = null;

  constructor(kpisRoot: HTMLElement, chatRoot: HTMLElement, opts: DashboardWorkspaceOptions) {
    this.kpisRoot = kpisRoot;
    this.chatRoot = chatRoot;
    this.opts = opts;
    this.kpisRoot.addEventListener("click", this.onKpisClick);
    this.kpisRoot.addEventListener("change", this.onKpisChange);
    this.kpisRoot.addEventListener("keydown", this.onKpisKey);
    this.chatRoot.addEventListener("click", this.onChatClick);
    this.chatRoot.addEventListener("change", this.onChatChange);
    this.chatRoot.addEventListener("submit", this.onChatSubmit);
    this.chatRoot.addEventListener("keydown", this.onChatKey);
    this.chatRoot.addEventListener("paste", this.onChatPaste);
    void this.refreshAiStatus();
    this.render();
  }

  setActive(on: boolean): void {
    this.active = on;
    this.kpisRoot.classList.toggle("is-active", on);
    this.chatRoot.classList.toggle("is-active", on);
    this.applyLayout();
    if (on) {
      this.refresh();
      void this.ensureCatalog();
    }
  }

  isActive(): boolean {
    return this.active;
  }

  getLayout(): DashLayout {
    return this.layout;
  }

  refresh(): void {
    this.rebuildSnapshot();
    this.render();
  }

  refreshKpis(): void {
    this.rebuildSnapshot();
    if (this.active) this.renderKpis();
  }

  invalidateCatalog(): void {
    this.catalog = null;
    this.catalogGen += 1;
    if (this.active) void this.ensureCatalog();
    else this.refresh();
  }

  private rebuildSnapshot(): void {
    const built = buildDashboardSnapshot({
      schedule: this.opts.getSchedule(),
      date: this.opts.getDate(),
      models: this.opts.getModels(),
      projectName: this.opts.getProjectName(),
      productCount: this.opts.getProductCount(),
      storeyCount: this.catalog?.storeyCount ?? 0,
      catalog: this.catalog,
      selectedGuids: this.opts.getSelectedGuids(),
    });
    this.kpis = built.kpis;
    this.snapshot = built.snapshot;
  }

  private async ensureCatalog(): Promise<void> {
    if (this.catalog || this.catalogBusy) return;
    const gen = this.catalogGen;
    this.catalogBusy = true;
    this.renderKpis();
    try {
      const catalog = await this.opts.loadCatalog();
      if (gen !== this.catalogGen) return;
      this.catalog = catalog;
    } catch {
      if (gen !== this.catalogGen) return;
      this.catalog = null;
    } finally {
      if (gen === this.catalogGen) this.catalogBusy = false;
      this.refresh();
    }
  }

  private async refreshAiStatus(): Promise<void> {
    this.aiStatus = await fetchAiStatus();
    if (this.active) this.renderChat();
  }

  private applyLayout(): void {
    const grid = document.querySelector(".body-grid");
    grid?.setAttribute("data-dash-layout", this.layout);
  }

  private setLayout(layout: DashLayout): void {
    this.layout = layout;
    writeLayout(layout);
    this.applyLayout();
    this.renderKpis();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  private render(): void {
    this.applyLayout();
    this.renderKpis();
    this.renderChat();
  }

  private renderKpis(): void {
    const k = this.kpis;
    const empty = !k?.hasModel && !k?.hasPlan;
    this.kpisRoot.innerHTML = `
      <header class="dash-pane-head">
        <div>
          <h2>Indicadores</h2>
          <p>${empty ? "Abra um IFC ou .vtwin" : escapeHtml(k?.modelLabel ?? "Projeto")}</p>
        </div>
        <div class="dash-pane-actions">
          <div class="dash-seg" role="group" aria-label="Disposição">
            <button type="button" class="${this.layout === "columns" ? "is-active" : ""}" data-dash-layout="columns" title="Três colunas" aria-pressed="${this.layout === "columns"}">Colunas</button>
            <button type="button" class="${this.layout === "wide" ? "is-active" : ""}" data-dash-layout="wide" title="Modelo amplo" aria-pressed="${this.layout === "wide"}">Amplo</button>
          </div>
          <button type="button" class="dash-icon-btn" data-dash-act="customize" title="Indicadores visíveis" aria-expanded="${this.customizeOpen}">${ICON_SLIDERS}</button>
          <button type="button" class="dash-icon-btn" data-dash-act="hide-kpis" title="Ocultar indicadores">${navIcon("collapse")}</button>
        </div>
      </header>
      ${this.customizeOpen ? this.customizeHtml() : ""}
      ${KPI_GROUPS.map((group) => {
        const ids = group.ids.filter((id) => this.visibleKpis[id]);
        if (!ids.length) return "";
        return `<section class="dash-kpi-group">
          <h3>${escapeHtml(group.label)}</h3>
          <div class="dash-kpi-grid" data-layout="${this.layout}">
            ${ids.map((id) => this.kpiCard(id, k)).join("")}
          </div>
        </section>`;
      }).join("")}
    `;
    this.kpisRoot.querySelector("[data-dash-act='hide-kpis']")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.opts.onHideKpis();
    });
  }

  private customizeHtml(): string {
    return `<div class="dash-customize" role="group" aria-label="Mostrar indicadores">
      ${KPI_ORDER.map((id) => {
        const on = this.visibleKpis[id];
        return `<label class="dash-check"><input type="checkbox" data-kpi-toggle="${id}" ${on ? "checked" : ""}/> ${escapeHtml(KPI_LABELS[id])}</label>`;
      }).join("")}
    </div>`;
  }

  private kpiCard(id: KpiId, k: DashboardKpis | null): string {
    const clickable = id !== "calendar";
    const body = !k ? "—" : this.kpiBody(id, k);
    return `<article class="dash-kpi${clickable ? " is-action" : ""}" data-kpi="${id}" ${clickable ? `role="button" tabindex="0"` : ""}>
      <span class="dash-kpi-label">${escapeHtml(KPI_LABELS[id])}</span>
      ${body}
    </article>`;
  }

  private kpiBody(id: KpiId, k: DashboardKpis): string {
    if (id === "progress") {
      return `<strong>${k.hasPlan ? `${k.progressPct}%` : "—"}</strong>
        <span class="dash-kpi-sub">${k.done} de ${k.pending + k.active + k.done} folhas concluídas</span>
        ${bar(k.done, k.active, k.pending)}`;
    }
    if (id === "executing") {
      return `<strong>${k.hasPlan ? String(k.active) : "—"}</strong>
        <span class="dash-kpi-sub">folhas em execução nesta data</span>`;
    }
    if (id === "remaining") {
      return `<strong>${k.hasPlan ? String(k.pending) : "—"}</strong>
        <span class="dash-kpi-sub">folhas ainda por iniciar</span>`;
    }
    if (id === "cost") {
      return `<strong>${k.costTotal > 0 ? `${k.costPct}%` : "—"}</strong>
        <span class="dash-kpi-sub">${escapeHtml(k.costLabel)}</span>
        ${meter(k.costPct)}`;
    }
    if (id === "leftover") {
      return `<strong>${k.costTotal > 0 ? `${k.costLeftPct}%` : "—"}</strong>
        <span class="dash-kpi-sub">${escapeHtml(k.costLeftLabel)} por realizar</span>
        ${meter(k.costLeftPct)}`;
    }
    if (id === "unlinked") {
      return `<strong>${k.productCount ? String(k.unlinkedCount) : "—"}</strong>
        <span class="dash-kpi-sub">${k.unlinkedPct}% da geometria sem GUID no plano</span>
        ${meter(k.unlinkedPct)}`;
    }
    if (id === "undated") {
      return `<strong>${k.hasPlan ? String(k.undated) : "—"}</strong>
        <span class="dash-kpi-sub">folhas sem início/fim</span>`;
    }
    if (id === "link") {
      return `<strong>${k.productCount ? `${k.linkPct}%` : "—"}</strong>
        <span class="dash-kpi-sub">${k.linkedGuids} GUIDs ligados · ${k.productCount} elementos</span>
        ${meter(k.linkPct)}`;
    }
    if (id === "model") {
      const extra = this.catalogBusy ? "a indexar famílias…" : k.storeyCount ? `${k.storeyCount} pisos` : "sem pisos";
      return `<strong>${k.modelCount || "—"}</strong>
        <span class="dash-kpi-sub">${k.productCount ? `${k.productCount} elementos` : "sem geometria"}${k.productCount || this.catalogBusy || k.storeyCount ? ` · ${escapeHtml(extra)}` : ""}</span>`;
    }
    const min = k.planStart ? toDateValue(k.planStart) : "";
    const max = k.planEnd ? toDateValue(k.planEnd) : "";
    return `<strong>${k.spanDays ? `${k.spanDays} d` : "—"}</strong>
      <span class="dash-kpi-sub">${escapeHtml(k.planStartLabel)} → ${escapeHtml(k.planEndLabel)}</span>
      <label class="dash-date">
        <span class="sr-only">Data de referência</span>
        <input type="date" data-dash-date ${min ? `min="${min}"` : ""} ${max ? `max="${max}"` : ""} value="${escapeAttr(k.asOfInput)}" />
      </label>`;
  }

  private renderChat(): void {
    const input = this.chatRoot.querySelector<HTMLTextAreaElement>("#dash-chat-input");
    if (input) this.draft = input.value;
    const status = this.aiStatus.configured
      ? `${this.aiStatus.provider} · ${this.aiStatus.model}`
      : "IA não configurada";
    const empty = this.turns.length === 0;
    this.chatRoot.innerHTML = `
      <header class="dash-pane-head">
        <div>
          <h2>Consulta</h2>
          <p>${escapeHtml(status)}</p>
        </div>
        <div class="dash-pane-actions">
          <button type="button" class="dash-icon-btn" data-dash-act="clear-chat" title="Limpar conversa" ${empty ? "disabled" : ""}>${ICON_CLEAR}</button>
          <button type="button" class="dash-icon-btn" data-dash-act="hide-chat" title="Ocultar chat">${navIcon("expand")}</button>
        </div>
      </header>
      <div class="dash-chat-log" data-dash-log>
        ${empty ? this.emptyChatHtml() : this.turns.map((t, i) => this.turnHtml(t, i)).join("")}
      </div>
      <form class="dash-chat-form" data-dash-form>
        <div class="dash-composer-tools">
          <button type="button" class="dash-icon-btn" data-dash-act="attach" title="Anexar imagem" ${this.busy ? "disabled" : ""}>${ICON_PAPERCLIP}</button>
          <input id="dash-chat-files" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple ${this.busy ? "disabled" : ""} />
          <label class="dash-thinking">
            <span>Pensamento</span>
            <select data-dash-thinking ${this.busy ? "disabled" : ""}>
              <option value="low"${this.thinking === "low" ? " selected" : ""}>Baixo</option>
              <option value="medium"${this.thinking === "medium" ? " selected" : ""}>Médio</option>
              <option value="high"${this.thinking === "high" ? " selected" : ""}>Alto</option>
            </select>
          </label>
        </div>
        ${this.pendingImages.length ? `<div class="dash-thumbs">${this.pendingImages.map((img, i) => `<figure class="dash-thumb"><img src="${escapeAttr(img.dataUrl)}" alt="${escapeAttr(img.name)}"/><button type="button" data-dash-remove-img="${i}" title="Remover">×</button></figure>`).join("")}</div>` : ""}
        <div class="dash-composer-row">
          <label class="sr-only" for="dash-chat-input">Perguntar ao modelo</label>
          <textarea id="dash-chat-input" rows="2" placeholder="${this.opts.getModels().length ? "Pergunte, anexe uma imagem ou peça um Excel" : "Abra um modelo para consultar"}" ${this.busy ? "disabled" : ""}>${escapeHtml(this.draft)}</textarea>
          ${this.busy
            ? `<button type="button" class="dash-stop" data-dash-act="stop">Parar</button>`
            : `<button type="submit" class="btn-primary dash-send">Enviar</button>`}
        </div>
      </form>
    `;
    this.chatRoot.querySelector("[data-dash-act='hide-chat']")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.opts.onHideChat();
    });
    this.scrollChat();
  }

  private emptyChatHtml(): string {
    if (!this.aiStatus.configured) {
      return `<div class="dash-chat-empty">
        <p>A chave de IA fica no servidor (<code>.env</code> · <code>AI_API_KEY</code>). Sem ela o chat não consulta o modelo.</p>
      </div>`;
    }
    if (!this.opts.getModels().length) {
      return `<div class="dash-chat-empty"><p>Abra um IFC ou projeto .vtwin. O chat usa o modelo e o plano carregados.</p></div>`;
    }
    return `<div class="dash-chat-empty">
      <p>Pergunte em linguagem natural, peça um Excel ou um destaque colorido no modelo 3D.</p>
      <div class="dash-suggest">
        ${SUGGESTIONS.map((s) => `<button type="button" data-dash-suggest="${escapeAttr(s)}">${escapeHtml(s)}</button>`).join("")}
      </div>
    </div>`;
  }

  private turnHtml(turn: ChatTurn, index: number): string {
    const action = turn.actionLabel ? `<span class="dash-action">${escapeHtml(turn.actionLabel)}</span>` : "";
    const thumbs = turn.images?.length
      ? `<div class="dash-thumbs">${turn.images.map((img) => `<figure class="dash-thumb"><img src="${escapeAttr(img.dataUrl)}" alt="${escapeAttr(img.name)}"/></figure>`).join("")}</div>`
      : "";
    const files = turn.files?.length
      ? `<div class="dash-files">${turn.files
          .map(
            (file, j) =>
              `<button type="button" class="dash-file-btn" data-dash-dl="${index}:${j}">${ICON_DOWNLOAD} ${escapeHtml(file.name)}</button>`,
          )
          .join("")}</div>`
      : "";
    const thoughts = turn.role === "assistant" && (turn.thinking || turn.pending)
      ? `<details class="dash-thoughts"${turn.pending && !turn.text ? " open" : ""} data-dash-thoughts>
          <summary>${turn.thinking ? "Pensamento" : "A consultar o modelo…"}</summary>
          <pre data-dash-thoughts-body>${escapeHtml(turn.thinking || "")}</pre>
        </details>`
      : "";
    return `<div class="dash-bubble dash-bubble-${turn.role}${turn.pending ? " is-pending" : ""}"${turn.pending ? " data-dash-stream" : ""}>
      ${thumbs}
      ${thoughts}
      <div class="dash-bubble-text" data-dash-stream-text>${turn.role === "assistant" ? formatChatMarkdown(turn.text) : escapeHtml(turn.text)}</div>
      ${action}
      ${files}
    </div>`;
  }

  private scrollChat(): void {
    const log = this.chatRoot.querySelector("[data-dash-log]");
    if (log) log.scrollTop = log.scrollHeight;
  }

  private onKpisClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const layoutBtn = t.closest<HTMLElement>("[data-dash-layout]");
    if (layoutBtn?.dataset.dashLayout === "columns" || layoutBtn?.dataset.dashLayout === "wide") {
      this.setLayout(layoutBtn.dataset.dashLayout);
      return;
    }
    const act = t.closest<HTMLElement>("[data-dash-act]")?.dataset.dashAct;
    if (act === "customize") {
      this.customizeOpen = !this.customizeOpen;
      this.renderKpis();
      return;
    }
    if (act === "hide-kpis") {
      this.opts.onHideKpis();
      return;
    }
    const card = t.closest<HTMLElement>("[data-kpi]");
    if (!card || t.closest("input,label,.dash-customize")) return;
    const id = card.dataset.kpi as KpiId;
    this.onKpiActivate(id);
  };

  private onKpisKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target as HTMLElement;
    if (target.closest("input,textarea,label,.dash-customize")) return;
    const card = target.closest<HTMLElement>("[data-kpi]");
    if (!card) return;
    e.preventDefault();
    this.onKpiActivate(card.dataset.kpi as KpiId);
  };

  private onKpisChange = (e: Event) => {
    const t = e.target as HTMLInputElement;
    const toggle = t.getAttribute("data-kpi-toggle") as KpiId | null;
    if (toggle && KPI_ORDER.includes(toggle)) {
      const next = { ...this.visibleKpis, [toggle]: t.checked };
      if (!KPI_ORDER.some((id) => next[id])) next[toggle] = true;
      this.visibleKpis = next;
      writeVisibleKpis(next);
      this.renderKpis();
      return;
    }
    if (t.hasAttribute("data-dash-date")) {
      const date = fromInputDate(t.value);
      if (date) {
        this.opts.onDateChange(date);
        this.refresh();
      }
    }
  };

  private onKpiActivate(id: KpiId): void {
    if (id === "model") {
      this.opts.onRevealAll();
      return;
    }
    const focus = guidsForKpi(id, {
      schedule: this.opts.getSchedule(),
      date: this.opts.getDate(),
      catalog: this.catalog,
      allGuids: this.opts.getAllGuids(),
    });
    if (!focus.isolate || !focus.guids.length) return;
    const color =
      id === "progress" ? "#16a34a" : id === "executing" ? "#d97706" : id === "remaining" || id === "leftover" ? "#dc2626" : id === "unlinked" ? "#c026d3" : "#38bdf8";
    this.opts.onPaintModel({
      isolate: true,
      clear: false,
      label: focus.label,
      groups: [{ guids: focus.guids, color }],
    });
  }

  private onChatClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-dash-act]")?.dataset.dashAct;
    if (act === "hide-chat") {
      this.opts.onHideChat();
      return;
    }
    if (act === "clear-chat") {
      this.turns = [];
      this.pendingImages = [];
      this.draft = "";
      this.renderChat();
      return;
    }
    if (act === "attach") {
      this.chatRoot.querySelector<HTMLInputElement>("#dash-chat-files")?.click();
      return;
    }
    if (act === "stop") {
      this.abort?.abort();
      return;
    }
    const remove = t.closest<HTMLElement>("[data-dash-remove-img]")?.dataset.dashRemoveImg;
    if (remove != null) {
      const i = Number(remove);
      if (Number.isInteger(i)) this.pendingImages.splice(i, 1);
      this.renderChat();
      return;
    }
    const dl = t.closest<HTMLElement>("[data-dash-dl]")?.dataset.dashDl;
    if (dl) {
      const [ti, fi] = dl.split(":").map(Number);
      const file = this.turns[ti]?.files?.[fi];
      if (file) downloadDashFile(file);
      return;
    }
    const suggest = t.closest<HTMLElement>("[data-dash-suggest]")?.dataset.dashSuggest;
    if (suggest) void this.send(suggest);
  };

  private onChatChange = (e: Event) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLSelectElement && t.hasAttribute("data-dash-thinking")) {
      const next = parseThinking(t.value);
      this.thinking = next;
      writeThinking(next);
      return;
    }
    if (t instanceof HTMLInputElement && t.id === "dash-chat-files" && t.files?.length) {
      const files = [...t.files];
      t.value = "";
      void this.addImages(files);
    }
  };

  private onChatPaste = (e: ClipboardEvent) => {
    const fromFiles = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    const fromItems: File[] = [];
    for (const item of e.clipboardData?.items ?? []) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) fromItems.push(file);
    }
    const items = fromFiles.length ? fromFiles : fromItems;
    if (!items.length) return;
    e.preventDefault();
    void this.addImages(items);
  };

  private async addImages(files: File[]): Promise<void> {
    const room = MAX_CHAT_IMAGES - this.pendingImages.length;
    if (room <= 0) return;
    try {
      const next = await Promise.all(files.slice(0, room).map(compressChatImage));
      this.pendingImages.push(...next);
      this.renderChat();
    } catch (err) {
      this.turns.push({ role: "assistant", text: (err as Error).message || "Não foi possível anexar a imagem." });
      this.renderChat();
    }
  };

  private onChatSubmit = (e: Event) => {
    e.preventDefault();
    const input = this.chatRoot.querySelector<HTMLTextAreaElement>("#dash-chat-input");
    const text = input?.value.trim() ?? "";
    if (text || this.pendingImages.length) void this.send(text);
  };

  private onChatKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const input = e.target as HTMLElement;
    if (input.id !== "dash-chat-input") return;
    e.preventDefault();
    const text = (input as HTMLTextAreaElement).value.trim();
    if (text || this.pendingImages.length) void this.send(text);
  };

  private async send(prompt: string): Promise<void> {
    if (this.busy) return;
    const images = this.pendingImages.slice(0, MAX_CHAT_IMAGES);
    if (!prompt.trim() && !images.length) return;
    this.pendingImages = [];
    this.draft = "";
    this.turns.push({
      role: "user",
      text: prompt.trim() || "(imagem anexada)",
      images: images.length ? images : undefined,
    });
    const assistant: ChatTurn = { role: "assistant", text: "", thinking: "", pending: true };
    this.turns.push(assistant);
    this.busy = true;
    this.abort = new AbortController();
    this.renderChat();
    try {
      if (!this.aiStatus.configured) await this.refreshAiStatus();
      await this.ensureCatalog();
      this.rebuildSnapshot();
      if (!this.snapshot) throw new Error("Sem snapshot do projeto.");
      const history = this.turns
        .slice(0, -2)
        .filter((t) => t.role === "user" || t.role === "assistant")
        .map((t) => ({ role: t.role, content: t.text }));
      const reply = await consultDashboard({
        snapshot: this.snapshot,
        history,
        prompt,
        images,
        thinking: this.thinking,
        paintCtx: {
          schedule: this.opts.getSchedule(),
          date: this.opts.getDate(),
          catalog: this.catalog,
          allGuids: this.opts.getAllGuids(),
        },
        signal: this.abort.signal,
        onEvent: (event) => {
          if (event.thinking) assistant.thinking = event.thinking;
          if (event.content) assistant.text = event.content;
          this.patchStream(assistant);
        },
      });
      assistant.pending = false;
      assistant.text = reply.answer;
      assistant.thinking = reply.thinking || assistant.thinking;
      assistant.files = reply.files.length ? reply.files : undefined;
      if (reply.paint?.clear || reply.action?.clear) {
        this.opts.onRevealAll();
        assistant.actionLabel = "Modelo completo";
      } else if (reply.paint?.groups.length) {
        this.opts.onPaintModel(reply.paint);
        assistant.actionLabel = reply.paint.label;
      } else if (reply.action) {
        const guids = resolveConsultGuids(reply.action, this.catalog, this.opts.getSchedule());
        if (guids.length) {
          const label = reply.action.label || `${guids.length} elementos`;
          this.opts.onFocusGuids(guids, label);
          assistant.actionLabel = label;
        }
      }
    } catch (err) {
      assistant.pending = false;
      if ((err as Error).name === "AbortError") {
        assistant.text = assistant.text.trim() ? `${assistant.text.trim()}\n\nPedido cancelado.` : "Pedido cancelado.";
      } else {
        assistant.text = (err as Error).message || "Falha ao consultar a IA.";
      }
    } finally {
      assistant.pending = false;
      this.busy = false;
      this.abort = null;
      this.renderChat();
    }
  }

  private patchStream(turn: ChatTurn): void {
    const root = this.chatRoot.querySelector("[data-dash-stream]");
    if (!root) return;
    const details = root.querySelector<HTMLDetailsElement>("[data-dash-thoughts]");
    const body = root.querySelector("[data-dash-thoughts-body]");
    const summary = details?.querySelector("summary");
    const text = root.querySelector("[data-dash-stream-text]");
    if (details && body && summary) {
      details.hidden = false;
      if (turn.thinking) {
        summary.textContent = "Pensamento";
        body.textContent = turn.thinking;
      }
    }
    if (text) text.innerHTML = formatChatMarkdown(turn.text);
    this.scrollChat();
  }
}

function bar(done: number, active: number, pending: number): string {
  const total = done + active + pending;
  if (!total) return `<span class="dash-bar is-empty"></span>`;
  return `<span class="dash-bar" aria-hidden="true">
    ${done ? `<i class="is-done" style="flex:${done}"></i>` : ""}
    ${active ? `<i class="is-active" style="flex:${active}"></i>` : ""}
    ${pending ? `<i class="is-pending" style="flex:${pending}"></i>` : ""}
  </span>`;
}

function meter(pct: number): string {
  const n = Math.max(0, Math.min(100, pct));
  return `<span class="dash-meter"><i style="width:${n}%"></i></span>`;
}

function toDateValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readLayout(): DashLayout {
  try {
    const v = localStorage.getItem(LS_LAYOUT);
    if (v === "wide" || v === "columns") return v;
  } catch {
    /* ignore */
  }
  return "columns";
}

function writeLayout(layout: DashLayout): void {
  try {
    localStorage.setItem(LS_LAYOUT, layout);
  } catch {
    /* ignore */
  }
}

function readVisibleKpis(): Record<KpiId, boolean> {
  const all = { ...KPI_DEFAULT_ON };
  try {
    const raw = localStorage.getItem(LS_KPIS);
    if (!raw) return all;
    const parsed = JSON.parse(raw) as Partial<Record<KpiId, boolean>>;
    for (const id of KPI_ORDER) {
      if (typeof parsed[id] === "boolean") all[id] = parsed[id]!;
    }
  } catch {
    /* ignore */
  }
  if (!KPI_ORDER.some((id) => all[id])) all.progress = true;
  return all;
}

function writeVisibleKpis(v: Record<KpiId, boolean>): void {
  try {
    localStorage.setItem(LS_KPIS, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function parseThinking(value: string): AiThinking {
  if (value === "medium" || value === "high" || value === "low") return value;
  return "low";
}

function readThinking(): AiThinking {
  try {
    return parseThinking(localStorage.getItem(LS_THINKING) ?? "low");
  } catch {
    return "low";
  }
}

function writeThinking(value: AiThinking): void {
  try {
    localStorage.setItem(LS_THINKING, value);
  } catch {
    /* ignore */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

const ICON_SLIDERS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7" stroke-linecap="round"/><circle cx="16" cy="12" r="2"/><circle cx="13" cy="17" r="2"/></svg>`;
const ICON_CLEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_PAPERCLIP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 12.5 15 6a3.2 3.2 0 0 1 4.5 4.5l-8.2 8.2a4.4 4.4 0 0 1-6.2-6.2l7.5-7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 4v12m0 0 4-4m-4 4-4-4M5 19h14" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
