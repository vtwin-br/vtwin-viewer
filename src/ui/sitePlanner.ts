import type { WorkspaceId } from "../app/catalog";
import { cutStatus, measuresForPhase, pathLength, poseOf, type SitePlan } from "../planning/sitePlan";
import type { MarkupDoc, MarkupItem, PdfOverlay, SlideShot, ViewerSidecar } from "../project/viewerPack";
import { sitePhases } from "../site/phases";
import type { ScheduleData } from "../schedule/types";

export type PlanTool =
  | "crane"
  | "truck"
  | "path"
  | "terrain"
  | "pin"
  | "box"
  | "balloon"
  | "hatch"
  | "polygon"
  | "pdf"
  | "fence"
  | "drill"
  | "mass"
  | "slide"
  | "view";

export interface PlanFieldEvent {
  id: string;
  field: string;
  value: string;
}

export interface SitePlannerOptions {
  getWorkspace: () => WorkspaceId;
  hasModel: () => boolean;
  getPlan: () => SitePlan;
  getSidecar: () => ViewerSidecar;
  getSchedule: () => ScheduleData | null;
  onAction: (action: string, detail: { id: string; value?: string }) => void;
  onField: (event: PlanFieldEvent) => void;
  onSelect?: (id: string) => void;
  onMode?: (placing: boolean) => void;
  onPdfFile?: (file: File) => void;
}

const NOTE_TOOLS: PlanTool[] = ["pin", "box", "balloon", "hatch", "polygon"];

/** Criar fica na lista. Editar abre a divisão só daquele elemento. */
export class SitePlanner {
  private toolKey: PlanTool | "" = "";
  private notesOpen = false;
  private phaseId = 0;
  private selectedId = "";
  private noteDraft = "";
  private pdfStep = "";
  private readonly pdfInput = document.createElement("input");

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: SitePlannerOptions,
  ) {
    this.pdfInput.type = "file";
    this.pdfInput.accept = "application/pdf";
    this.pdfInput.hidden = true;
    this.root.append(this.pdfInput);
    this.pdfInput.addEventListener("change", () => {
      const file = this.pdfInput.files?.[0];
      this.pdfInput.value = "";
      if (file) this.opts.onPdfFile?.(file);
    });
    this.root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLElement>("[data-act]");
      if (!button || button instanceof HTMLInputElement || button instanceof HTMLSelectElement) return;
      this.onClick(button.dataset.act || "", button);
    });
    const emitField = (target: EventTarget | null) => {
      if (target instanceof HTMLInputElement && target.dataset.role === "note") {
        this.noteDraft = target.value;
        return;
      }
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      const field = target.dataset.field;
      if (!field || !this.selectedId) return;
      this.opts.onField({ id: this.selectedId, field, value: target.value });
    };
    this.root.addEventListener("change", (event) => emitField(event.target));
    this.root.addEventListener("input", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "range") emitField(target);
    });
  }

  placing(): boolean {
    if (this.opts.getWorkspace() !== "site-plan" || !this.toolKey || this.toolKey === "view" || this.toolKey === "slide") return false;
    if (this.toolKey === "terrain" || !this.opts.hasModel()) return true;
    return this.phaseId > 0;
  }

  tool(): PlanTool | "" {
    return this.toolKey;
  }

  /** Liga o corte (ou outra ferramenta) direto na grade, sem mapa. */
  arm(tool: PlanTool | ""): void {
    this.toolKey = tool;
    this.refresh();
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

  setPdfStep(step: string): void {
    this.pdfStep = step;
    this.refresh();
  }

  selected(): string {
    return this.selectedId;
  }

  pickPdf(): void {
    this.toolKey = "pdf";
    this.pdfInput.click();
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
    const side = this.opts.getSidecar();
    const rows = rowsFor(plan, side.markups, phase);
    const selected = this.selectedId;
    const kind = kindOf(plan, side, selected);
    this.root.innerHTML = "";
    this.root.append(this.pdfInput);
    const placed = [...rows, ...slideRows(side)];
    const editing = kind
      ? contextBlock(kind, selected, plan, side, this.pdfStep)
      : this.toolKey === "view"
        ? cameraBlock(side)
        : this.toolKey === "slide"
          ? slideBlock(side)
          : this.toolKey === "pdf"
            ? pdfGuide()
            : "";
    this.root.insertAdjacentHTML(
      "beforeend",
      `${editing}
      ${
        placed.length
          ? `<p class="site-kicker">No canteiro</p><ul class="site-quantities">${placed
              .map(
                (line) =>
                  `<li><button type="button" class="site-line${line.id === selected ? " is-on" : ""}" data-act="item" data-id="${escapeHtml(line.id)}"><span>${escapeHtml(line.name)}</span>${line.measure ? `<span class="site-qty">${escapeHtml(line.measure)}</span>` : ""}</button></li>`,
              )
              .join("")}</ul>`
          : ""
      }
      <div class="site-library" role="listbox" aria-label="Planejamento">
        ${TOOLS.map((item) => piece(item.key, item.name, this.toolKey === item.key || (item.key === "pin" && this.notesOpen))).join("")}
      </div>
      ${
        this.notesOpen
          ? `<div class="site-phases">${NOTE_TOOLS.map(
              (key) =>
                `<button type="button" class="site-chip${this.toolKey === key ? " is-on" : ""}" data-act="tool" data-key="${key}">${NOTE_LABEL[key]}</button>`,
            ).join("")}</div>`
          : ""
      }
      ${
        this.toolKey === "pin" || this.toolKey === "box" || this.toolKey === "balloon" || this.toolKey === "hatch" || this.toolKey === "polygon"
          ? `<input class="site-note-input" data-role="note" value="${escapeHtml(this.noteDraft)}" placeholder="${NOTE_LABEL[this.toolKey]}" autocomplete="off" />`
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
      }`,
    );
    const placing =
      active &&
      !!this.toolKey &&
      this.toolKey !== "view" &&
      this.toolKey !== "slide" &&
      (this.toolKey === "terrain" || this.phaseId > 0 || !this.opts.hasModel());
    this.opts.onMode?.(placing);
  }

  private onClick(act: string, button: HTMLElement): void {
    if (act === "notes") {
      this.notesOpen = !this.notesOpen;
      if (this.notesOpen && !NOTE_TOOLS.includes(this.toolKey as PlanTool)) this.toolKey = "pin";
      if (!this.notesOpen && NOTE_TOOLS.includes(this.toolKey as PlanTool)) this.toolKey = "";
      this.refresh();
      return;
    }
    if (act === "pdf-pick") {
      this.pickPdf();
      return;
    }
    if (act === "tool") {
      const key = (button.dataset.key || "") as PlanTool;
      const next = this.toolKey === key ? "" : key;
      if (key === "pdf" && next === "pdf") this.pdfInput.click();
      this.toolKey = next;
      if (NOTE_TOOLS.includes(key)) this.notesOpen = true;
      this.refresh();
      return;
    }
    if (act === "phase") {
      this.phaseId = Number(button.dataset.id) || 0;
      this.refresh();
      return;
    }
    if (act === "item" || act === "camera-open") {
      this.selectedId = button.dataset.id || "";
      this.opts.onSelect?.(this.selectedId);
      if (act === "camera-open") this.opts.onAction(act, { id: this.selectedId });
      this.refresh();
      return;
    }
    if (!this.selectedId && act !== "camera-save" && act !== "slide-save" && act !== "slides-pdf" && act !== "slides-zip") return;
    this.opts.onAction(act, { id: this.selectedId, value: button.dataset.value });
  }
}

const TOOLS: { key: PlanTool | "pin"; name: string }[] = [
  { key: "crane", name: "Guindaste" },
  { key: "truck", name: "Camião" },
  { key: "fence", name: "Cerca" },
  { key: "drill", name: "Perfuratriz" },
  { key: "path", name: "Caminho" },
  { key: "terrain", name: "Terreno" },
  { key: "mass", name: "Volume" },
  { key: "pin", name: "Nota" },
  { key: "pdf", name: "PDF" },
  { key: "slide", name: "Slide" },
  { key: "view", name: "Vista" },
];

const NOTE_LABEL: Record<string, string> = {
  pin: "Pin",
  box: "Caixa",
  balloon: "Balão",
  hatch: "Hachura",
  polygon: "Polígono",
};

function piece(key: string, name: string, on: boolean): string {
  const act = key === "pin" ? "notes" : "tool";
  return `<button type="button" class="site-piece${on ? " is-on" : ""}" data-act="${act}" data-key="${key}" role="option" aria-selected="${on}">
    ${mark(key)}
    <span>${name}</span>
  </button>`;
}

function rowsFor(plan: SitePlan, markups: MarkupDoc, phase: { start?: Date; end?: Date } | null) {
  const rows = measuresForPhase(plan, phase);
  for (const item of markups.items) {
    rows.push({ id: item.id, name: NOTE_LABEL[item.kind] || "Nota", measure: item.text });
  }
  for (const pdf of markups.pdfs) rows.push({ id: pdf.id, name: "PDF", measure: pdf.name });
  return rows;
}

function slideRows(side: ViewerSidecar) {
  return side.slides.slides.map((slide) => ({ id: slide.id, name: slide.name, measure: slide.comment }));
}

function kindOf(plan: SitePlan, side: ViewerSidecar, id: string): string {
  if (!id) return "";
  if (plan.cranes.some((item) => item.id === id)) return "crane";
  if (plan.trucks.some((item) => item.id === id)) return "truck";
  if (plan.paths.some((item) => item.id === id)) return "path";
  if (plan.terrains.some((item) => item.id === id)) return "terrain";
  if (plan.fences.some((item) => item.id === id)) return "fence";
  if (plan.drills.some((item) => item.id === id)) return "drill";
  if (plan.masses.some((item) => item.id === id)) return "mass";
  if (plan.notes.some((item) => item.id === id)) return "note";
  const markup = side.markups.items.find((item) => item.id === id);
  if (markup) return markup.kind;
  if (side.markups.pdfs.some((item) => item.id === id)) return "pdf";
  if (side.slides.slides.some((item) => item.id === id)) return "slide";
  return "";
}

function contextBlock(kind: string, id: string, plan: SitePlan, side: ViewerSidecar, pdfStep: string): string {
  const body =
    kind === "crane"
      ? craneContext(plan, side, id)
      : kind === "truck"
        ? truckContext(plan, side, id)
        : kind === "path"
          ? pathContext(plan, id)
            : kind === "terrain"
            ? terrainContext(plan, id)
            : kind === "fence"
              ? fenceContext(plan, id)
              : kind === "drill"
                ? drillContext(plan, id)
                : kind === "mass"
                  ? massContext(plan, id)
                  : kind === "slide"
                    ? slideContext(side.slides.slides.find((item) => item.id === id))
                    : kind === "note"
              ? noteContext(plan, id)
              : kind === "pin" || kind === "textbox" || kind === "balloon" || kind === "hatch" || kind === "polygon"
                ? markupContext(side.markups.items.find((item) => item.id === id))
                : kind === "pdf"
                  ? pdfContext(side.markups.pdfs.find((item) => item.id === id), pdfStep)
                  : "";
  if (!body) return "";
  return `<section class="site-context" data-context="${kind}"><h3>${escapeHtml(titleOf(kind))}</h3>${body}</section>`;
}

function titleOf(kind: string): string {
  return (
    {
      crane: "Guindaste",
      truck: "Camião",
      path: "Caminho",
      terrain: "Terreno",
      fence: "Cerca",
      drill: "Perfuratriz",
      mass: "Volume",
      slide: "Slide",
      note: "Nota",
      pin: "Pin",
      textbox: "Caixa",
      balloon: "Balão",
      hatch: "Hachura",
      polygon: "Polígono",
      pdf: "PDF",
    }[kind] || "Elemento"
  );
}

function craneContext(plan: SitePlan, side: ViewerSidecar, id: string): string {
  const crane = plan.cranes.find((item) => item.id === id);
  if (!crane) return "";
  const pose = poseOf(crane);
  const keys = side.keyframes.tracks.find((track) => track.targetId === id)?.keys ?? [];
  return `${colorField(crane.color || "#f0b429")}
    ${rotFields(pose.rx, pose.ry, pose.rz, "xyz")}
    ${numField("mastHeight", "Mastro", crane.mastHeight, "m")}
    <div class="site-inline">
      <button type="button" class="site-icon" data-act="mast-up" aria-label="Mastro" title="Mastro">${ICON_UP}</button>
      <button type="button" class="site-icon" data-act="mast-down" aria-label="Mastro menor">${ICON_DOWN}</button>
    </div>
    ${numField("jibLength", "Lança", crane.jibLength, "m")}
    <div class="site-inline">
      <button type="button" class="site-icon" data-act="jib-up" aria-label="Lança">${ICON_RIGHT}</button>
      <button type="button" class="site-icon" data-act="jib-down" aria-label="Lança menor">${ICON_LEFT}</button>
    </div>
    ${numField("counterJib", "Contra-lança", crane.counterJib ?? 6, "m")}
    ${numField("swing", "Zona de giro", crane.swing ?? 270, "°")}
    ${numField("hook", "Cabo", crane.hook ?? 4, "m")}
    <p class="site-read">A lança e o cabo seguem o dia da tarefa.</p>
    ${posFields(crane.x, crane.y, crane.z)}
    ${lineFields(plan, crane.lineId)}
    <button type="button" class="site-chip" data-act="pose">Pose</button>
    ${keyList(keys)}
    ${removeButton()}`;
}

function truckContext(plan: SitePlan, side: ViewerSidecar, id: string): string {
  const truck = plan.trucks.find((item) => item.id === id);
  if (!truck) return "";
  const pose = poseOf(truck);
  const keys = side.keyframes.tracks.find((track) => track.targetId === id)?.keys ?? [];
  const options = [`<option value="">Sem caminho</option>`]
    .concat(
      plan.paths.map(
        (path, index) =>
          `<option value="${escapeHtml(path.id)}"${path.id === truck.pathId ? " selected" : ""}>Caminho ${index + 1}</option>`,
      ),
    )
    .join("");
  const progress = keys.length ? Math.round((keys[keys.length - 1]?.pathT ?? 0) * 100) : 0;
  const path = plan.paths.find((item) => item.id === truck.pathId);
  const pathLine =
    path && path.points.length > 1
      ? `${trim(pathLength(path))} m · a posição segue o dia da tarefa`
      : "Clique no chão para o caminho.";
  return `${numField("duration", "Duração", truck.duration ?? 20, "s")}
    <p class="site-read">${pathLine}</p>
    ${colorField(truck.color || "#f0b429")}
    ${rotFields(pose.rx, pose.ry, pose.rz, "xyz")}
    <label class="site-field"><span>Caminho</span><select data-field="pathId">${options}</select></label>
    ${numField("pathT", "No caminho", progress, "%")}
    ${posFields(truck.x, truck.y, truck.z)}
    ${lineFields(plan, truck.lineId)}
    <button type="button" class="site-chip" data-act="pose">Pose</button>
    ${keyList(keys)}
    ${removeButton()}`;
}

function pathContext(plan: SitePlan, id: string): string {
  const path = plan.paths.find((item) => item.id === id);
  if (!path) return "";
  return `${colorField(path.color || "#748891")}
    <p class="site-read">${trim(pathLength(path))} m</p>
    <button type="button" class="site-chip" data-act="vertex-pop">Vértice</button>
    ${removeButton()}`;
}

function terrainContext(plan: SitePlan, id: string): string {
  const terrain = plan.terrains.find((item) => item.id === id);
  if (!terrain) return "";
  const cut = terrain.operation === "cut";
  return `<p class="site-read site-volume" data-volume="cut">${escapeHtml(cutStatus(terrain))}</p>
    <div class="site-inline">
      <button type="button" class="site-chip${cut ? " is-on" : ""}" data-act="cut">Corte</button>
      <button type="button" class="site-chip${cut ? "" : " is-on"}" data-act="fill">Aterro</button>
    </div>
    ${numField("depth", "Profundidade", terrain.depth, "m")}
    ${numField("slope", "Talude", terrain.slope, "°")}
    ${colorField(terrain.color || (cut ? "#9b3a2a" : "#087f72"), "color", "Terreno")}
    ${colorField(terrain.slopeColor || "#c4a882", "slopeColor", "Talude")}
    ${rotFields(0, 0, terrain.rz ?? 0, "z")}
    ${lineFields(plan, terrain.lineId)}
    ${terrain.closed === false ? `<button type="button" class="site-chip is-on" data-act="close">Fechar corte</button>` : ""}
    <button type="button" class="site-chip" data-act="vertex-pop">Vértice</button>
    ${removeButton()}`;
}

function fenceContext(plan: SitePlan, id: string): string {
  const fence = plan.fences.find((item) => item.id === id);
  if (!fence) return "";
  return `${colorField(fence.color || "#d5dee2")}
    ${numField("length", "Comprimento", fence.length, "m")}
    ${numField("panels", "Painéis", fence.panels, "")}
    ${rotFields(0, 0, fence.rz ?? fence.yaw, "z")}
    ${posFields(fence.x, fence.y, fence.z)}
    ${lineFields(plan, fence.lineId)}
    ${removeButton()}`;
}

function drillContext(plan: SitePlan, id: string): string {
  const drill = plan.drills.find((item) => item.id === id);
  if (!drill) return "";
  const pose = poseOf(drill);
  return `${colorField(drill.color || "#f0b429")}
    ${numField("depth", "Profundidade", drill.depth, "m")}
    ${rotFields(pose.rx, pose.ry, pose.rz, "xyz")}
    ${posFields(drill.x, drill.y, drill.z)}
    ${lineFields(plan, drill.lineId)}
    ${removeButton()}`;
}

function massContext(plan: SitePlan, id: string): string {
  const mass = plan.masses.find((item) => item.id === id);
  if (!mass) return "";
  const pose = poseOf(mass);
  return `${colorField(mass.color || "#8aa0a6")}
    ${numField("width", "Comprimento", mass.width, "m")}
    ${numField("depth", "Largura", mass.depth, "m")}
    ${numField("height", "Altura", mass.height, "m")}
    ${numField("sections", "Trechos", mass.sections ?? 1, "")}
    <button type="button" class="site-chip${mass.grow ? " is-on" : ""}" data-act="grow">Crescer</button>
    ${rotFields(pose.rx, pose.ry, pose.rz, "xyz")}
    ${posFields(mass.x, mass.y, mass.z)}
    ${lineFields(plan, mass.lineId)}
    ${removeButton()}`;
}

function noteContext(plan: SitePlan, id: string): string {
  const note = plan.notes.find((item) => item.id === id);
  if (!note) return "";
  return `${textField(note.text)}
    ${colorField(note.color || "#163540")}
    ${posFields(note.x, note.y, note.z)}
    ${removeButton()}`;
}

function markupContext(item: MarkupItem | undefined): string {
  if (!item) return "";
  const text = `${textField(item.text)}${colorField(item.color)}`;
  if (item.kind === "pin") {
    return `${text}${item.x != null ? posFields(item.x, item.y ?? 0, item.z ?? 0) : ""}${removeButton()}`;
  }
  if (item.kind === "textbox" || item.kind === "balloon") {
    return `${text}
      ${numField("width", "Largura", item.width ?? 6, "m")}
      ${numField("height", "Altura", item.height ?? 2.4, "m")}
      <p class="site-read">Arraste a alça para redimensionar.</p>
      ${removeButton()}`;
  }
  const pattern = item.pattern || (item.kind === "polygon" ? "solid" : "diagonal");
  return `${text}
    <div class="site-inline">
      ${["solid", "diagonal", "cross", "horizontal"]
        .map(
          (key) =>
            `<button type="button" class="site-chip${pattern === key ? " is-on" : ""}" data-act="pattern" data-value="${key}">${PATTERN_LABEL[key]}</button>`,
        )
        .join("")}
    </div>
    ${numField("scale", "Escala", item.scale ?? 1, "")}
    <p class="site-read">Arraste os vértices ou a alça para mudar o tamanho.</p>
    ${item.closed === false ? `<button type="button" class="site-chip" data-act="close">Fechar</button>` : ""}
    <button type="button" class="site-chip" data-act="vertex-pop">Vértice</button>
    ${removeButton()}`;
}

const PDF_STEP: Record<string, string> = {
  d1: "1. Clique um ponto no desenho.",
  g1: "2. Clique o mesmo ponto no modelo.",
  d2: "3. Clique o segundo ponto no desenho.",
  g2: "4. Clique o segundo ponto no modelo.",
};

function pdfGuide(): string {
  return `<section class="site-context" data-context="pdf"><h3>PDF</h3>
    <ol class="site-steps">
      <li>Escolher a folha</li>
      <li>Dois pontos no desenho</li>
      <li>Os mesmos dois no modelo</li>
    </ol>
    <button type="button" class="site-chip is-on" data-act="pdf-pick">Escolher folha</button>
    <p class="site-read">A opacidade fica no cartão sobre a vista.</p>
  </section>`;
}

function pdfContext(pdf: PdfOverlay | undefined, step: string): string {
  if (!pdf) return "";
  const line = PDF_STEP[step] ?? "Dois pontos no desenho e os mesmos dois no modelo.";
  const opacity = Math.round(pdf.opacity * 100);
  return `${numField("sheet", "Folha", pdf.sheet + 1, "")}
    <label class="site-field"><span>Opacidade</span><input type="range" min="5" max="100" step="1" data-field="opacity" value="${opacity}" /><em data-opacity-read>${opacity}%</em></label>
    <button type="button" class="site-chip${pdf.removeWhite ? " is-on" : ""}" data-act="pdf-white">Branco</button>
    ${colorField(pdf.color || "#ffffff")}
    ${numField("width", "Largura", pdf.width ?? 24, "m")}
    <button type="button" class="site-chip${step ? " is-on" : ""}" data-act="pdf-align">Alinhar</button>
    <p class="site-read">${line}</p>
    <p class="site-read">A folha assenta no terreno. A opacidade deixa ver o modelo.</p>
    <p class="site-read">${pdf.pageCount} folhas</p>
    ${removeButton()}`;
}

function slideContext(slide: SlideShot | undefined): string {
  if (!slide) return "";
  return `${textField(slide.comment, "comment", "Comentário")}
    <button type="button" class="site-chip" data-act="slide-open">Abrir</button>
    ${removeButton()}`;
}

function slideBlock(side: ViewerSidecar): string {
  const rows = side.slides.slides
    .map(
      (slide) =>
        `<button type="button" class="site-line" data-act="item" data-id="${escapeHtml(slide.id)}"><span>${escapeHtml(slide.name)}</span></button>`,
    )
    .join("");
  return `<section class="site-context" data-context="slide"><h3>Slide</h3>
    <button type="button" class="site-chip" data-act="slide-save">Capturar</button>
    <button type="button" class="site-chip" data-act="slides-pdf">PDF</button>
    <button type="button" class="site-chip" data-act="slides-zip">Imagens</button>
    ${rows}
  </section>`;
}

function cameraBlock(side: ViewerSidecar): string {
  const rows = side.cameras.cameras
    .map(
      (camera) =>
        `<button type="button" class="site-line" data-act="camera-open" data-id="${escapeHtml(camera.id)}"><span>${escapeHtml(camera.name)}</span></button>`,
    )
    .join("");
  return `<section class="site-context" data-context="view"><h3>Vista</h3>
    <button type="button" class="site-chip" data-act="camera-save">Guardar</button>
    ${rows}
  </section>`;
}

function keyList(keys: { t: number }[]): string {
  if (!keys.length) return "";
  return `<div class="site-inline">${keys
    .map(
      (key) =>
        `<button type="button" class="site-chip" data-act="key-del" data-value="${key.t}">${Math.round(key.t * 100)}%</button>`,
    )
    .join("")}</div>`;
}

const PATTERN_LABEL: Record<string, string> = {
  solid: "Cheio",
  diagonal: "Diagonal",
  cross: "Cruz",
  horizontal: "Linhas",
};

function colorField(value: string, field = "color", label = "Cor"): string {
  return `<label class="site-field"><span>${label}</span><input type="color" data-field="${field}" value="${escapeHtml(value)}" /></label>`;
}

function textField(value: string, field = "text", label = "Texto"): string {
  return `<label class="site-field"><span>${label}</span><input type="text" data-field="${field}" value="${escapeHtml(value)}" autocomplete="off" /></label>`;
}

function posFields(x: number, y: number, z: number): string {
  return `${numField("x", "X", x, "m")}${numField("y", "Y", y, "m")}${numField("z", "Z", z, "m")}`;
}

function lineFields(plan: SitePlan, lineId?: string): string {
  const line = plan.lines.find((item) => item.id === lineId);
  if (!line) return "";
  return `<label class="site-field"><span>Início</span><input type="date" data-field="start" value="${escapeHtml(line.start)}" /></label>
    <label class="site-field"><span>Fim</span><input type="date" data-field="end" value="${escapeHtml(line.end)}" /></label>`;
}

function numField(field: string, label: string, value: number, unit: string): string {
  const shown = Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
  return `<label class="site-field"><span>${label}</span><input type="number" data-field="${field}" value="${shown}" step="0.1" />${unit ? `<em>${unit}</em>` : ""}</label>`;
}

function rotFields(rx: number, ry: number, rz: number, axes: "xyz" | "z"): string {
  const deg = (rad: number) => String(Math.round((rad * 180) / Math.PI));
  const x = axes === "xyz" ? numField("rx", "X", Number(deg(rx)), "°") : "";
  const y = axes === "xyz" ? numField("ry", "Y", Number(deg(ry)), "°") : "";
  return `${x}${y}${numField("rz", "Z", Number(deg(rz)), "°")}`;
}

function removeButton(): string {
  return `<button type="button" class="site-icon" data-act="remove" aria-label="Apagar" title="Apagar">${ICON_REMOVE}</button>`;
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function mark(key: string): string {
  return `<span class="site-mark" aria-hidden="true">${MARKS[key] || ""}</span>`;
}

const ICON_REMOVE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 14l6-6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 10l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_RIGHT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M10 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_LEFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M14 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const MARKS: Record<string, string> = {
  crane: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 20V6M5 6h14M16 6v5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  truck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 16V9h9v7M12 16V7h4l3 4v5" stroke-linejoin="round"/><circle cx="7" cy="17" r="1.4"/><circle cx="17" cy="17" r="1.4"/></svg>`,
  path: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 17c4-8 10-8 14 0" stroke-linecap="round"/><circle cx="5" cy="17" r="1.3"/><circle cx="19" cy="17" r="1.3"/></svg>`,
  terrain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 17h16M7 17l2-6h6l2 6" stroke-linejoin="round"/></svg>`,
  fence: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20V8M9 20V8M14 20V8M19 20V8M3 8h18" stroke-linecap="round"/></svg>`,
  drill: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 4h8v6H8zM12 10v10" stroke-linejoin="round"/></svg>`,
  mass: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 16l8-4 8 4-8 4-8-4zM4 16v4l8 4 8-4v-4" stroke-linejoin="round"/></svg>`,
  slide: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="5" width="16" height="12" rx="1.5"/><path d="M9 20h6" stroke-linecap="round"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s6-5.2 6-10a6 6 0 10-12 0c0 4.8 6 10 6 10z" stroke-linejoin="round"/><circle cx="12" cy="11" r="1.6"/></svg>`,
  pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 3h7l5 5v13H7z" stroke-linejoin="round"/><path d="M14 3v5h5" stroke-linejoin="round"/></svg>`,
  view: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/></svg>`,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
