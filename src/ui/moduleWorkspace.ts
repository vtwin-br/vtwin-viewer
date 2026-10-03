import type { WorkspaceId } from "../app/catalog";
import type { IfcSession } from "../ifc/ifcSession";
import { formatMoney, treeCost } from "../schedule/cost";
import { getTaskState } from "../schedule/simulation";
import type { ScheduleData, Task } from "../schedule/types";

export interface ModuleWorkspaceOptions {
  getWorkspace: () => WorkspaceId;
  hasModel: () => boolean;
  modelLabel: () => string;
  getSchedule: () => ScheduleData | null;
  getDate: () => Date;
  planning: () => IfcSession | null;
  editSession: () => IfcSession | null;
  sessionForGuid: (guid: string) => IfcSession | null;
  coordinationSession: () => IfcSession | null;
  selectionGuids: () => string[];
  focusGuids: (guids: string[]) => void;
  fitView: () => void;
  revealAll: () => void;
  onChanged: () => void;
}

const TOOL_SHELLS = new Set<WorkspaceId>(["dashboard", "viewer", "docs", "editor", "coordination"]);
const RESERVED_DOC_IDS = new Set(["TABLE", "SOURCE", "SCHEDULE", "DOCUMENT"]);

export class ModuleWorkspace {
  private rev = 0;
  private editedGuid = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: ModuleWorkspaceOptions,
  ) {
    this.root.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      void this.onSubmit(form);
    });
    this.root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLElement>("[data-act]");
      if (!button) return;
      void this.onAction(button.dataset.act || "", button);
    });
  }

  refresh(id: WorkspaceId): void {
    if (!TOOL_SHELLS.has(id)) {
      this.root.hidden = true;
      this.root.innerHTML = "";
      return;
    }
    this.root.hidden = false;
    void this.render(id);
  }

  private async render(id: WorkspaceId): Promise<void> {
    const rev = ++this.rev;
    const html = await this.markup(id);
    if (rev !== this.rev) return;
    this.root.innerHTML = html;
  }

  private async markup(id: WorkspaceId): Promise<string> {
    if (!this.opts.hasModel()) {
      return `<p class="mw-lead">Abra um IFC. Este módulo usa o mesmo modelo — trocar de ferramenta não o descarrega.</p>`;
    }
    if (id === "dashboard") return this.dashboard();
    if (id === "viewer") return this.viewer();
    if (id === "docs") return this.docs();
    if (id === "editor") return this.editor();
    return this.coordination();
  }

  private dashboard(): string {
    const schedule = this.opts.getSchedule();
    const date = this.opts.getDate();
    if (!schedule) return `<p class="mw-lead">Sem cronograma IFC na vista.</p>`;
    const leaves = collectLeaves(schedule);
    const counts = { pending: 0, active: 0, done: 0, undated: 0 };
    for (const task of leaves) {
      if (!task.start || !task.end) {
        counts.undated += 1;
        continue;
      }
      counts[getTaskState(task, date)] += 1;
    }
    let cost = 0;
    for (const root of schedule.roots) {
      if (!root.isFederationRoot) cost += treeCost(root);
    }
    const linked = new Set<string>();
    for (const task of schedule.byId.values()) {
      for (const guid of schedule.productGuidsByTask.get(task.id) ?? task.productGuids) linked.add(guid);
    }
    const currency = schedule.currency || "BRL";
    const kpi = (act: string, value: string, label: string) =>
      `<button type="button" class="mw-kpi" data-act="${act}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></button>`;
    const top = [...schedule.roots]
      .filter((task) => !task.isFederationRoot)
      .map((task) => ({ task, cost: treeCost(task) }))
      .filter((row) => row.cost > 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 6);
    return `
      <p class="mw-lead">Indicadores lidos do IFC em ${escapeHtml(formatDay(date))}. Clicar isola os produtos ligados.</p>
      <div class="mw-kpis">
        ${kpi("focus-all", String(schedule.byId.size), "IfcTask")}
        ${kpi("focus-active", String(counts.active), "Em execução")}
        ${kpi("focus-pending", String(counts.pending), "Pendentes")}
        ${kpi("focus-done", String(counts.done), "Concluídas")}
        ${kpi("focus-cost", formatMoney(cost, currency), "Custo 5D")}
        ${kpi("focus-linked", String(linked.size), "Elementos ligados")}
      </div>
      <p class="mw-note">${schedule.groups.length} IfcGroup · ${schedule.documents.length} documentos · ${counts.undated} tarefas sem data (fora do estado 4D).</p>
      ${
        top.length
          ? `<ul class="mw-list">${top
              .map(
                (row) =>
                  `<li><button type="button" data-act="focus-task" data-id="${row.task.id}">${escapeHtml(row.task.name)}</button> <span>${escapeHtml(formatMoney(row.cost, currency))}</span></li>`,
              )
              .join("")}</ul>`
          : `<p class="mw-note">Sem IfcCostValue nas tarefas raiz.</p>`
      }
    `;
  }

  private viewer(): string {
    return `
      <p class="mw-lead">${escapeHtml(this.opts.modelLabel())}</p>
      <p class="mw-note">A mesma vista 3D do viewport. Não há segundo modelo: órbita, seleção e caminhada continuam aqui.</p>
      <div class="mw-actions">
        <button type="button" class="btn-primary" data-act="fit">Enquadrar</button>
        <button type="button" class="btn-secondary" data-act="reveal">Mostrar tudo</button>
        <button type="button" class="btn-secondary" data-act="focus-selection">Isolar seleção</button>
      </div>
    `;
  }

  private async docs(): Promise<string> {
    const session = this.opts.planning();
    if (!session) return `<p class="mw-lead">Abra um IFC para gravar documentos.</p>`;
    let documents: Awaited<ReturnType<IfcSession["listDocuments"]>> = [];
    let tables: Awaited<ReturnType<IfcSession["listTables"]>> = [];
    try {
      documents = await session.listDocuments();
      tables = await session.listTables();
    } catch (error) {
      return `<p class="mw-msg">${escapeHtml((error as Error).message)}</p>`;
    }
    const sheets = documents.filter(
      (doc) => doc.identification && doc.description !== "IfcTable" && !RESERVED_DOC_IDS.has(doc.identification),
    );
    const docs = documents.filter((doc) => doc.description !== "IfcTable");
    const list = (items: typeof docs, empty: string) =>
      items.length
        ? `<ul class="mw-list">${items
            .map(
              (doc) =>
                `<li><strong>${escapeHtml(doc.name)}</strong>${doc.identification ? ` · ${escapeHtml(doc.identification)}` : ""}${doc.location ? `<br><span>${escapeHtml(doc.location)}</span>` : ""}</li>`,
            )
            .join("")}</ul>`
        : `<p class="mw-note">${empty}</p>`;
    const tableList = tables.length
      ? `<ul class="mw-list">${tables
          .map(
            (table) =>
              `<li><strong>${escapeHtml(table.name)}</strong><br><span>${table.columns.length} colunas · ${table.rows.length} linhas</span></li>`,
          )
          .join("")}</ul>`
      : `<p class="mw-note">Sem IfcTable.</p>`;
    return `
      <p class="mw-lead">Grava no IFC do cronograma. Exportar IFC escreve as entidades.</p>
      <section class="mw-card">
        <h3>Documentos</h3>
        ${list(docs, "Sem IfcDocumentReference.")}
        <form class="mw-form" data-form="document">
          <input name="name" placeholder="Nome" required />
          <input name="location" placeholder="Localização (ficheiro ou URI)" />
          <input name="description" placeholder="Descrição" />
          <button type="submit" class="btn-primary">Gravar documento</button>
        </form>
      </section>
      <section class="mw-card">
        <h3>Folhas 2D</h3>
        <p class="mw-note">Uma folha é um IfcDocumentReference com número em Identification. O esquema não tem subtipo de folha.</p>
        ${list(sheets, "Sem folhas.")}
        <form class="mw-form" data-form="sheet">
          <input name="identification" placeholder="Número da folha" required />
          <input name="name" placeholder="Título" required />
          <input name="location" placeholder="Localização (opcional)" />
          <button type="submit" class="btn-primary">Gravar folha</button>
        </form>
      </section>
      <section class="mw-card">
        <h3>Tabelas</h3>
        <p class="mw-note">IfcTable + IfcDocumentReference com o mesmo nome. A primeira linha do texto são as colunas, separadas por |.</p>
        ${tableList}
        <form class="mw-form" data-form="table">
          <input name="name" placeholder="Nome da tabela" required />
          <textarea name="body" rows="4" placeholder="Item | Quantidade&#10;Estaca | 12" required></textarea>
          <button type="submit" class="btn-primary">Gravar tabela</button>
        </form>
      </section>
    `;
  }

  private async editor(): Promise<string> {
    const selected = this.opts.selectionGuids();
    const guid = selected[0] ?? this.editedGuid;
    const session = guid ? this.opts.sessionForGuid(guid) : this.opts.editSession();
    if (!session) return `<p class="mw-lead">Selecione um elemento no viewport ou abra uma disciplina.</p>`;
    let props = "";
    let classes = "";
    let spatial = "";
    let searches = "";
    if (guid) {
      try {
        const sets = await session.listPropertySets(guid);
        props = sets.length
          ? `<ul class="mw-list">${sets
              .map(
                (set) =>
                  `<li><strong>${escapeHtml(set.name)}</strong><br>${set.properties
                    .map((prop) => `${escapeHtml(prop.name)}: ${escapeHtml(prop.value)}`)
                    .join("<br>")}</li>`,
              )
              .join("")}</ul>`
          : `<p class="mw-note">Sem IfcPropertySet neste elemento.</p>`;
        const cls = await session.listClassifications(guid);
        classes = cls.length
          ? `<ul class="mw-list">${cls
              .map(
                (item) =>
                  `<li>${escapeHtml(item.sourceName || "Classificação")} · ${escapeHtml(item.identification)} ${escapeHtml(item.name)}</li>`,
              )
              .join("")}</ul>`
          : `<p class="mw-note">Sem IfcClassificationReference.</p>`;
      } catch (error) {
        props = `<p class="mw-msg">${escapeHtml((error as Error).message)}</p>`;
      }
    } else {
      props = `<p class="mw-note">Selecione um elemento para editar propriedades e classificação.</p>`;
    }
    try {
      const nodes = await session.listSpatialNodes();
      spatial = nodes.length
        ? `<ul class="mw-list">${nodes
            .slice(0, 40)
            .map(
              (node) =>
                `<li><button type="button" data-act="use-parent" data-guid="${escapeHtml(node.guid)}">${escapeHtml(node.name)}</button> <span>${escapeHtml(node.type.replace(/^IFC/, ""))}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="mw-note">Sem árvore espacial legível neste STEP.</p>`;
      const found = await session.listSearchSets();
      searches = found.length
        ? `<ul class="mw-list">${found
            .map(
              (group) =>
                `<li><button type="button" data-act="focus-guids" data-guids="${escapeHtml(group.productGuids.join(" "))}">${escapeHtml(group.name)}</button><br><span>${escapeHtml(group.query || "sem consulta")}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="mw-note">Sem search sets.</p>`;
    } catch (error) {
      spatial = `<p class="mw-msg">${escapeHtml((error as Error).message)}</p>`;
    }
    return `
      <p class="mw-lead">Edição no STEP do elemento. O % da barra do Gantt não se grava: IfcTaskTime não tem percentagem.</p>
      <p class="mw-note">GlobalId: ${guid ? escapeHtml(guid) : "nenhum selecionado"}</p>
      <section class="mw-card">
        <h3>Propriedades</h3>
        ${props}
        <form class="mw-form" data-form="property">
          <input name="guid" value="${escapeHtml(guid)}" placeholder="GlobalId" required />
          <input name="pset" placeholder="IfcPropertySet" required />
          <input name="prop" placeholder="Propriedade" required />
          <input name="value" placeholder="Valor" required />
          <button type="submit" class="btn-primary">Gravar propriedade</button>
        </form>
      </section>
      <section class="mw-card">
        <h3>Classificação</h3>
        ${classes}
        <form class="mw-form" data-form="class">
          <input name="guid" value="${escapeHtml(guid)}" placeholder="GlobalId" required />
          <input name="source" placeholder="Sistema (IfcClassification)" />
          <input name="identification" placeholder="Código" required />
          <input name="name" placeholder="Nome" />
          <button type="submit" class="btn-primary">Gravar classificação</button>
        </form>
      </section>
      <section class="mw-card">
        <h3>Árvore espacial</h3>
        <p class="mw-note">Move por IfcRelContainedInSpatialStructure ou IfcRelAggregates.</p>
        ${spatial}
        <form class="mw-form" data-form="spatial">
          <input name="product" value="${escapeHtml(guid)}" placeholder="GlobalId do elemento" required />
          <input name="parent" placeholder="GlobalId do contentor" required />
          <button type="submit" class="btn-primary">Mover no IFC</button>
        </form>
      </section>
      <section class="mw-card">
        <h3>Search sets</h3>
        <p class="mw-note">IfcGroup (${escapeHtml("VISTA4D_SEARCH")}) e a consulta em Pset_Vista4dSearch. Exemplos: Tipo=IfcWall ou Pset_WallCommon.Reference=W1.</p>
        ${searches}
        <form class="mw-form" data-form="search">
          <input name="name" placeholder="Nome do conjunto" required />
          <input name="query" placeholder="Tipo=IfcWall" required />
          <button type="submit" class="btn-primary">Gravar search set</button>
        </form>
      </section>
    `;
  }

  private async coordination(): Promise<string> {
    const session = this.opts.coordinationSession() ?? this.opts.editSession();
    if (!session) return `<p class="mw-lead">Abra um IFC4 para gravar interferências.</p>`;
    let rows = "";
    try {
      const items = await session.listInterferences();
      rows = items.length
        ? `<ul class="mw-list">${items
            .map(
              (item) =>
                `<li><strong>${escapeHtml(item.name)}</strong><br><span>#${item.relatingId} × #${item.relatedId} · ${escapeHtml(item.interferenceType)}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="mw-note">Sem IfcRelInterferesElements.</p>`;
    } catch (error) {
      rows = `<p class="mw-msg">${escapeHtml((error as Error).message)}</p>`;
    }
    const selected = this.opts.selectionGuids();
    return `
      <p class="mw-lead">O que fica gravado é IfcRelInterferesElements (IFC4). BCF — tópicos, câmaras e markup — não tem entidade IFC equivalente e fica fora do ficheiro mestre.</p>
      ${rows}
      <form class="mw-form" data-form="clash">
        <input name="name" placeholder="Nome" value="Interferência" />
        <input name="a" placeholder="GlobalId A" value="${escapeHtml(selected[0] ?? "")}" required />
        <input name="b" placeholder="GlobalId B" value="${escapeHtml(selected[1] ?? "")}" required />
        <button type="submit" class="btn-primary">Gravar interferência</button>
      </form>
    `;
  }

  private async onSubmit(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    try {
      const kind = form.dataset.form;
      if (kind === "document" || kind === "sheet") {
        const session = this.opts.planning();
        if (!session) throw new Error("Sem IFC para gravar o documento.");
        session.addDocumentReference({
          name: text("name") || text("identification"),
          identification: text("identification"),
          location: text("location"),
          description: kind === "sheet" ? text("description") : text("description"),
        });
      } else if (kind === "table") {
        const session = this.opts.planning();
        if (!session) throw new Error("Sem IFC para gravar a tabela.");
        const parsed = parseTable(text("body"));
        await session.upsertTable(text("name"), parsed.columns, parsed.rows);
      } else if (kind === "property") {
        const session = this.opts.sessionForGuid(text("guid"));
        if (!session) throw new Error("Esse GlobalId não está num IFC aberto.");
        await session.upsertProperty(text("guid"), text("pset"), text("prop"), text("value"));
        this.editedGuid = text("guid");
      } else if (kind === "class") {
        const session = this.opts.sessionForGuid(text("guid"));
        if (!session) throw new Error("Esse GlobalId não está num IFC aberto.");
        await session.addClassification(text("guid"), {
          identification: text("identification"),
          name: text("name"),
          sourceName: text("source"),
        });
        this.editedGuid = text("guid");
      } else if (kind === "spatial") {
        const productSession = this.opts.sessionForGuid(text("product"));
        const parentSession = this.opts.sessionForGuid(text("parent"));
        if (!productSession || productSession !== parentSession) {
          throw new Error("Elemento e contentor têm de estar no mesmo IFC.");
        }
        await productSession.moveSpatial(text("product"), text("parent"));
        this.editedGuid = text("product");
      } else if (kind === "search") {
        const session = this.opts.editSession();
        if (!session) throw new Error("Abra uma disciplina para pesquisar.");
        await session.createSearchSet(text("name"), text("query"), this.opts.selectionGuids());
      } else if (kind === "clash") {
        const session = this.opts.coordinationSession() ?? this.opts.editSession();
        if (!session) throw new Error("Sem IFC para gravar a interferência.");
        const a = this.opts.sessionForGuid(text("a"));
        const b = this.opts.sessionForGuid(text("b"));
        const target =
          a && b && a === b ? a : (this.opts.coordinationSession() ?? session);
        target.addInterference({ name: text("name"), relatingGuid: text("a"), relatedGuid: text("b") });
      }
      this.opts.onChanged();
      this.refresh(this.opts.getWorkspace());
    } catch (error) {
      this.flash((error as Error).message);
    }
  }

  private async onAction(act: string, button: HTMLElement): Promise<void> {
    const schedule = this.opts.getSchedule();
    if (act === "fit") {
      this.opts.fitView();
      return;
    }
    if (act === "reveal") {
      this.opts.revealAll();
      return;
    }
    if (act === "focus-selection") {
      this.opts.focusGuids(this.opts.selectionGuids());
      return;
    }
    if (act === "use-parent") {
      const input = this.root.querySelector<HTMLInputElement>('form[data-form="spatial"] input[name="parent"]');
      if (input && button.dataset.guid) input.value = button.dataset.guid;
      return;
    }
    if (act === "focus-guids") {
      this.opts.focusGuids((button.dataset.guids ?? "").split(/\s+/).filter(Boolean));
      return;
    }
    if (!schedule) return;
    if (act === "focus-task") {
      const id = Number(button.dataset.id);
      const task = schedule.byId.get(id);
      if (task) this.opts.focusGuids(schedule.productGuidsByTask.get(task.id) ?? task.productGuids);
      return;
    }
    const date = this.opts.getDate();
    const wanted =
      act === "focus-active" ? "active" : act === "focus-pending" ? "pending" : act === "focus-done" ? "done" : null;
    if (act === "focus-all" || act === "focus-linked" || act === "focus-cost" || wanted) {
      const guids: string[] = [];
      for (const task of schedule.byId.values()) {
        if (task.isFederationRoot) continue;
        if (wanted && (!task.start || !task.end || getTaskState(task, date) !== wanted)) continue;
        guids.push(...(schedule.productGuidsByTask.get(task.id) ?? task.productGuids));
      }
      this.opts.focusGuids(guids);
    }
  }

  private flash(message: string): void {
    let note = this.root.querySelector<HTMLElement>(".mw-msg");
    if (!note) {
      note = document.createElement("p");
      note.className = "mw-msg";
      this.root.prepend(note);
    }
    note.textContent = message;
  }
}

function collectLeaves(schedule: ScheduleData): Task[] {
  const out: Task[] = [];
  const walk = (task: Task) => {
    if (task.isFederationRoot) {
      for (const child of task.children) walk(child);
      return;
    }
    if (!task.children.length) out.push(task);
    else for (const child of task.children) walk(child);
  };
  for (const root of schedule.roots) walk(root);
  return out;
}

function parseTable(body: string): { columns: string[]; rows: string[][] } {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("A tabela está vazia.");
  const split = (line: string) => line.split("|").map((cell) => cell.trim());
  const columns = split(lines[0]!).filter(Boolean);
  if (!columns.length) throw new Error("A primeira linha tem de ter os nomes das colunas.");
  const rows = lines.slice(1).map((line) => split(line));
  return { columns, rows };
}

function formatDay(date: Date): string {
  return date.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
