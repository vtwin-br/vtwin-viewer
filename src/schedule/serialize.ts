import type { IfcAssociatedDocument, ScheduleData, SelectionGroup, Task } from "./types";
import { emptySchedule, recomputeProductGuidsByTask, recomputeScheduleRange } from "./range";
import type { IfcGeoref } from "../ifc/georef";
import type { SiteLimit } from "../logistics/types";

interface JsonTask {
  id: number;
  globalId: string;
  name: string;
  identification?: string;
  start?: string;
  end?: string;
  taskTimeId?: number;
  isMilestone?: boolean;
  predefinedType?: string;
  parentId?: number;
  nestsRelId?: number;
  children: JsonTask[];
  productIds: number[];
  productGuids: string[];
  groupIds: number[];
  cost?: number;
  costItemId?: number;
  costValueId?: number;
  costIsBreakdown?: boolean;
  predecessors: Task["predecessors"];
}

interface JsonSchedule {
  v: 1;
  projectId?: number;
  workPlanId?: number;
  workScheduleId?: number;
  declaresRelId?: number;
  aggregatesRelId?: number;
  scheduleControlRelId?: number;
  name: string;
  workPlanName?: string;
  documents: IfcAssociatedDocument[];
  roots: JsonTask[];
  groups: SelectionGroup[];
  costScheduleId?: number;
  currency: string;
  georef?: IfcGeoref;
  siteLimit?: SiteLimit;
}

export function scheduleToJson(schedule: ScheduleData): JsonSchedule {
  return {
    v: 1,
    projectId: schedule.projectId,
    workPlanId: schedule.workPlanId,
    workScheduleId: schedule.workScheduleId,
    declaresRelId: schedule.declaresRelId,
    aggregatesRelId: schedule.aggregatesRelId,
    scheduleControlRelId: schedule.scheduleControlRelId,
    name: schedule.name,
    workPlanName: schedule.workPlanName,
    documents: schedule.documents ?? [],
    roots: schedule.roots.map(taskToJson),
    groups: (schedule.groups ?? []).map((g) => ({ ...g })),
    costScheduleId: schedule.costScheduleId,
    currency: schedule.currency,
    georef: schedule.georef,
    siteLimit: schedule.siteLimit,
  };
}

export function scheduleFromJson(raw: unknown): ScheduleData | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Partial<JsonSchedule>;
  if (j.v !== 1 || !Array.isArray(j.roots)) return null;
  const out = emptySchedule();
  out.projectId = j.projectId;
  out.workPlanId = j.workPlanId;
  out.workScheduleId = j.workScheduleId;
  out.declaresRelId = j.declaresRelId;
  out.aggregatesRelId = j.aggregatesRelId;
  out.scheduleControlRelId = j.scheduleControlRelId;
  out.name = typeof j.name === "string" ? j.name : out.name;
  out.workPlanName = j.workPlanName;
  out.documents = Array.isArray(j.documents) ? j.documents : [];
  out.roots = j.roots.map(taskFromJson);
  out.groups = Array.isArray(j.groups) ? j.groups : [];
  out.costScheduleId = j.costScheduleId;
  out.currency = typeof j.currency === "string" ? j.currency : "BRL";
  out.georef = j.georef;
  if (j.siteLimit && Array.isArray(j.siteLimit.points) && j.siteLimit.points.length >= 3) {
    out.siteLimit = j.siteLimit;
  }
  out.byId = new Map();
  const index = (t: Task) => {
    out.byId.set(t.id, t);
    for (const c of t.children) index(c);
  };
  for (const r of out.roots) index(r);
  recomputeProductGuidsByTask(out);
  recomputeScheduleRange(out);
  return out;
}

function taskToJson(t: Task): JsonTask {
  return {
    id: t.id,
    globalId: t.globalId,
    name: t.name,
    identification: t.identification,
    start: t.start?.toISOString(),
    end: t.end?.toISOString(),
    taskTimeId: t.taskTimeId,
    isMilestone: t.isMilestone,
    predefinedType: t.predefinedType,
    parentId: t.parentId,
    nestsRelId: t.nestsRelId,
    children: t.children.map(taskToJson),
    productIds: t.productIds ?? [],
    productGuids: t.productGuids ?? [],
    groupIds: t.groupIds ?? [],
    cost: t.cost,
    costItemId: t.costItemId,
    costValueId: t.costValueId,
    costIsBreakdown: t.costIsBreakdown,
    predecessors: t.predecessors ?? [],
  };
}

function taskFromJson(j: JsonTask): Task {
  return {
    id: j.id,
    globalId: j.globalId ?? "",
    name: j.name ?? "(sem nome)",
    identification: j.identification,
    start: j.start ? new Date(j.start) : undefined,
    end: j.end ? new Date(j.end) : undefined,
    taskTimeId: j.taskTimeId,
    isMilestone: j.isMilestone,
    predefinedType: j.predefinedType,
    parentId: j.parentId,
    nestsRelId: j.nestsRelId,
    children: (j.children ?? []).map(taskFromJson),
    productIds: j.productIds ?? [],
    productGuids: j.productGuids ?? [],
    groupIds: j.groupIds ?? [],
    cost: j.cost,
    costItemId: j.costItemId,
    costValueId: j.costValueId,
    costIsBreakdown: j.costIsBreakdown,
    predecessors: j.predecessors ?? [],
  };
}
