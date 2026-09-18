import type { FragmentsModel, SpatialTreeItem } from "@thatopen/fragments";
import {
  categoryLabel,
  familyLabel,
  familyRank,
  isIfcStorey,
  normalizeIfcClass,
  productFamily,
} from "../ifc/ifcFamilies";
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

export type IfcTreeViewMode = "hierarchy" | "levels" | "types";

export interface IfcTreeOptions {
  onSelect: (guids: string[], additive: boolean) => void;
}

export interface IfcTreeFilterUi {
  modelSelect: HTMLSelectElement | null;
  typeSelect: HTMLSelectElement | null;
  viewButtons: ArrayLike<HTMLElement>;
}

interface ProductItem {
  family: string;
  category: string;
  modelId: string;
  localId: number;
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
  private source: IfcTreeNode[] = [];
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
  private modelLabels = new Map<string, string>();
  private highlighter: ScheduleHighlighter | null = null;
  private filterRevision = 0;
  private viewRevision = 0;
  private viewMode: IfcTreeViewMode = "hierarchy";
  private modelFilter: string | null = null;
  private categoryFilter: string | null = null;
  private filterUi: IfcTreeFilterUi | null = null;
  private productItems: ProductItem[] = [];

  constructor(root: HTMLElement, opts: IfcTreeOptions) {
    this.root = root;
    this.opts = opts;
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("dragstart", this.onDragStart);
    this.root.addEventListener("dragend", this.onDragEnd);
    this.root.addEventListener("pointerover", this.onPointerOver);
  }

  attachFilterUi(ui: IfcTreeFilterUi): void {
    this.filterUi = ui;
    ui.modelSelect?.addEventListener("change", () => {
      void this.setModelFilter(ui.modelSelect?.value || null);
    });
    ui.typeSelect?.addEventListener("change", () => {
      void this.setCategoryFilter(ui.typeSelect?.value || null);
    });
    for (let i = 0; i < ui.viewButtons.length; i++) {
      const btn = ui.viewButtons[i]!;
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-ifc-view");
        if (mode === "hierarchy" || mode === "levels" || mode === "types") {
          void this.setViewMode(mode);
        }
      });
    }
    this.syncFilterUi();
  }

  async setViewMode(mode: IfcTreeViewMode): Promise<void> {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    await this.applyView();
  }

  async setModelFilter(modelId: string | null): Promise<void> {
    const next = modelId || null;
    if (this.modelFilter === next) return;
    this.modelFilter = next;
    await this.applyView();
  }

  async setCategoryFilter(category: string | null): Promise<void> {
    const next = category || null;
    if (this.categoryFilter === next) return;
    this.categoryFilter = next;
    await this.applyView();
    if (next) await this.emitSelectionFromType(next);
  }

  async bind(model: FragmentsModel, highlighter: ScheduleHighlighter): Promise<void> {
    await this.bindMany([{ model, label: "IFC", modelId: "main" }], highlighter);
  }

  async bindMany(entries: IfcTreeBindEntry[], highlighter: ScheduleHighlighter): Promise<void> {
    const started = performance.now();
    const key = entries.map((e) => e.modelId).join("\0");
    if (key === this.boundKey && this.source.length) {
      this.paintActive();
      this.syncFilterUi();
      return;
    }
    this.boundKey = key;
    this.highlighter = highlighter;
    this.models = new Map(entries.map((entry) => [entry.modelId, entry.model]));
    this.modelLabels = new Map(entries.map((entry) => [entry.modelId, entry.label.replace(/\.ifc$/i, "")]));
    this.productItems = [];
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
          category: "IFCFILE",
          name: `${entry.label} (sem árvore)`,
          children: [],
          hasGeom: false,
          modelId: entry.modelId,
          metadataLoaded: true,
        });
        console.warn(err);
        continue;
      }
      const knownGeom = highlighter.geomIdsOf(entry.modelId);
      const geomIds = knownGeom?.length ? knownGeom : await entry.model.getItemsIdsWithGeometry();
      const geom = new Set(geomIds);
      const tree = toNode(spatial, geom, entry.modelId);
      this.productItems.push(...(await loadProductItems(entry, geom)));
      if (entries.length > 1) {
        forest.push({
          localId: null,
          category: "IFCFILE",
          name: entry.label.replace(/\.ifc$/i, ""),
          children: [tree],
          hasGeom: false,
          modelId: entry.modelId,
          metadataLoaded: true,
        });
      } else {
        forest.push(tree);
      }
    }
    this.source = forest;
    if (this.modelFilter && !this.modelLabels.has(this.modelFilter)) this.modelFilter = null;
    await this.applyView();
    recordMetric("vista:ifc-tree:bind", performance.now() - started, {
      models: entries.length,
      indexedNodes: this.index.size,
      initialNodes: this.nodes.length,
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
    this.source = [];
    this.nodes = [];
    this.index.clear();
    this.stats.clear();
    this.selectedKey = null;
    this.active.clear();
    this.boundKey = "";
    this.models.clear();
    this.modelLabels.clear();
    this.productItems = [];
    this.highlighter = null;
    this.root.innerHTML = emptyIfc();
    this.syncFilterUi();
  }

  private async applyView(): Promise<void> {
    const revision = ++this.viewRevision;
    if (this.categoryFilter && !this.listCategories().some((c) => c.id === this.categoryFilter)) {
      this.categoryFilter = null;
    }
    this.nodes = this.displayForest();
    this.collapsed = new Set();
    this.visibleLimits.clear();
    this.selectedKey = null;
    this.index.clear();
    const walk = (n: IfcTreeNode, key: string, depth: number) => {
      this.index.set(key, n);
      if (depth >= 1 && n.children.length) this.collapsed.add(key);
      n.children.forEach((c, i) => walk(c, `${key}.${i}`, depth + 1));
    };
    this.nodes.forEach((n, i) => walk(n, `n${i}`, 0));
    const initial: IfcTreeNode[] = [];
    for (const root of this.nodes) initial.push(root, ...root.children);
    await this.hydrateNodes(initial, false);
    if (revision !== this.viewRevision) return;
    this.render();
    this.syncFilterUi();
  }

  private listCategories(): { id: string; label: string; count: number }[] {
    const counts = new Map<string, number>();
    if (this.productItems.length) {
      for (const item of this.productItems) {
        if (this.modelFilter && item.modelId !== this.modelFilter) continue;
        counts.set(item.family, (counts.get(item.family) ?? 0) + 1);
      }
    } else {
      const forest = this.modelFilter ? filterByModel(this.source, this.modelFilter) : this.source;
      const walk = (n: IfcTreeNode) => {
        const family = productFamily(n.category);
        if (family && n.localId != null) counts.set(family, (counts.get(family) ?? 0) + 1);
        for (const c of n.children) walk(c);
      };
      for (const n of forest) walk(n);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, label: familyLabel(id), count }))
      .sort((a, b) => {
        const ia = familyRank(a.id);
        const ib = familyRank(b.id);
        if (ia !== ib) return ia - ib;
        return a.label.localeCompare(b.label, "pt");
      });
  }

  private displayForest(): IfcTreeNode[] {
    let forest = this.modelFilter ? filterByModel(this.source, this.modelFilter) : this.source;
    if (this.viewMode === "levels") {
      forest = groupByStorey(forest, this.modelLabels, !this.modelFilter && this.modelLabels.size > 1);
    } else if (this.viewMode === "types") {
      forest = this.typesForest(forest);
    }
    if (this.categoryFilter) forest = pruneByFamily(forest, this.categoryFilter);
    return forest;
  }

  private typesForest(spatial: IfcTreeNode[]): IfcTreeNode[] {
    if (this.productItems.length) {
      let items = this.productItems;
      if (this.modelFilter) items = items.filter((i) => i.modelId === this.modelFilter);
      const by = new Map<string, IfcTreeNode[]>();
      for (const item of items) {
        const list = by.get(item.family) ?? [];
        list.push({
          localId: item.localId,
          category: item.category,
          name: familyLabel(item.family),
          children: [],
          hasGeom: true,
          modelId: item.modelId,
        });
        by.set(item.family, list);
      }
      return [...by.entries()]
        .sort((a, b) => familyRank(a[0]) - familyRank(b[0]) || familyLabel(a[0]).localeCompare(familyLabel(b[0]), "pt"))
        .map(([family, children]) => ({
          localId: null,
          category: family,
          name: `${familyLabel(family)} (${children.length})`,
          children,
          hasGeom: false,
          metadataLoaded: true,
        }));
    }
    return groupByType(spatial);
  }

  private async emitSelectionFromType(family: string): Promise<void> {
    const items = this.productItems.filter(
      (i) => i.family === family && (!this.modelFilter || i.modelId === this.modelFilter),
    );
    if (items.length) {
      await this.emitLocals(
        items.map((i) => ({ modelId: i.modelId, localId: i.localId })),
        false,
      );
      return;
    }
    await this.emitLocals(this.nodes.flatMap(collectLocals), false);
  }

  private async emitNodeSelection(node: IfcTreeNode, additive: boolean): Promise<void> {
    const refs = collectLocals(node);
    if (refs.length) {
      await this.emitLocals(refs, additive);
      return;
    }
    const guids = collectGuids(node, false);
    if (guids.length) this.opts.onSelect(guids, additive);
  }

  private async emitLocals(refs: Array<{ modelId: string; localId: number }>, additive: boolean): Promise<void> {
    if (!refs.length) return;
    const hl = this.highlighter;
    if (!hl) return;
    const byModel = new Map<string, number[]>();
    for (const ref of refs) {
      const list = byModel.get(ref.modelId) ?? [];
      list.push(ref.localId);
      byModel.set(ref.modelId, list);
    }
    const groups = [...byModel.entries()].map(([modelId, localIds]) => ({ modelId, localIds }));
    const guids: string[] = [];
    for (const group of groups) guids.push(...(await hl.guidsFromLocalIds(group.localIds, group.modelId)));
    const unique = [...new Set(guids)];
    if (unique.length) {
      this.opts.onSelect(unique, additive);
      return;
    }
    if (!additive) await hl.isolateLocalIds(groups);
  }

  private syncFilterUi(): void {
    const ui = this.filterUi;
    if (!ui) return;
    const models = [...this.modelLabels.entries()].map(([id, label]) => ({ id, label }));
    if (ui.modelSelect) {
      const cur = this.modelFilter ?? "";
      ui.modelSelect.innerHTML =
        `<option value="">Todos os modelos</option>` +
        models
          .map(
            (m) =>
              `<option value="${escapeAttr(m.id)}"${m.id === cur ? " selected" : ""}>${escapeHtml(m.label)}</option>`,
          )
          .join("");
      ui.modelSelect.value = models.some((m) => m.id === cur) ? cur : "";
      ui.modelSelect.closest(".ifc-tree-select")?.toggleAttribute("hidden", models.length < 2);
    }
    if (ui.typeSelect) {
      const types = this.listCategories();
      const cur = this.categoryFilter ?? "";
      ui.typeSelect.innerHTML =
        `<option value="">Todos os tipos</option>` +
        types
          .map(
            (t) =>
              `<option value="${escapeAttr(t.id)}"${t.id === cur ? " selected" : ""}>${escapeHtml(t.label)} (${t.count})</option>`,
          )
          .join("");
      ui.typeSelect.value = types.some((t) => t.id === cur) ? cur : "";
    }
    for (let i = 0; i < ui.viewButtons.length; i++) {
      const btn = ui.viewButtons[i]!;
      const on = btn.getAttribute("data-ifc-view") === this.viewMode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
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
    this.pendingFocusKey = key;
    await this.emitNodeSelection(node, e.ctrlKey || e.metaKey);
    void this.hydrateNodes([node], true).then(() => this.render());
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
      this.root.innerHTML = emptyIfc(this.emptyReason());
      return;
    }
    this.computeStats();
    const html = this.nodes.map((n, i) => this.nodeHtml(n, `n${i}`, 0)).join("");
    this.root.innerHTML = html || `<div class="empty-state"><span>Filtro</span></div>`;
  }

  private emptyReason(): string {
    if (!this.source.length) return "IFC";
    if (this.viewMode === "levels") return "Sem níveis (IfcBuildingStorey) neste recorte.";
    if (this.viewMode === "types") return "Sem elementos com geometria neste recorte.";
    return "Nada corresponde aos filtros.";
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

function emptyIfc(msg = "IFC"): string {
  return `<div class="empty-state" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 16.5V8.2L12 4l8 4.2v8.3L12 21z" stroke-linejoin="round"/><path d="M4 8.2L12 12.5 20 8.2M12 12.5V21" opacity="0.45" stroke-linejoin="round"/></svg><span>${escapeHtml(msg)}</span></div>`;
}

function isStorey(cat: string | null): boolean {
  return isIfcStorey(cat);
}

function filterByModel(nodes: IfcTreeNode[], modelId: string): IfcTreeNode[] {
  const out: IfcTreeNode[] = [];
  for (const n of nodes) {
    if (n.modelId === modelId) {
      if (n.category === "IFCFILE") out.push(...n.children);
      else out.push(n);
      continue;
    }
    const kids = filterByModel(n.children, modelId);
    if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

function pruneByFamily(nodes: IfcTreeNode[], family: string): IfcTreeNode[] {
  const out: IfcTreeNode[] = [];
  for (const n of nodes) {
    if (productFamily(n.category) === family) {
      out.push(n);
      continue;
    }
    const kids = pruneByFamily(n.children, family);
    if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

function groupByStorey(forest: IfcTreeNode[], labels: Map<string, string>, many: boolean): IfcTreeNode[] {
  const out: IfcTreeNode[] = [];
  const walk = (n: IfcTreeNode) => {
    if (isStorey(n.category)) {
      const file = n.modelId ? labels.get(n.modelId) : undefined;
      const name = many && file ? `${n.name || "Nível"} · ${file}` : n.name || "Nível";
      out.push(name === n.name ? n : { ...n, name });
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const r of forest) walk(r);
  return out;
}

function groupByType(forest: IfcTreeNode[]): IfcTreeNode[] {
  const by = new Map<string, IfcTreeNode[]>();
  const walk = (n: IfcTreeNode) => {
    const family = productFamily(n.category);
    if (family && n.localId != null) {
      const list = by.get(family) ?? [];
      list.push(n);
      by.set(family, list);
    }
    for (const c of n.children) walk(c);
  };
  for (const r of forest) walk(r);
  return [...by.entries()]
    .sort((a, b) => familyRank(a[0]) - familyRank(b[0]) || familyLabel(a[0]).localeCompare(familyLabel(b[0]), "pt"))
    .map(([cat, children]) => ({
      localId: null,
      category: cat,
      name: `${familyLabel(cat)} (${children.length})`,
      children,
      hasGeom: false,
      metadataLoaded: true,
    }));
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

function collectLocals(node: IfcTreeNode): Array<{ modelId: string; localId: number }> {
  const out: Array<{ modelId: string; localId: number }> = [];
  const walk = (n: IfcTreeNode) => {
    if (typeof n.localId === "number" && n.modelId) out.push({ modelId: n.modelId, localId: n.localId });
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

function toNode(item: SpatialTreeItem, geom: Set<number>, modelId: string): IfcTreeNode {
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

async function loadProductItems(entry: IfcTreeBindEntry, geom: Set<number>): Promise<ProductItem[]> {
  let cats: string[] = [];
  try {
    cats = ((await entry.model.getItemsWithGeometryCategories()) ?? []).filter((c): c is string => !!c);
  } catch {
    cats = [];
  }
  if (!cats.length) {
    try {
      cats = ((await entry.model.getCategories()) ?? []).filter((c): c is string => !!c);
    } catch {
      return [];
    }
  }
  const wanted = [...new Set(cats.map(normalizeIfcClass))].filter((c) => productFamily(c));
  if (!wanted.length) return [];
  let map: Record<string, number[]> = {};
  try {
    map = await entry.model.getItemsOfCategories(wanted.map((c) => new RegExp(`^${escapeRe(c)}$`, "i")));
  } catch {
    return [];
  }
  const out: ProductItem[] = [];
  for (const [cat, ids] of Object.entries(map)) {
    const family = productFamily(cat);
    if (!family) continue;
    for (const id of ids) {
      if (typeof id !== "number") continue;
      if (geom.size && !geom.has(id)) continue;
      out.push({ family, category: normalizeIfcClass(cat), modelId: entry.modelId, localId: id });
    }
  }
  return out;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function branchMetadataLoaded(node: IfcTreeNode): boolean {
  if (!node.metadataLoaded && node.localId != null) return false;
  return node.children.every(branchMetadataLoaded);
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
