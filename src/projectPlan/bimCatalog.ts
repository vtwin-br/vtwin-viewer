import type { FragmentsModel, SpatialTreeItem } from "@thatopen/fragments";
import { familyLabel, isIfcStorey, normalizeIfcClass, productFamily } from "../ifc/ifcFamilies";
import { modelHintOfLabel, storeyKeys } from "./linkHints";

export interface CatalogBucket {
  id: string;
  modelId: string;
  modelLabel: string;
  modelHint: string | null;
  storey: string | null;
  storeyKeys: string[];
  family: string;
  label: string;
  count: number;
  guids: string[];
  localIds: number[];
  sampleNames: string[];
}

export interface BimCatalog {
  buckets: CatalogBucket[];
  productCount: number;
  storeyCount: number;
}

export interface CatalogEntry {
  model: FragmentsModel;
  modelId: string;
  label: string;
}

export interface CatalogGuidSource {
  ready(): Promise<void>;
  geomIdsOf(modelId: string): number[] | undefined;
  guidsFromLocalIds(localIds: number[], modelId: string): Promise<string[]>;
}

interface Draft {
  modelId: string;
  modelLabel: string;
  modelHint: string | null;
  storey: string | null;
  storeyKeys: string[];
  family: string;
  localIds: number[];
}

function attr(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw && "value" in raw) return attr((raw as { value: unknown }).value);
  return "";
}

function collectStoreyIds(item: SpatialTreeItem, out: number[]): void {
  if (isIfcStorey(item.category) && typeof item.localId === "number") out.push(item.localId);
  for (const child of item.children ?? []) collectStoreyIds(child, out);
}

async function storeyNames(model: FragmentsModel, ids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  const chunk = 80;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    try {
      const rows = await model.getItemsData(slice, {
        attributesDefault: false,
        attributes: ["Name", "LongName"],
        relationsDefault: { attributes: false, relations: false },
      });
      for (let j = 0; j < slice.length; j++) {
        const name = attr(rows[j]?.Name) || attr(rows[j]?.LongName);
        if (name) names.set(slice[j]!, name);
      }
    } catch {
      /* nomes de nível ficam genéricos */
    }
  }
  return names;
}

function walkStoreys(
  item: SpatialTreeItem,
  current: string | null,
  names: Map<number, string>,
  geom: Set<number>,
  into: Map<number, string | null>,
): void {
  let storey = current;
  if (isIfcStorey(item.category)) {
    const id = typeof item.localId === "number" ? item.localId : null;
    storey = (id != null ? names.get(id) : undefined) || current || "Nível";
  }
  if (typeof item.localId === "number" && geom.has(item.localId)) {
    into.set(item.localId, storey);
  }
  for (const child of item.children ?? []) walkStoreys(child, storey, names, geom, into);
}

async function familyByLocalId(model: FragmentsModel, geom: Set<number>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let cats: string[] = [];
  try {
    cats = ((await model.getItemsWithGeometryCategories()) ?? []).filter((c): c is string => !!c);
  } catch {
    cats = [];
  }
  if (!cats.length) {
    try {
      cats = ((await model.getCategories()) ?? []).filter((c): c is string => !!c);
    } catch {
      return out;
    }
  }
  const wanted = [...new Set(cats.map(normalizeIfcClass))].filter((c) => productFamily(c));
  if (!wanted.length) return out;
  let map: Record<string, number[]> = {};
  try {
    map = await model.getItemsOfCategories(wanted.map((c) => new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")));
  } catch {
    return out;
  }
  for (const [cat, ids] of Object.entries(map)) {
    const family = productFamily(cat);
    if (!family) continue;
    for (const id of ids) {
      if (typeof id !== "number") continue;
      if (geom.size && !geom.has(id)) continue;
      out.set(id, family);
    }
  }
  return out;
}

async function sampleNames(model: FragmentsModel, localIds: number[]): Promise<string[]> {
  if (!localIds.length) return [];
  try {
    const rows = await model.getItemsData(localIds, {
      attributesDefault: false,
      attributes: ["Name", "ObjectType"],
      relationsDefault: { attributes: false, relations: false },
    });
    const names: string[] = [];
    for (const row of rows) {
      const name = attr(row?.Name) || attr(row?.ObjectType);
      if (name && !names.includes(name)) names.push(name);
    }
    return names.slice(0, 4);
  } catch {
    return [];
  }
}

export async function buildBimCatalog(entries: CatalogEntry[], guids: CatalogGuidSource): Promise<BimCatalog> {
  await guids.ready();
  const drafts = new Map<string, Draft>();
  const storeySeen = new Set<string>();

  for (const entry of entries) {
    const geomList = guids.geomIdsOf(entry.modelId) ?? (await entry.model.getItemsIdsWithGeometry());
    const geom = new Set(geomList);
    if (!geom.size) continue;
    let spatial: SpatialTreeItem;
    try {
      spatial = await entry.model.getSpatialStructure();
    } catch {
      continue;
    }
    const storeyIds: number[] = [];
    collectStoreyIds(spatial, storeyIds);
    const names = await storeyNames(entry.model, storeyIds);
    const byStorey = new Map<number, string | null>();
    walkStoreys(spatial, null, names, geom, byStorey);
    const families = await familyByLocalId(entry.model, geom);
    const label = entry.label.replace(/\.ifc$/i, "");
    const modelHint = modelHintOfLabel(label);

    for (const [localId, family] of families) {
      const storey = byStorey.get(localId) ?? null;
      if (storey) storeySeen.add(storey);
      const keys = storey ? storeyKeys(storey) : [];
      const key = `${entry.modelId}|${keys[0] ?? "_"}|${family}`;
      const draft = drafts.get(key);
      if (draft) {
        draft.localIds.push(localId);
        continue;
      }
      drafts.set(key, {
        modelId: entry.modelId,
        modelLabel: label,
        modelHint,
        storey,
        storeyKeys: keys,
        family,
        localIds: [localId],
      });
    }
  }

  const buckets: CatalogBucket[] = [];
  let productCount = 0;
  for (const draft of drafts.values()) {
    const uniqueLocals = [...new Set(draft.localIds)];
    const guidList: string[] = [];
    const chunk = 400;
    for (let i = 0; i < uniqueLocals.length; i += chunk) {
      guidList.push(...(await guids.guidsFromLocalIds(uniqueLocals.slice(i, i + chunk), draft.modelId)));
    }
    const uniqueGuids = [...new Set(guidList)];
    if (!uniqueGuids.length) continue;
    const entry = entries.find((e) => e.modelId === draft.modelId);
    const samples = entry ? await sampleNames(entry.model, uniqueLocals.slice(0, 4)) : [];
    const storeyBit = draft.storey ? ` · ${draft.storey}` : "";
    buckets.push({
      id: `${draft.modelId}|${draft.storeyKeys[0] ?? "_"}|${draft.family}`,
      modelId: draft.modelId,
      modelLabel: draft.modelLabel,
      modelHint: draft.modelHint,
      storey: draft.storey,
      storeyKeys: draft.storeyKeys,
      family: draft.family,
      label: `${familyLabel(draft.family)}${storeyBit} · ${draft.modelLabel}`,
      count: uniqueGuids.length,
      guids: uniqueGuids,
      localIds: uniqueLocals,
      sampleNames: samples,
    });
    productCount += uniqueGuids.length;
  }

  buckets.sort((a, b) => a.label.localeCompare(b.label, "pt"));
  return { buckets, productCount, storeyCount: storeySeen.size };
}

export function compactCatalog(catalog: BimCatalog, limit = 90): Array<{
  id: string;
  label: string;
  family: string;
  storey: string | null;
  count: number;
  samples: string[];
}> {
  return catalog.buckets.slice(0, limit).map((b) => ({
    id: b.id,
    label: b.label,
    family: b.family,
    storey: b.storey,
    count: b.count,
    samples: b.sampleNames,
  }));
}
