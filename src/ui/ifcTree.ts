import type { FragmentsModel, SpatialTreeItem } from "@thatopen/fragments";
import type { ScheduleHighlighter } from "../viewer/highlight";

export interface IfcTreeNode {
  localId: number | null;
  category: string | null;
  name: string;
  guid?: string;
  children: IfcTreeNode[];
  hasGeom: boolean;
}

export interface IfcTreeOptions {
  onSelect: (guids: string[], additive: boolean) => void;
}

interface NodeStats {
  taskHits: number;
  groupHits: number;
  hasHit: boolean;
}

export interface IfcTreeBindEntry {
  model: FragmentsModel;
  label: string;
  modelId: string;
}

export class IfcSpatialTree {
  private root: HTMLElement;
  private opts: IfcTreeOptions;
  private nodes: IfcTreeNode[] = [];
  private index = new Map<string, IfcTreeNode>();
  private filter = "";
  private active = new Set<string>();
  private selectedKey: string | null = null;
  private pendingFocusKey: string | null = null;
  private collapsed = new Set<string>();
  private taskGuids = new Set<string>();
  private groupGuids = new Set<string>();
  private stats = new Map<string, NodeStats>();

  constructor(root: HTMLElement, opts: IfcTreeOptions) {
    this.root = root;
    this.opts = opts;
    this.root.addEventListener("click", this.onClick);
  }

  async bind(model: FragmentsModel, highlighter: ScheduleHighlighter): Promise<void> {
    await this.bindMany([{ model, label: "IFC", modelId: "main" }], highlighter);
  }

  async bindMany(entries: IfcTreeBindEntry[], highlighter: ScheduleHighlighter): Promise<void> {
    this.root.innerHTML = `<p class="ms-empty">A ler a hierarquia espacial do IFC…</p>`;
    if (!entries.length) {
      this.clear();
      return;
    }
    const forest: IfcTreeNode[] = [];
    for (const entry of entries) {
      let spatial: SpatialTreeItem;
      try {
        spatial = await entry.model.getSpatialStructure();
      } catch (err) {
        forest.push({
          localId: null,
          category: null,
          name: `${entry.label} (sem árvore)`,
          children: [],
          hasGeom: false,
        });
        console.warn(err);
        continue;
      }
      const geom = new Set(await entry.model.getItemsIdsWithGeometry());
      const ids: number[] = [];
      collectIds(spatial, ids);
      const names = new Map<number, { name: string; guid?: string }>();
      const chunk = 250;
      for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        try {
          const rows = await entry.model.getItemsData(slice, {
            attributesDefault: false,
            attributes: ["Name", "GlobalId", "ObjectType"],
            relationsDefault: { attributes: false, relations: false },
          });
          for (let k = 0; k < slice.length; k++) {
            const row = rows[k];
            const guid = attr(row?.GlobalId) || undefined;
            const name = attr(row?.Name) || attr(row?.ObjectType);
            names.set(slice[k]!, { name, guid });
            if (guid) highlighter.registerGuid(guid, slice[k]!, entry.modelId);
          }
        } catch {
          /* ignore chunk */
        }
      }
      const tree = toNode(spatial, names, geom);
      if (entries.length > 1) {
        forest.push({
          localId: null,
          category: "IFCFILE",
          name: entry.label.replace(/\.ifc$/i, ""),
          children: [tree],
          hasGeom: false,
        });
      } else {
        forest.push(tree);
      }
    }
    this.nodes = forest;
    this.collapsed = new Set();
    this.selectedKey = null;
    this.active.clear();
    this.index.clear();
    const walk = (n: IfcTreeNode, key: string, depth: number) => {
      this.index.set(key, n);
      if (depth >= 1 && n.children.length) this.collapsed.add(key);
      n.children.forEach((c, i) => walk(c, `${key}.${i}`, depth + 1));
    };
    this.nodes.forEach((n, i) => walk(n, `n${i}`, 0));
    this.render();
  }

  /** GUIDs ligados a IfcTask e a IfcGroup — badges na árvore. */
  setRelations(taskGuids: Iterable<string>, groupGuids: Iterable<string>, rerender = true): void {
    this.taskGuids = new Set(taskGuids);
    this.groupGuids = new Set(groupGuids);
    if (rerender && this.nodes.length) this.render();
  }

  setFilter(q: string): void {
    this.filter = q.trim().toLowerCase();
    this.render();
  }

  setActiveGuids(guids: Iterable<string>): void {
    this.active = new Set(guids);
    this.root.querySelectorAll<HTMLElement>("[data-guid]").forEach((el) => {
      el.classList.toggle("is-active", this.active.has(el.dataset.guid ?? ""));
    });
  }

  /** Expande os pais, destaca folhas/contentores e leva o primeiro elemento à vista. */
  revealGuids(guids: Iterable<string>): void {
    const want = new Set(guids);
    this.active = want;
    const focus = this.pendingFocusKey;
    this.pendingFocusKey = null;
    if (!want.size) {
      this.selectedKey = null;
      this.render();
      return;
    }
    this.filter = "";
    const expand = new Set<string>();
    let firstKey: string | null = null;
    const visit = (node: IfcTreeNode, key: string, ancestors: string[]) => {
      if (node.guid && want.has(node.guid)) {
        for (const a of ancestors) expand.add(a);
        if (!firstKey) firstKey = key;
      }
      const nextAnc = node.children.length ? [...ancestors, key] : ancestors;
      node.children.forEach((c, i) => visit(c, `${key}.${i}`, nextAnc));
    };
    this.nodes.forEach((n, i) => visit(n, `n${i}`, []));
    this.selectedKey = focus && this.index.has(focus) ? focus : firstKey;
    for (const key of expand) this.collapsed.delete(key);
    this.render();
    let target: HTMLElement | null = null;
    if (this.selectedKey) {
      for (const el of this.root.querySelectorAll<HTMLElement>(".ms-row")) {
        if (el.dataset.key === this.selectedKey) {
          target = el;
          break;
        }
      }
    }
    target ??= this.root.querySelector<HTMLElement>(".ms-row.is-active");
    target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  clear(): void {
    this.nodes = [];
    this.index.clear();
    this.stats.clear();
    this.selectedKey = null;
    this.active.clear();
    this.root.innerHTML = `<p class="ms-empty">Importe um IFC para ver a árvore de elementos.</p>`;
  }

  private onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act='toggle']");
    if (btn) {
      const key = btn.dataset.key ?? "";
      if (this.collapsed.has(key)) this.collapsed.delete(key);
      else this.collapsed.add(key);
      this.render();
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
    if (!row || row.dataset.act === "toggle") return;
    const key = row.dataset.key ?? "";
    const node = this.index.get(key);
    if (!node) return;
    const geom = collectGuids(node, true);
    const guids = geom.length ? geom : collectGuids(node, false);
    if (!guids.length) return;
    this.pendingFocusKey = key;
    this.opts.onSelect(guids, e.ctrlKey || e.metaKey);
  };

  private render(): void {
    if (!this.nodes.length) {
      this.root.innerHTML = `<p class="ms-empty">Sem estrutura espacial neste modelo.</p>`;
      return;
    }
    this.computeStats();
    const html = this.nodes.map((n, i) => this.nodeHtml(n, `n${i}`, 0)).join("");
    this.root.innerHTML = html || `<p class="ms-empty">Nenhum elemento corresponde ao filtro.</p>`;
  }

  private computeStats(): void {
    this.stats.clear();
    const visit = (node: IfcTreeNode, key: string): NodeStats => {
      let taskHits = node.guid && this.taskGuids.has(node.guid) ? 1 : 0;
      let groupHits = node.guid && this.groupGuids.has(node.guid) ? 1 : 0;
      let hasHit = !!(node.guid && this.active.has(node.guid));
      node.children.forEach((c, i) => {
        const s = visit(c, `${key}.${i}`);
        taskHits += s.taskHits;
        groupHits += s.groupHits;
        if (s.hasHit) hasHit = true;
      });
      const rec = { taskHits, groupHits, hasHit };
      this.stats.set(key, rec);
      return rec;
    };
    this.nodes.forEach((n, i) => visit(n, `n${i}`));
  }

  private nodeHtml(node: IfcTreeNode, key: string, depth: number): string {
    const childHtml = node.children
      .map((c, i) => this.nodeHtml(c, `${key}.${i}`, depth + 1))
      .filter(Boolean)
      .join("");
    const matches = this.matches(node) || childHtml.length > 0;
    if (this.filter && !matches) return "";
    const open = this.filter ? true : !this.collapsed.has(key);
    const hasKids = node.children.length > 0;
    const label = escapeHtml(node.name || categoryLabel(node.category) || `#${node.localId ?? ""}`);
    const cat = node.category ? `<span class="ms-cat">${escapeHtml(categoryLabel(node.category))}</span>` : "";
    const st = this.stats.get(key);
    const exact = !!(node.guid && this.active.has(node.guid)) || key === this.selectedKey;
    const hit = !exact && !!st?.hasHit;
    const state = exact ? " is-active" : hit ? " is-hit" : "";
    const taskBadge = st?.taskHits
      ? `<span class="ms-prod" title="${st.taskHits} elemento${st.taskHits === 1 ? "" : "s"} ligado(s) a atividade">${st.taskHits}</span>`
      : "";
    const groupBadge = st?.groupHits
      ? `<span class="ms-grp" title="${st.groupHits} em conjunto IFC">set</span>`
      : "";
    const toggle = hasKids
      ? `<button type="button" class="ms-toggle${open ? "" : " is-collapsed"}" data-act="toggle" data-key="${escapeAttr(key)}" aria-label="${open ? "Recolher" : "Expandir"}">▸</button>`
      : `<span class="ms-toggle-ph"></span>`;
    return `<div class="ms-node" style="--d:${depth}">
      <div class="ms-row${state}" data-key="${escapeAttr(key)}" ${node.guid ? `data-guid="${escapeAttr(node.guid)}"` : ""}>
        ${toggle}<span class="ms-name" title="${escapeAttr(label)}">${label}</span>${cat}${taskBadge}${groupBadge}
      </div>
      ${hasKids && open ? `<div class="ms-kids">${childHtml}</div>` : ""}
    </div>`;
  }

  private matches(node: IfcTreeNode): boolean {
    if (!this.filter) return true;
    const blob = `${node.name} ${node.category ?? ""} ${node.guid ?? ""}`.toLowerCase();
    return blob.includes(this.filter);
  }
}

function collectIds(item: SpatialTreeItem, out: number[]): void {
  if (typeof item.localId === "number") out.push(item.localId);
  for (const c of item.children ?? []) collectIds(c, out);
}

function toNode(
  item: SpatialTreeItem,
  names: Map<number, { name: string; guid?: string }>,
  geom: Set<number>,
): IfcTreeNode {
  const localId = item.localId;
  const meta = localId != null ? names.get(localId) : undefined;
  return {
    localId,
    category: item.category,
    name: meta?.name || categoryLabel(item.category),
    guid: meta?.guid,
    children: (item.children ?? []).map((c) => toNode(c, names, geom)),
    hasGeom: localId != null && geom.has(localId),
  };
}

function collectGuids(node: IfcTreeNode, geomOnly: boolean): string[] {
  const out: string[] = [];
  const walk = (n: IfcTreeNode) => {
    if (n.guid && (!geomOnly || n.hasGeom)) out.push(n.guid);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return [...new Set(out)];
}

function categoryLabel(cat: string | null): string {
  if (!cat) return "Elemento";
  return cat.replace(/^IFC/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function attr(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw && "value" in raw) return attr((raw as { value: unknown }).value);
  return "";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
