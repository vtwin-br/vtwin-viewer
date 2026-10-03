/**
 * Propriedades, classificação, documentos, tabelas, contenção espacial,
 * search sets e interferências — entidades IFC escritas no STEP.
 * Não há formato paralelo: o que a UI grava sai em `emitSemantic`.
 */
import type { StepIndex } from "./stepIndex";
import {
  commentEntity,
  createIfcGuid,
  findEntity,
  ifcOptionalString,
  ifcString,
  parseIfcString,
  parseStepSetIds,
  serializeEntity,
  stepSet,
  type IfcSchemaKind,
  type StepEntity,
} from "./stepText";

/** ObjectType de IfcGroup cuja consulta vive em Pset_Vista4dSearch.Query. */
export const VISTA4D_SEARCH_TYPE = "VISTA4D_SEARCH";
export const VISTA4D_SEARCH_PSET = "Pset_Vista4dSearch";
export const VISTA4D_SEARCH_QUERY = "Query";
/** Description dos IfcDocumentReference que apontam para um IfcTable homónimo. */
export const VISTA4D_TABLE_DOC = "IfcTable";

const SPATIAL_CONTAINERS = new Set([
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
  "IFCEXTERNALSPATIALELEMENT",
  "IFCEXTERNALSPATIALSTRUCTUREELEMENT",
]);

export function isSpatialContainer(type: string | undefined): boolean {
  if (!type) return false;
  return SPATIAL_CONTAINERS.has(type.toUpperCase());
}

export function isSpatialElement(type: string | undefined): boolean {
  if (!type) return false;
  const t = type.toUpperCase();
  return t === "IFCPROJECT" || isSpatialContainer(t);
}

export interface PropertySetProp {
  id: number;
  name: string;
  value: string;
}

export interface PropertySetView {
  id: number;
  name: string;
  relId?: number;
  properties: PropertySetProp[];
}

export interface PropertyWrite {
  ownerId: number;
  psetId: number;
  psetName: string;
  psetIsNew: boolean;
  relId?: number;
  propertyId: number;
  propertyName: string;
  value: string;
}

export interface ClassificationView {
  referenceId: number;
  relId?: number;
  identification: string;
  name: string;
  location: string;
  sourceName: string;
}

export interface ClassificationWrite {
  ownerId: number;
  referenceId: number;
  relId: number;
  sourceId?: number;
  isNew: boolean;
  identification: string;
  name: string;
  location: string;
  sourceName: string;
}

export interface DocumentView {
  documentId: number;
  relId?: number;
  name: string;
  identification: string;
  location: string;
  description: string;
}

export interface DocumentWrite {
  documentId: number;
  relId: number;
  isNew: boolean;
  name: string;
  identification: string;
  location: string;
  description: string;
  relatedIds: number[];
}

export interface TableView {
  tableId: number;
  name: string;
  columns: string[];
  rows: string[][];
  clusterIds: number[];
}

export interface TableWrite {
  name: string;
  columns: string[];
  rows: string[][];
  tableId: number;
  columnIds: number[];
  rowIds: number[];
  documentId?: number;
  relId?: number;
  documentIsNew: boolean;
  /** IfcProject (ou outro IfcRoot) ligado pelo IfcRelAssociatesDocument. */
  relatedIds: number[];
  replaceIds: number[];
}

export interface ContainmentWrite {
  productId: number;
  parentId: number;
  mode: "contain" | "aggregate";
}

export interface InterferenceView {
  relId: number;
  name: string;
  description: string;
  relatingId: number;
  relatedId: number;
  interferenceType: string;
}

export interface InterferenceWrite {
  relId: number;
  name: string;
  description: string;
  relatingId: number;
  relatedId: number;
  interferenceType: string;
  isNew: boolean;
}

export interface SearchQueryWrite {
  groupId: number;
  psetId: number;
  propertyId: number;
  relId: number;
  query: string;
}

export interface SemanticState {
  properties: PropertyWrite[];
  classifications: ClassificationWrite[];
  documents: DocumentWrite[];
  tables: TableWrite[];
  containments: ContainmentWrite[];
  interferences: InterferenceWrite[];
  searchQueries: SearchQueryWrite[];
}

export function emptySemanticState(): SemanticState {
  return {
    properties: [],
    classifications: [],
    documents: [],
    tables: [],
    containments: [],
    interferences: [],
    searchQueries: [],
  };
}

export function cloneSemantic(state: SemanticState | undefined | null): SemanticState {
  if (!state) return emptySemanticState();
  return {
    properties: state.properties.map((x) => ({ ...x })),
    classifications: state.classifications.map((x) => ({ ...x })),
    documents: state.documents.map((x) => ({ ...x, relatedIds: [...x.relatedIds] })),
    tables: state.tables.map((x) => ({
      ...x,
      columns: [...x.columns],
      rows: x.rows.map((r) => [...r]),
      columnIds: [...x.columnIds],
      rowIds: [...x.rowIds],
      relatedIds: [...(x.relatedIds ?? [])],
      replaceIds: [...x.replaceIds],
    })),
    containments: state.containments.map((x) => ({ ...x })),
    interferences: state.interferences.map((x) => ({ ...x })),
    searchQueries: state.searchQueries.map((x) => ({ ...x })),
  };
}

export interface SemanticEmitContext {
  schema: IfcSchemaKind;
  ownerHistory: string;
  find: (id: number) => StepEntity | null;
  index: StepIndex;
  allocId: () => number;
}

export function ifcTextValue(value: string): string {
  return `IFCTEXT(${ifcString(value)})`;
}

export function parseNominal(arg: string | undefined): string {
  if (!arg || arg.trim() === "$") return "";
  const trimmed = arg.trim();
  if (trimmed === ".T.") return "true";
  if (trimmed === ".F.") return "false";
  const wrapped = /^[A-Z][A-Z0-9_]*\((.*)\)$/i.exec(trimmed);
  if (!wrapped) return parseIfcString(trimmed);
  const inner = wrapped[1] ?? "";
  if (inner === ".T.") return "true";
  if (inner === ".F.") return "false";
  if (inner.startsWith("'")) return parseIfcString(inner);
  return inner.replace(/\.$/, "");
}

export function readPropertySets(text: string, index: StepIndex, ownerId: number): PropertySetView[] {
  const out: PropertySetView[] = [];
  for (const relId of index.typeIds.get("IFCRELDEFINESBYPROPERTIES") ?? []) {
    const rel = findEntity(text, relId, index);
    if (!rel) continue;
    const related = parseStepSetIds(rel.args[4]);
    if (!related.includes(ownerId)) continue;
    const psetId = parseStepSetIds(rel.args[5])[0];
    if (psetId == null) continue;
    const pset = findEntity(text, psetId, index);
    if (!pset || pset.type !== "IFCPROPERTYSET") continue;
    const properties: PropertySetProp[] = [];
    for (const propId of parseStepSetIds(pset.args[4])) {
      const prop = findEntity(text, propId, index);
      if (!prop || prop.type !== "IFCPROPERTYSINGLEVALUE") continue;
      properties.push({
        id: propId,
        name: parseIfcString(prop.args[0]),
        value: parseNominal(prop.args[2]),
      });
    }
    out.push({
      id: psetId,
      name: parseIfcString(pset.args[2]),
      relId,
      properties,
    });
  }
  return out;
}

export function readClassifications(text: string, index: StepIndex, ownerId: number): ClassificationView[] {
  const out: ClassificationView[] = [];
  for (const relId of index.typeIds.get("IFCRELASSOCIATESCLASSIFICATION") ?? []) {
    const rel = findEntity(text, relId, index);
    if (!rel) continue;
    if (!parseStepSetIds(rel.args[4]).includes(ownerId)) continue;
    const referenceId = parseStepSetIds(rel.args[5])[0];
    if (referenceId == null) continue;
    const ref = findEntity(text, referenceId, index);
    if (!ref || ref.type !== "IFCCLASSIFICATIONREFERENCE") continue;
    const sourceId = parseStepSetIds(ref.args[3])[0];
    let sourceName = "";
    if (sourceId != null) {
      const source = findEntity(text, sourceId, index);
      if (source?.type === "IFCCLASSIFICATION") {
        sourceName = parseIfcString(source.args[3] ?? source.args[0]);
      }
    }
    out.push({
      referenceId,
      relId,
      location: parseIfcString(ref.args[0]),
      identification: parseIfcString(ref.args[1]),
      name: parseIfcString(ref.args[2]),
      sourceName,
    });
  }
  return out;
}

export function readDocuments(text: string, index: StepIndex): DocumentView[] {
  const relByDoc = new Map<number, number>();
  for (const relId of index.typeIds.get("IFCRELASSOCIATESDOCUMENT") ?? []) {
    const rel = findEntity(text, relId, index);
    if (!rel) continue;
    const docId = parseStepSetIds(rel.args[5])[0];
    if (docId != null) relByDoc.set(docId, relId);
  }
  const out: DocumentView[] = [];
  for (const documentId of index.typeIds.get("IFCDOCUMENTREFERENCE") ?? []) {
    const ent = findEntity(text, documentId, index);
    if (!ent) continue;
    const ifc4 = ent.args.length >= 5;
    out.push({
      documentId,
      relId: relByDoc.get(documentId),
      location: parseIfcString(ent.args[0]),
      identification: parseIfcString(ent.args[1]),
      name: parseIfcString(ent.args[2]),
      description: ifc4 ? parseIfcString(ent.args[3]) : "",
    });
  }
  return out;
}

export function readTables(text: string, index: StepIndex): TableView[] {
  const out: TableView[] = [];
  for (const tableId of index.typeIds.get("IFCTABLE") ?? []) {
    const ent = findEntity(text, tableId, index);
    if (!ent) continue;
    const rowIds = parseStepSetIds(ent.args[1]);
    const columnIds = ent.args.length >= 3 ? parseStepSetIds(ent.args[2]) : [];
    const columns: string[] = [];
    for (const columnId of columnIds) {
      const col = findEntity(text, columnId, index);
      columns.push(parseIfcString(col?.args[1]) || parseIfcString(col?.args[0]) || `C${columns.length + 1}`);
    }
    const rows: string[][] = [];
    for (const rowId of rowIds) {
      const row = findEntity(text, rowId, index);
      if (!row) continue;
      const cells = splitCellList(row.args[0] ?? "");
      if (parseIfcString(row.args[1]) === "T" || row.args[1]?.trim() === ".T.") {
        if (!columns.length) columns.push(...cells);
        continue;
      }
      rows.push(cells);
    }
    out.push({
      tableId,
      name: parseIfcString(ent.args[0]) || "Tabela",
      columns: columns.length ? columns : ["Valor"],
      rows,
      clusterIds: [tableId, ...columnIds, ...rowIds],
    });
  }
  return out;
}

export function readInterferences(text: string, index: StepIndex): InterferenceView[] {
  const out: InterferenceView[] = [];
  for (const relId of index.typeIds.get("IFCRELINTERFERESELEMENTS") ?? []) {
    const ent = findEntity(text, relId, index);
    if (!ent) continue;
    const relatingId = parseStepSetIds(ent.args[4])[0];
    const relatedId = parseStepSetIds(ent.args[5])[0];
    if (relatingId == null || relatedId == null) continue;
    out.push({
      relId,
      name: parseIfcString(ent.args[2]) || "Interferência",
      description: parseIfcString(ent.args[3]),
      relatingId,
      relatedId,
      interferenceType: parseIfcString(ent.args[7]) || "CLASH",
    });
  }
  return out;
}

export interface SpatialNode {
  id: number;
  guid: string;
  type: string;
  name: string;
}

export function readSpatialNodes(text: string, index: StepIndex): SpatialNode[] {
  const out: SpatialNode[] = [];
  for (const [guid, id] of index.guidToId) {
    const ent = findEntity(text, id, index);
    if (!ent || !isSpatialElement(ent.type)) continue;
    out.push({
      id,
      guid,
      type: ent.type,
      name: parseIfcString(ent.args[2]) || ent.type,
    });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export function matchProductGuids(
  text: string,
  index: StepIndex,
  query: string,
  pending: PropertyWrite[] = [],
): string[] {
  const q = query.trim();
  if (!q) return [];
  const typeMatch = /^(?:tipo|type)\s*=\s*([A-Za-z0-9_]+)$/i.exec(q);
  if (typeMatch) {
    let type = typeMatch[1]!.toUpperCase();
    if (!type.startsWith("IFC")) type = `IFC${type}`;
    const ids = new Set(index.typeIds.get(type) ?? []);
    const guids: string[] = [];
    for (const [guid, id] of index.guidToId) {
      if (ids.has(id)) guids.push(guid);
    }
    return guids;
  }
  const prop = /^([^.=]+)\.([^=]+)=(.*)$/.exec(q);
  if (!prop) return [];
  const psetName = prop[1]!.trim().toLowerCase();
  const propName = prop[2]!.trim().toLowerCase();
  const expected = prop[3]!.trim().toLowerCase();
  const idToGuid = new Map<number, string>();
  for (const [guid, id] of index.guidToId) idToGuid.set(id, guid);
  const hits = new Set<string>();
  for (const relId of index.typeIds.get("IFCRELDEFINESBYPROPERTIES") ?? []) {
    const rel = findEntity(text, relId, index);
    if (!rel) continue;
    const psetId = parseStepSetIds(rel.args[5])[0];
    if (psetId == null) continue;
    const pset = findEntity(text, psetId, index);
    if (!pset || parseIfcString(pset.args[2]).toLowerCase() !== psetName) continue;
    let matched = false;
    for (const propId of parseStepSetIds(pset.args[4])) {
      const entity = findEntity(text, propId, index);
      if (!entity || entity.type !== "IFCPROPERTYSINGLEVALUE") continue;
      if (parseIfcString(entity.args[0]).toLowerCase() !== propName) continue;
      if (parseNominal(entity.args[2]).toLowerCase() === expected) matched = true;
    }
    if (!matched) continue;
    for (const ownerId of parseStepSetIds(rel.args[4])) {
      const guid = idToGuid.get(ownerId);
      if (guid) hits.add(guid);
    }
  }
  for (const write of pending) {
    if (write.psetName.toLowerCase() !== psetName || write.propertyName.toLowerCase() !== propName) continue;
    if (write.value.trim().toLowerCase() !== expected) continue;
    const guid = idToGuid.get(write.ownerId);
    if (guid) hits.add(guid);
  }
  return [...hits];
}

export function emitSemantic(
  state: SemanticState,
  ctx: SemanticEmitContext,
): { lines: string[]; replacements: Array<{ start: number; end: number; text: string }> } {
  const lines: string[] = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const replaced = new Set<number>();

  const replace = (ent: StepEntity, text: string) => {
    if (replaced.has(ent.expressId)) return;
    replaced.add(ent.expressId);
    replacements.push({ start: ent.start, end: ent.end, text });
  };

  const byPset = new Map<number, PropertyWrite[]>();
  for (const write of state.properties) {
    const list = byPset.get(write.psetId);
    if (list) list.push(write);
    else byPset.set(write.psetId, [write]);
  }
  for (const [psetId, writes] of byPset) {
    for (const write of writes) {
      lines.push(
        serializeEntity(write.propertyId, "IFCPROPERTYSINGLEVALUE", [
          ifcString(write.propertyName),
          "$",
          ifcTextValue(write.value),
          "$",
        ]),
      );
    }
    const first = writes[0]!;
    if (first.psetIsNew) {
      lines.push(
        serializeEntity(psetId, "IFCPROPERTYSET", [
          ifcString(createIfcGuid()),
          ctx.ownerHistory,
          ifcString(first.psetName),
          "$",
          stepSet(writes.map((w) => w.propertyId)),
        ]),
      );
      if (first.relId != null) {
        lines.push(serializeRelDefines(first.relId, first.ownerId, psetId, ctx.ownerHistory));
      }
    } else {
      const ent = ctx.find(psetId);
      if (!ent) throw new Error(`IfcPropertySet #${psetId} não está no STEP.`);
      const ids = parseStepSetIds(ent.args[4]);
      for (const write of writes) {
        if (!ids.includes(write.propertyId)) ids.push(write.propertyId);
      }
      const args = [...ent.args];
      args[4] = stepSet(ids);
      replace(ent, serializeEntity(ent.expressId, ent.type, args));
    }
  }

  for (const item of state.classifications) {
    if (item.sourceName.trim() && item.sourceId != null && item.isNew) {
      lines.push(serializeClassification(item.sourceId, item.sourceName, ctx.schema));
    }
    const sourceRef = item.sourceId != null ? `#${item.sourceId}` : "$";
    const refLine = serializeClassificationReference(item, ctx.schema, sourceRef);
    if (item.isNew) {
      lines.push(refLine);
      lines.push(
        serializeAssociates(
          "IFCRELASSOCIATESCLASSIFICATION",
          item.relId,
          item.ownerId,
          item.referenceId,
          ctx.ownerHistory,
        ),
      );
    } else {
      const ent = ctx.find(item.referenceId);
      if (!ent) throw new Error(`IfcClassificationReference #${item.referenceId} não está no STEP.`);
      replace(ent, refLine);
    }
  }

  for (const doc of state.documents) {
    const line = serializeDocumentReference(doc, ctx.schema);
    if (doc.isNew) {
      lines.push(line);
      if (doc.relatedIds.length && doc.relId) {
        lines.push(
          serializeAssociates(
            "IFCRELASSOCIATESDOCUMENT",
            doc.relId,
            doc.relatedIds,
            doc.documentId,
            ctx.ownerHistory,
          ),
        );
      }
    } else {
      const ent = ctx.find(doc.documentId);
      if (!ent) throw new Error(`IfcDocumentReference #${doc.documentId} não está no STEP.`);
      replace(ent, line);
    }
  }

  for (const table of state.tables) {
    for (const id of table.replaceIds) {
      const ent = ctx.find(id);
      if (ent) replace(ent, commentEntity(ent, "table"));
    }
    const rowIds = [...table.rowIds];
    if (ctx.schema === "IFC2X3") {
      const headingId = rowIds[0];
      if (headingId == null) continue;
      lines.push(serializeTableRow(headingId, table.columns, true));
      table.rows.forEach((row, i) => {
        const rowId = rowIds[i + 1];
        if (rowId != null) lines.push(serializeTableRow(rowId, row, false));
      });
      const emitted = [headingId, ...table.rows.map((_, i) => rowIds[i + 1]).filter((id): id is number => id != null)];
      lines.push(serializeEntity(table.tableId, "IFCTABLE", [ifcString(table.name), stepSet(emitted)]));
    } else {
      table.columns.forEach((name, i) => {
        const columnId = table.columnIds[i];
        if (columnId != null) lines.push(serializeTableColumn(columnId, name, i));
      });
      table.rows.forEach((row, i) => {
        const rowId = rowIds[i];
        if (rowId != null) lines.push(serializeTableRow(rowId, row, false));
      });
      lines.push(
        serializeEntity(table.tableId, "IFCTABLE", [
          ifcString(table.name),
          rowIds.length ? stepSet(rowIds.slice(0, table.rows.length)) : "$",
          stepSet(table.columnIds),
        ]),
      );
    }
    if (table.documentIsNew && table.documentId != null && table.relId != null) {
      lines.push(
        serializeDocumentReference(
          {
            documentId: table.documentId,
            relId: table.relId,
            isNew: true,
            name: table.name,
            identification: "TABLE",
            location: "",
            description: VISTA4D_TABLE_DOC,
            relatedIds: table.relatedIds,
          },
          ctx.schema,
        ),
      );
      if (table.relatedIds.length) {
        lines.push(
          serializeAssociates(
            "IFCRELASSOCIATESDOCUMENT",
            table.relId,
            table.relatedIds,
            table.documentId,
            ctx.ownerHistory,
          ),
        );
      }
    }
  }

  for (const hit of state.interferences) {
    if (!hit.isNew) continue;
    if (ctx.schema === "IFC2X3") {
      throw new Error("IfcRelInterferesElements existe a partir do IFC4. Este ficheiro é IFC2X3.");
    }
    lines.push(
      serializeEntity(hit.relId, "IFCRELINTERFERESELEMENTS", [
        ifcString(createIfcGuid()),
        ctx.ownerHistory,
        ifcOptionalString(hit.name),
        ifcOptionalString(hit.description),
        `#${hit.relatingId}`,
        `#${hit.relatedId}`,
        "$",
        ifcString(hit.interferenceType || "CLASH"),
        ".U.",
      ]),
    );
  }

  for (const search of state.searchQueries) {
    lines.push(
      serializeEntity(search.propertyId, "IFCPROPERTYSINGLEVALUE", [
        ifcString(VISTA4D_SEARCH_QUERY),
        "$",
        ifcTextValue(search.query),
        "$",
      ]),
    );
    lines.push(
      serializeEntity(search.psetId, "IFCPROPERTYSET", [
        ifcString(createIfcGuid()),
        ctx.ownerHistory,
        ifcString(VISTA4D_SEARCH_PSET),
        "$",
        stepSet([search.propertyId]),
      ]),
    );
    lines.push(serializeRelDefines(search.relId, search.groupId, search.psetId, ctx.ownerHistory));
  }

  emitContainment(state.containments, ctx, lines, replace);
  return { lines, replacements };
}

function emitContainment(
  moves: ContainmentWrite[],
  ctx: SemanticEmitContext,
  lines: string[],
  replace: (ent: StepEntity, text: string) => void,
): void {
  if (!moves.length) return;
  interface RelMut {
    id: number;
    kind: "contain" | "aggregate";
    relating: number;
    related: number[];
    isNew: boolean;
    dirty: boolean;
    deleted: boolean;
    source: StepEntity | null;
  }
  const rels: RelMut[] = [];
  const take = (type: string, kind: RelMut["kind"], relatingArg: number, relatedArg: number) => {
    for (const id of ctx.index.typeIds.get(type) ?? []) {
      const ent = ctx.find(id);
      if (!ent) continue;
      const relating = parseStepSetIds(ent.args[relatingArg])[0];
      if (relating == null) continue;
      rels.push({
        id,
        kind,
        relating,
        related: parseStepSetIds(ent.args[relatedArg]),
        isNew: false,
        dirty: false,
        deleted: false,
        source: ent,
      });
    }
  };
  take("IFCRELCONTAINEDINSPATIALSTRUCTURE", "contain", 5, 4);
  take("IFCRELAGGREGATES", "aggregate", 4, 5);

  for (const move of moves) {
    for (const rel of rels) {
      if (rel.kind !== move.mode || rel.deleted) continue;
      if (!rel.related.includes(move.productId) || rel.relating === move.parentId) continue;
      rel.related = rel.related.filter((id) => id !== move.productId);
      rel.dirty = true;
      if (!rel.related.length) rel.deleted = true;
    }
    let host = rels.find((rel) => rel.kind === move.mode && rel.relating === move.parentId && !rel.deleted);
    if (!host) {
      host = {
        id: ctx.allocId(),
        kind: move.mode,
        relating: move.parentId,
        related: [],
        isNew: true,
        dirty: true,
        deleted: false,
        source: null,
      };
      rels.push(host);
    }
    if (!host.related.includes(move.productId)) {
      host.related.push(move.productId);
      host.dirty = true;
    }
  }

  for (const rel of rels) {
    if (!rel.dirty) continue;
    if (rel.deleted && rel.source) {
      replace(rel.source, commentEntity(rel.source, "spatial"));
      continue;
    }
    if (rel.isNew) {
      lines.push(rel.kind === "contain" ? serializeContainment(rel.id, rel.relating, rel.related, ctx.ownerHistory) : serializeAggregate(rel.id, rel.relating, rel.related, ctx.ownerHistory));
      continue;
    }
    if (!rel.source) continue;
    const args = [...rel.source.args];
    if (rel.kind === "contain") args[4] = stepSet(rel.related);
    else args[5] = stepSet(rel.related);
    replace(rel.source, serializeEntity(rel.source.expressId, rel.source.type, args));
  }
}

function serializeRelDefines(relId: number, ownerId: number, psetId: number, ownerHistory: string): string {
  return serializeEntity(relId, "IFCRELDEFINESBYPROPERTIES", [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    stepSet([ownerId]),
    `#${psetId}`,
  ]);
}

function serializeAssociates(
  type: "IFCRELASSOCIATESDOCUMENT" | "IFCRELASSOCIATESCLASSIFICATION",
  relId: number,
  related: number | number[],
  relatingId: number,
  ownerHistory: string,
): string {
  const ids = Array.isArray(related) ? related : [related];
  return serializeEntity(relId, type, [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    stepSet(ids),
    `#${relatingId}`,
  ]);
}

function serializeClassification(id: number, name: string, schema: IfcSchemaKind): string {
  if (schema === "IFC2X3") {
    return serializeEntity(id, "IFCCLASSIFICATION", ["$", "$", "$", ifcString(name)]);
  }
  return serializeEntity(id, "IFCCLASSIFICATION", ["$", "$", "$", ifcString(name), "$", "$", "$"]);
}

function serializeClassificationReference(
  item: Pick<ClassificationWrite, "referenceId" | "identification" | "name" | "location">,
  schema: IfcSchemaKind,
  sourceRef: string,
): string {
  if (schema === "IFC2X3") {
    return serializeEntity(item.referenceId, "IFCCLASSIFICATIONREFERENCE", [
      ifcOptionalString(item.location),
      ifcOptionalString(item.identification),
      ifcOptionalString(item.name),
      sourceRef,
    ]);
  }
  return serializeEntity(item.referenceId, "IFCCLASSIFICATIONREFERENCE", [
    ifcOptionalString(item.location),
    ifcOptionalString(item.identification),
    ifcOptionalString(item.name),
    sourceRef,
    "$",
    "$",
  ]);
}

function serializeDocumentReference(doc: DocumentWrite, schema: IfcSchemaKind): string {
  if (schema === "IFC2X3") {
    return serializeEntity(doc.documentId, "IFCDOCUMENTREFERENCE", [
      ifcOptionalString(doc.location),
      ifcOptionalString(doc.identification),
      ifcOptionalString(doc.name),
    ]);
  }
  return serializeEntity(doc.documentId, "IFCDOCUMENTREFERENCE", [
    ifcOptionalString(doc.location),
    ifcOptionalString(doc.identification),
    ifcOptionalString(doc.name),
    ifcOptionalString(doc.description),
    "$",
  ]);
}

function serializeTableColumn(id: number, name: string, index: number): string {
  return serializeEntity(id, "IFCTABLECOLUMN", [ifcString(`C${index + 1}`), ifcString(name), "$", "$", "$"]);
}

function serializeTableRow(id: number, cells: string[], heading: boolean): string {
  const values = cells.length ? `(${cells.map((cell) => ifcTextValue(cell)).join(",")})` : "$";
  return serializeEntity(id, "IFCTABLEROW", [values, heading ? ".T." : ".F."]);
}

function serializeContainment(id: number, parentId: number, products: number[], ownerHistory: string): string {
  return serializeEntity(id, "IFCRELCONTAINEDINSPATIALSTRUCTURE", [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    stepSet(products),
    `#${parentId}`,
  ]);
}

function serializeAggregate(id: number, parentId: number, children: number[], ownerHistory: string): string {
  return serializeEntity(id, "IFCRELAGGREGATES", [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    `#${parentId}`,
    stepSet(children),
  ]);
}

function splitCellList(arg: string): string[] {
  const trimmed = arg.trim();
  if (!trimmed || trimmed === "$") return [];
  const inner = trimmed.startsWith("(") && trimmed.endsWith(")") ? trimmed.slice(1, -1) : trimmed;
  return splitTop(inner).map((part) => parseNominal(part));
}

function splitTop(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inString) {
      cur += c;
      if (c === "'") {
        if (raw[i + 1] === "'") {
          cur += "'";
          i++;
        } else inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
