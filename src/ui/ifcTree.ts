import type { FragmentsModel, SpatialTreeItem } from "@thatopen/fragments";
import type { ScheduleHighlighter } from "../viewer/highlight";
import { recordMetric } from "../viewer/perfStats";
import { DND_GUIDS, setDragJson } from "./dnd";

export interface IfcTreeNode {
  localId: number | null;
  category: string | null;
  name: string;
  guid?: string;
  children: IfcTreeNode[];
  hasGeom: boolean;
  modelId?: string;
  metadataLoaded?: boolean;
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
  private visibleLimits = new Map<string, number>();
  private taskGuids = new Set<string>();
  private groupGuids = new Set<string>();
  private stats = new Map<string, NodeStats>();
  private boundKey = "";
  private models = new Map<string, FragmentsModel>();
  private highlighter: ScheduleHighlighter | null = null;
  private filterRevision = 0;

  constructor(root: HTMLElement, opts: IfcTreeOptions) {
    this.root = root;
    this.opts = opts;
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("dragstart", this.onDragStart);
    this.root.addEventListener("dragend", this.onDragEnd);
    this.root.addEventListener("pointerover", this.onPointerOver);
  }

  async bind(model: FragmentsModel, highlighter: ScheduleHighlighter): Promise<void> {
    await this.bindMany([{ model, label: "IFC", modelId: "main" }], highlighter);
  }

  async bindMany(entries: IfcTreeBindEntry[], highlighter: ScheduleHighlighter): Promise<void> {
    const started = performance.now();
    const key = entries.map((e) => e.modelId).join("\0");
    if (key === this.boundKey && this.nodes.length) {
      this.paintActive();
      return;
    }
    this.boundKey = key;
    this.highlighter = highlighter;
    this.models = new Map(entries.map((entry) => [entry.modelId, entry.model]));
    this.root.innerHTML = emptyIfc();
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
      const knownGeom = highlighter.geomIdsOf(entry.modelId);
      const geom = new Set(knownGeom ?? (await entry.model.getItemsIdsWithGeometry()));
      const tree = toNode(spatial, geom, entry.modelId);
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
    this.visibleLimits.clear();
    this.selectedKey = null;
    this.active.clear();
    this.index.clear();
    const walk = (n: IfcTreeNode, key: string, depth: number) => {
      this.index.set(key, n);
      if (depth >= 1 && n.children.length) this.collapsed.add(key);
      n.children.forEach((c, i) => walk(c, `${key}.${i}`, depth + 1));
    };
    this.nodes.forEach((n, i) => walk(n, `n${i}`, 0));
    const initial: IfcTreeNode[] = [];
    for (const root of this.nodes) {
      initial.push(root, ...root.children);
    }
    await this.hydrateNodes(initial, false);
    this.render();
    recordMetric("vista:ifc-tree:bind", performance.now() - started, {
      models: entries.length,
      indexedNodes: this.index.size,
      initialNodes: initial.length,
    });
  }

  /** GUIDs ligados a IfcTask e a IfcGroup — badges na árvore. */
  setRelations(taskGuids: Iterable<string>, groupGuids: Iterable<string>, rerender = true): void {
    this.taskGuids = new Set(taskGuids);
    this.groupGuids = new Set(groupGuids);
    if (rerender && this.nodes.length) this.render();
  }

  setFilter(q: string): void {
    this.filter = q.trim().toLowerCase();
    const revision = ++this.filterRevision;
    if (!this.filter) {
      this.render();
      return;
    }
    this.root.innerHTML = `<div class="empty-state"><span>Indexando filtro…</span></div>`;
    void this.hydrateNodes(this.nodes, true).then(() => {
      if (revision === this.filterRevision) this.render();
    });
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
      this.paintActive();
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
    let needRender = false;
    for (const key of expand) {
      if (this.collapsed.has(key)) {
        this.collapsed.delete(key);
        needRender = true;
      }
    }
    if (needRender || !this.root.querySelector(".ms-row")) this.render();
    else this.paintActive();
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

  private paintActive(): void {
    if (this.nodes.length) this.computeStats();
    this.root.querySelectorAll<HTMLElement>(".ms-row").forEach((el) => {
      const guid = el.dataset.guid ?? "";
      const key = el.dataset.key ?? "";
      const st = this.stats.get(key);
      const exact = (!!guid && this.active.has(guid)) || key === this.selectedKey;
      const hit = !exact && !!st?.hasHit;
      el.classList.toggle("is-active", exact);
      el.classList.toggle("is-hit", hit);
    });
  }

  clear(): void {
    this.nodes = [];
    this.index.clear();
    this.stats.clear();
    this.selectedKey = null;
    this.active.clear();
    this.boundKey = "";
    this.models.clear();
    this.highlighter = null;
    this.root.innerHTML = emptyIfc();
  }

  private onClick = async (e: MouseEvent) => {
    const more = (e.target as HTMLElement).closest<HTMLElement>("[data-act='more']");
    if (more) {
      const key = more.dataset.key ?? "";
      const node = this.index.get(key);
      if (!node) return;
      const next = (this.visibleLimits.get(key) ?? 300) + 500;
      this.visibleLimits.set(key, next);
      await this.hydrateNodes(node.children.slice(0, next), false);
      this.render();
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act='toggle']");
    if (btn) {
      const key = btn.dataset.key ?? "";
      if (this.collapsed.has(key)) {
        this.collapsed.delete(key);
        const node = this.index.get(key);
        if (node) {
          const limit = this.visibleLimits.get(key) ?? 300;
          await this.hydrateNodes(node.children.slice(0, limit), false);
        }
      } else {
        this.collapsed.add(key);
      }
      this.render();
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
    if (!row || row.dataset.act === "toggle") return;
    const key = row.dataset.key ?? "";
    const node = this.index.get(key);
    if (!node) return;
    await this.hydrateNodes([node], true);
    const geom = collectGuids(node, true);
    const guids = geom.length ? geom : collectGuids(node, false);
    if (!guids.length) return;
    this.pendingFocusKey = key;
    this.opts.onSelect(guids, e.ctrlKey || e.metaKey);
  };

  private onDragStart = (e: DragEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
    if (!row || row.dataset.act === "toggle" || !e.dataTransfer) return;
    const key = row.dataset.key ?? "";
    const node = this.index.get(key);
    if (!node) {
      e.preventDefault();
      return;
    }
    if (!branchMetadataLoaded(node)) {
      e.preventDefault();
      void this.hydrateNodes([node], true).then(() => this.render());
      return;
    }
    const geom = collectGuids(node, true);
    const guids = geom.length ? geom : collectGuids(node, false);
    if (!guids.length) {
      e.preventDefault();
      return;
    }
    setDragJson(e.dataTransfer, DND_GUIDS, guids);
    row.classList.add("is-dragging");
  };

  private onDragEnd = () => {
    this.root.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  };

  private onPointerOver = (e: PointerEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
    const node = row ? this.index.get(row.dataset.key ?? "") : undefined;
    if (!node || node.metadataLoaded) return;
    void this.hydrateNodes([node], false).then(() => this.render());
  };

  private async hydrateNodes(nodes: IfcTreeNode[], recursive: boolean): Promise<void> {
    const started = performance.now();
    const byModel = new Map<string, Map<number, IfcTreeNode[]>>();
    const visit = (node: IfcTreeNode) => {
      if (
        !node.metadataLoaded &&
        typeof node.localId === "number" &&
        node.modelId
      ) {
        const ids = byModel.get(node.modelId) ?? new Map<number, IfcTreeNode[]>();
        const matches = ids.get(node.localId) ?? [];
        matches.push(node);
        ids.set(node.localId, matches);
        byModel.set(node.modelId, ids);
      }
      if (recursive) for (const child of node.children) visit(child);
    };
    for (const node of nodes) visit(node);

    let loaded = 0;
    for (const [modelId, indexed] of byModel) {
      const model = this.models.get(modelId);
      if (!model) continue;
      const ids = [...indexed.keys()];
      const chunk = 250;
      for (let offset = 0; offset < ids.length; offset += chunk) {
        const slice = ids.slice(offset, offset + chunk);
        try {
          const rows = await model.getItemsData(slice, {
            attributesDefault: false,
            attributes: ["Name", "GlobalId", "ObjectType"],
            relationsDefault: { attributes: false, relations: false },
          });
          for (let index = 0; index < slice.length; index++) {
            const localId = slice[index]!;
            const row = rows[index];
            const guid = attr(row?.GlobalId) || undefined;
            const name = attr(row?.Name) || attr(row?.ObjectType);
            for (const node of indexed.get(localId) ?? []) {
              if (name) node.name = name;
              node.guid = guid;
              node.metadataLoaded = true;
            }
            if (guid) this.highlighter?.registerGuid(guid, localId, modelId);
            loaded += 1;
          }
        } catch {
          /* O ramo pode ser tentado novamente numa próxima expansão. */
        }
      }
    }
    if (loaded) {
      recordMetric("vista:ifc-tree:hydrate", performance.now() - started, {
        nodes: loaded,
        recursive,
      });
    }
  }

  private render(): void {
    if (!this.nodes.length) {
      this.root.innerHTML = emptyIfc();
      return;
    }
    this.computeStats();
    const html = this.nodes.map((n, i) => this.nodeHtml(n, `n${i}`, 0)).join("");
    this.root.innerHTML = html || `<div class="empty-state"><span>Filtro</span></div>`;
  }

  private computeStats(): void {
    this.stats.clear();
    this.visibleLimits.clear();
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
    const hasKids = node.children.length > 0;
    const open = this.filter ? true : !this.collapsed.has(key);
    let childHtml = "";
    if (hasKids && (open || this.filter)) {
      const limit = this.filter ? node.children.length : (this.visibleLimits.get(key) ?? 300);
      childHtml = node.children
        .slice(0, limit)
        .map((c, i) => this.nodeHtml(c, `${key}.${i}`, depth + 1))
        .filter(Boolean)
        .join("");
      if (!this.filter && node.children.length > limit) {
        childHtml += `<button type="button" class="ms-more" data-act="more" data-key="${escapeAttr(key)}">Mostrar mais (${node.children.length - limit})</button>`;
      }
    }
    const matches = this.matches(node) || childHtml.length > 0;
    if (this.filter && !matches) return "";
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
      <div class="ms-row${state}" data-key="${escapeAttr(key)}" draggable="true" ${node.guid ? `data-guid="${escapeAttr(node.guid)}"` : ""}>
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

function emptyIfc(): string {
  return `<div class="empty-state" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 16.5V8.2L12 4l8 4.2v8.3L12 21z" stroke-linejoin="round"/><path d="M4 8.2L12 12.5 20 8.2M12 12.5V21" opacity="0.45" stroke-linejoin="round"/></svg><span>IFC</span></div>`;
}

function toNode(
  item: SpatialTreeItem,
  geom: Set<number>,
  modelId: string,
): IfcTreeNode {
  const localId = item.localId;
  return {
    localId,
    category: item.category,
    name: categoryLabel(item.category),
    children: (item.children ?? []).map((c) => toNode(c, geom, modelId)),
    hasGeom: localId != null && geom.has(localId),
    modelId,
    metadataLoaded: localId == null,
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

function branchMetadataLoaded(node: IfcTreeNode): boolean {
  if (!node.metadataLoaded && node.localId != null) return false;
  return node.children.every(branchMetadataLoaded);
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
