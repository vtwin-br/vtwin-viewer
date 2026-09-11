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

export class IfcSpatialTree {
  private root: HTMLElement;
  private opts: IfcTreeOptions;
  private nodes: IfcTreeNode[] = [];
  private filter = "";
  private active = new Set<string>();
  private collapsed = new Set<string>();

  constructor(root: HTMLElement, opts: IfcTreeOptions) {
    this.root = root;
    this.opts = opts;
    this.root.addEventListener("click", this.onClick);
  }

  async bind(model: FragmentsModel, highlighter: ScheduleHighlighter): Promise<void> {
    this.root.innerHTML = `<p class="ms-empty">A ler a hierarquia espacial do IFC…</p>`;
    let spatial: SpatialTreeItem;
    try {
      spatial = await model.getSpatialStructure();
    } catch (err) {
      this.root.innerHTML = `<p class="ms-empty">Não foi possível ler a árvore espacial. ${(err as Error).message}</p>`;
      return;
    }
    const geom = new Set(await model.getItemsIdsWithGeometry());
    const ids: number[] = [];
    collectIds(spatial, ids);
    const names = new Map<number, { name: string; guid?: string }>();
    const chunk = 250;
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      try {
        const rows = await model.getItemsData(slice, {
          attributesDefault: false,
          attributes: ["Name", "GlobalId", "ObjectType"],
          relationsDefault: { attributes: false, relations: false },
        });
        for (let k = 0; k < slice.length; k++) {
          const row = rows[k];
          const guid = attr(row?.GlobalId) || undefined;
          const name = attr(row?.Name) || attr(row?.ObjectType);
          names.set(slice[k], { name, guid });
          if (guid) highlighter.registerGuid(guid, slice[k]);
        }
      } catch {
        /* ignore chunk */
      }
    }
    this.nodes = [toNode(spatial, names, geom)];
    this.collapsed = new Set();
    const walk = (n: IfcTreeNode, key: string, depth: number) => {
      if (depth >= 1 && n.children.length) this.collapsed.add(key);
      n.children.forEach((c, i) => walk(c, `${key}.${i}`, depth + 1));
    };
    this.nodes.forEach((n, i) => walk(n, `n${i}`, 0));
    this.render();
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

  clear(): void {
    this.nodes = [];
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
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-guids]");
    if (!row) return;
    const guids = (row.dataset.guids ?? "").split(",").filter(Boolean);
    if (!guids.length) return;
    this.opts.onSelect(guids, e.ctrlKey || e.metaKey);
  };

  private render(): void {
    if (!this.nodes.length) {
      this.root.innerHTML = `<p class="ms-empty">Sem estrutura espacial neste modelo.</p>`;
      return;
    }
    const html = this.nodes.map((n, i) => this.nodeHtml(n, `n${i}`, 0)).join("");
    this.root.innerHTML = html || `<p class="ms-empty">Nenhum elemento corresponde ao filtro.</p>`;
  }

  private nodeHtml(node: IfcTreeNode, key: string, depth: number): string {
    const childHtml = node.children
      .map((c, i) => this.nodeHtml(c, `${key}.${i}`, depth + 1))
      .filter(Boolean)
      .join("");
    const guids = collectGuids(node);
    const matches = this.matches(node) || childHtml.length > 0;
    if (this.filter && !matches) return "";
    const open = this.filter ? true : !this.collapsed.has(key);
    const hasKids = node.children.length > 0;
    const label = escapeHtml(node.name || categoryLabel(node.category) || `#${node.localId ?? ""}`);
    const cat = node.category ? `<span class="ms-cat">${escapeHtml(categoryLabel(node.category))}</span>` : "";
    const active = node.guid && this.active.has(node.guid) ? " is-active" : "";
    const toggle = hasKids
      ? `<button type="button" class="ms-toggle${open ? "" : " is-collapsed"}" data-act="toggle" data-key="${escapeAttr(key)}" aria-label="${open ? "Recolher" : "Expandir"}">▸</button>`
      : `<span class="ms-toggle-ph"></span>`;
    return `<div class="ms-node" style="--d:${depth}">
      <div class="ms-row${active}" data-guids="${escapeAttr(guids.join(","))}" ${node.guid ? `data-guid="${escapeAttr(node.guid)}"` : ""}>
        ${toggle}<span class="ms-name" title="${escapeAttr(label)}">${label}</span>${cat}
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

function collectGuids(node: IfcTreeNode): string[] {
  const out: string[] = [];
  const walk = (n: IfcTreeNode) => {
    if (n.guid) out.push(n.guid);
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
