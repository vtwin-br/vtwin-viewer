import type { FragmentsModel, ItemData } from "@thatopen/fragments";
import * as WebIFC from "web-ifc";
import type { ScheduleData } from "./types";
import { parseOpenIfcModel } from "./parseSchedule";
import type { StepIndex } from "../ifc/stepIndex";

const ENTITY_TYPES = [
  "IFCPROJECT",
  "IFCSITE",
  "IFCGEOMETRICREPRESENTATIONCONTEXT",
  "IFCMAPCONVERSION",
  "IFCPROJECTEDCRS",
  "IFCLOCALPLACEMENT",
  "IFCAXIS2PLACEMENT3D",
  "IFCCARTESIANPOINT",
  "IFCDIRECTION",
  "IFCWORKPLAN",
  "IFCWORKSCHEDULE",
  "IFCTASK",
  "IFCTASKTIME",
  "IFCSCHEDULETIMECONTROL",
  "IFCGROUP",
  "IFCCOSTSCHEDULE",
  "IFCCOSTITEM",
  "IFCCOSTVALUE",
  "IFCMONETARYUNIT",
  "IFCDOCUMENTINFORMATION",
  "IFCDOCUMENTREFERENCE",
  "IFCRELNESTS",
  "IFCRELASSIGNSTOCONTROL",
  "IFCRELASSIGNSTASKS",
  "IFCRELASSIGNSTOPRODUCT",
  "IFCRELASSIGNSTOPROCESS",
  "IFCRELASSIGNSTOGROUP",
  "IFCRELSEQUENCE",
  "IFCLAGTIME",
  "IFCRELDECLARES",
  "IFCRELAGGREGATES",
] as const;

const RELATION_TYPES = ENTITY_TYPES.filter((name) => name.startsWith("IFCREL"));

const REFERENCE_ATTRIBUTES = new Set([
  "TaskTime",
  "RelatingObject",
  "RelatedObjects",
  "RelatingControl",
  "TimeForTask",
  "RelatingProcess",
  "RelatedProcess",
  "RelatingProduct",
  "RelatingGroup",
  "CostValues",
  "Components",
  "RelatedDefinitions",
  "DateComponent",
  "TimeComponent",
  "TrueNorth",
  "ParentContext",
  "SourceCRS",
  "TargetCRS",
  "ObjectPlacement",
  "PlacementRelTo",
  "RelativePlacement",
  "Location",
  "Axis",
  "RefDirection",
]);

/**
 * Extrai o snapshot 4D/5D do mesmo artefato produzido pelo IfcImporter. Se a
 * versão do Fragments não tiver preservado atributos de relações, retorna
 * `null` para o chamador usar o parser web-ifc legado.
 */
export async function parseScheduleFromFragments(
  model: FragmentsModel,
  sourceIndex: StepIndex,
): Promise<ScheduleData | null> {
  const pattern = new RegExp(`^(?:${ENTITY_TYPES.join("|")})$`, "i");
  const categories = await model.getItemsOfCategories([pattern]);
  const idsByType = new Map<number, number[]>();
  const rowsById = new Map<number, any>();
  const requestedIds: number[] = [];

  for (const [name, ids] of Object.entries(categories)) {
    const type = webIfcType(name.toUpperCase());
    if (type == null) continue;
    idsByType.set(type, ids);
    requestedIds.push(...ids);
  }
  if (!requestedIds.length) return null;

  await loadRows(model, requestedIds, rowsById);
  for (let depth = 0; depth < 4; depth++) {
    const references = new Set<number>();
    for (const row of rowsById.values()) collectReferences(row, references);
    for (const id of rowsById.keys()) references.delete(id);
    if (!references.size) break;
    await loadRows(model, [...references], rowsById);
  }

  const taskType = webIfcType("IFCTASK");
  const taskCount = taskType == null ? 0 : (idsByType.get(taskType)?.length ?? 0);
  const relationIds = RELATION_TYPES.flatMap((name) => {
    const type = webIfcType(name);
    return type == null ? [] : (idsByType.get(type) ?? []);
  });
  const relationFields = relationIds.reduce((count, id) => {
    const row = rowsById.get(id);
    return count + (row && hasRelationAttributes(row) ? 1 : 0);
  }, 0);
  if (taskCount > 0 && relationIds.length > 0 && relationFields === 0) return null;

  const api = new FragmentIfcApi(idsByType, rowsById);
  try {
    const schedule = parseOpenIfcModel(api as unknown as WebIFC.IfcAPI, 0);
    return validateAgainstStepIndex(schedule, sourceIndex) ? schedule : null;
  } catch {
    return null;
  }
}

class FragmentIfcApi {
  constructor(
    private readonly idsByType: Map<number, number[]>,
    private readonly rowsById: Map<number, any>,
  ) {}

  GetLineIDsWithType(_modelId: number, type: number) {
    const ids = this.idsByType.get(type) ?? [];
    return {
      size: () => ids.length,
      get: (index: number) => ids[index],
    };
  }

  GetLine(_modelId: number, expressId: number): any {
    return this.rowsById.get(expressId) ?? null;
  }
}

async function loadRows(
  model: FragmentsModel,
  ids: number[],
  rowsById: Map<number, any>,
): Promise<void> {
  const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0 && !rowsById.has(id));
  const chunk = 500;
  for (let offset = 0; offset < unique.length; offset += chunk) {
    const slice = unique.slice(offset, offset + chunk);
    const rows = await model.getItemsData(slice, {
      attributesDefault: true,
      relationsDefault: { attributes: false, relations: false },
    });
    for (let index = 0; index < slice.length; index++) {
      rowsById.set(slice[index]!, normalizeRow(rows[index], slice[index]!));
    }
  }
}

function normalizeRow(row: ItemData | undefined, expressId: number): any {
  const out: Record<string, unknown> = { expressID: expressId };
  if (!row) return out;
  for (const [name, value] of Object.entries(row)) {
    if (Array.isArray(value)) continue;
    out[name] = unwrap(value);
  }
  return out;
}

function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === "object" && "value" in value) {
    return unwrap((value as { value: unknown }).value);
  }
  return value;
}

function collectReferences(row: Record<string, unknown>, out: Set<number>): void {
  for (const [name, value] of Object.entries(row)) {
    if (!REFERENCE_ATTRIBUTES.has(name)) continue;
    collectNumbers(value, out);
  }
}

function collectNumbers(value: unknown, out: Set<number>): void {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) for (const item of value) collectNumbers(item, out);
}

function hasRelationAttributes(row: Record<string, unknown>): boolean {
  return (
    "RelatingObject" in row ||
    "RelatedObjects" in row ||
    "RelatingControl" in row ||
    "RelatingProcess" in row ||
    "RelatingProduct" in row ||
    "RelatingGroup" in row
  );
}

function webIfcType(name: string): number | undefined {
  const value = (WebIFC as unknown as Record<string, unknown>)[name];
  return typeof value === "number" ? value : undefined;
}

function validateAgainstStepIndex(schedule: ScheduleData, index: StepIndex): boolean {
  const idsByType = new Map<string, Set<number>>();
  const isType = (id: number | undefined, ...types: string[]): boolean => {
    if (id == null) return true;
    return types.some((type) => {
      let ids = idsByType.get(type);
      if (!ids) {
        ids = new Set(index.typeIds.get(type) ?? []);
        idsByType.set(type, ids);
      }
      return ids.has(id);
    });
  };

  if (!isType(schedule.projectId, "IFCPROJECT")) return false;
  if (!isType(schedule.workPlanId, "IFCWORKPLAN")) return false;
  if (!isType(schedule.workScheduleId, "IFCWORKSCHEDULE")) return false;
  if (!isType(schedule.declaresRelId, "IFCRELDECLARES")) return false;
  if (!isType(schedule.aggregatesRelId, "IFCRELAGGREGATES")) return false;
  if (!isType(schedule.scheduleControlRelId, "IFCRELASSIGNSTOCONTROL")) return false;
  if (!isType(schedule.costScheduleId, "IFCCOSTSCHEDULE")) return false;

  const sourceTaskCount = index.typeIds.get("IFCTASK")?.length ?? 0;
  if (schedule.byId.size !== sourceTaskCount) return false;
  for (const task of schedule.byId.values()) {
    if (!isType(task.id, "IFCTASK")) return false;
    if (task.globalId && index.guidToId.get(task.globalId) !== task.id) return false;
    if (!isType(task.taskTimeId, "IFCTASKTIME", "IFCSCHEDULETIMECONTROL")) return false;
    if (!isType(task.nestsRelId, "IFCRELNESTS")) return false;
    if (!isType(task.costItemId, "IFCCOSTITEM")) return false;
    if (!isType(task.costValueId, "IFCCOSTVALUE")) return false;
    if (task.productIds.length !== task.productGuids.length) return false;
    for (let item = 0; item < task.productIds.length; item++) {
      const guid = task.productGuids[item];
      const expressId = task.productIds[item];
      if (!guid || index.guidToId.get(guid) !== expressId) return false;
    }
  }

  for (const group of schedule.groups) {
    if (!isType(group.id, "IFCGROUP")) return false;
    if (group.globalId && index.guidToId.get(group.globalId) !== group.id) return false;
    if (!isType(group.assignRelId, "IFCRELASSIGNSTOGROUP")) return false;
    if (group.productIds.length !== group.productGuids.length) return false;
    for (let item = 0; item < group.productIds.length; item++) {
      const guid = group.productGuids[item];
      const expressId = group.productIds[item];
      if (!guid || index.guidToId.get(guid) !== expressId) return false;
    }
  }

  return true;
}
