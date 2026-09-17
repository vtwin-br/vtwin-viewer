import type { StepIndex } from "./stepIndex";
import type { SequenceType, Task } from "../schedule/types";
import {
  createIfcGuid,
  findEntity,
  formatIfcDateTime,
  ifcOptionalString,
  ifcString,
  serializeEntity,
  stepSet,
  type IfcSchemaKind,
  type StepEntity,
} from "./stepText";

export type { IfcSchemaKind, SequenceType };

export interface NewTaskInput {
  name: string;
  identification?: string;
  start?: Date;
  end?: Date;
  isMilestone?: boolean;
  parentId?: number;
  afterId?: number;
  /** Reutiliza o GlobalId (cópia para a COORD ou stub na disciplina). */
  globalId?: string;
}

export interface OutlineRowInput {
  name: string;
  identification?: string;
  start?: Date;
  end?: Date;
  outlineLevel: number;
  isMilestone?: boolean;
  cost?: number;
  predecessorIndexes?: Array<{ index: number; type: SequenceType; lagDays?: number }>;
}

export function serializeNewIfcTask(
  task: Task,
  schema: IfcSchemaKind = "IFC4",
  ownerHistory = "$",
): string {
  if (schema === "IFC2X3") {
    const taskId = task.identification?.trim() || `T${task.id}`;
    const args = [
      ifcString(task.globalId || createIfcGuid()),
      ownerHistory,
      ifcOptionalString(task.name),
      "$",
      "$",
      ifcString(taskId),
      "$",
      "$",
      task.isMilestone ? ".T." : ".F.",
      "$",
    ];
    return serializeEntity(task.id, "IFCTASK", args);
  }
  const args = [
    ifcString(task.globalId || createIfcGuid()),
    ownerHistory,
    ifcOptionalString(task.name),
    "$",
    "$",
    ifcOptionalString(task.identification),
    "$",
    "$",
    "$",
    task.isMilestone ? ".T." : ".F.",
    "$",
    task.taskTimeId != null ? `#${task.taskTimeId}` : "$",
    ".NOTDEFINED.",
  ];
  return serializeEntity(task.id, "IFCTASK", args);
}

export function serializeNewWorkPlan(
  expressId: number,
  name: string,
  when: Date,
  schema: IfcSchemaKind = "IFC4",
  ownerHistory = "$",
  dateTimeRef?: number,
): string {
  if (schema === "IFC2X3") {
    const stamp = dateTimeRef != null ? `#${dateTimeRef}` : "$";
    const args = [
      ifcString(createIfcGuid()),
      ownerHistory,
      ifcOptionalString(name),
      "$",
      "$",
      ifcString("WP"),
      stamp,
      "$",
      "$",
      "$",
      "$",
      stamp,
      "$",
      ".NOTDEFINED.",
      "$",
    ];
    return serializeEntity(expressId, "IFCWORKPLAN", args);
  }
  const stamp = ifcString(formatIfcDateTime(when));
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    ifcOptionalString(name),
    "$",
    "$",
    "$",
    stamp,
    "$",
    "$",
    "$",
    "$",
    stamp,
    "$",
    ".NOTDEFINED.",
  ];
  return serializeEntity(expressId, "IFCWORKPLAN", args);
}

export function serializeNewWorkSchedule(
  expressId: number,
  name: string,
  when: Date,
  schema: IfcSchemaKind = "IFC4",
  ownerHistory = "$",
  dateTimeRef?: number,
): string {
  if (schema === "IFC2X3") {
    const stamp = dateTimeRef != null ? `#${dateTimeRef}` : "$";
    const args = [
      ifcString(createIfcGuid()),
      ownerHistory,
      ifcOptionalString(name),
      "$",
      "$",
      ifcString("WS"),
      stamp,
      "$",
      "$",
      "$",
      "$",
      stamp,
      "$",
      ".PLANNED.",
      "$",
    ];
    return serializeEntity(expressId, "IFCWORKSCHEDULE", args);
  }
  const stamp = ifcString(formatIfcDateTime(when));
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    ifcOptionalString(name),
    "$",
    "$",
    "$",
    stamp,
    "$",
    "$",
    "$",
    "$",
    stamp,
    "$",
    ".PLANNED.",
  ];
  return serializeEntity(expressId, "IFCWORKSCHEDULE", args);
}

export function serializeNewCostSchedule(
  expressId: number,
  name: string,
  when: Date,
  schema: IfcSchemaKind = "IFC4",
  ownerHistory = "$",
  dateTimeRef?: number,
): string {
  if (schema === "IFC2X3") {
    const stamp = dateTimeRef != null ? `#${dateTimeRef}` : "$";
    const args = [
      ifcString(createIfcGuid()),
      ownerHistory,
      ifcOptionalString(name),
      "$",
      "$",
      "$",
      "$",
      stamp,
      "$",
      "$",
      stamp,
      ifcString("BUDGET"),
      ".BUDGET.",
    ];
    return serializeEntity(expressId, "IFCCOSTSCHEDULE", args);
  }
  const stamp = ifcString(formatIfcDateTime(when));
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    ifcOptionalString(name),
    "$",
    "$",
    "$",
    ".BUDGET.",
    "$",
    stamp,
    "$",
  ];
  return serializeEntity(expressId, "IFCCOSTSCHEDULE", args);
}

export function serializeIfcCalendarDate(expressId: number, d: Date): string {
  return serializeEntity(expressId, "IFCCALENDARDATE", [
    String(d.getDate()),
    String(d.getMonth() + 1),
    String(d.getFullYear()),
  ]);
}

export function serializeIfcLocalTime(expressId: number): string {
  return serializeEntity(expressId, "IFCLOCALTIME", ["0", "0", "0", "$", "$"]);
}

export function serializeIfcDateAndTime(expressId: number, calendarId: number, localTimeId: number): string {
  return serializeEntity(expressId, "IFCDATEANDTIME", [`#${calendarId}`, `#${localTimeId}`]);
}

export function serializeIfcScheduleTimeControl(
  expressId: number,
  name: string,
  ownerHistory: string,
  startDtId: number,
  endDtId: number,
): string {
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    ifcOptionalString(name),
    "$",
    "$",
    "$",
    "$",
    "$",
    `#${startDtId}`,
    "$",
    "$",
    "$",
    `#${endDtId}`,
    "$",
    "$",
    "$",
    "$",
    "$",
    "$",
    "$",
    "$",
    "$",
    "$",
  ];
  return serializeEntity(expressId, "IFCSCHEDULETIMECONTROL", args);
}

export function serializeRelAssignsTasks(
  expressId: number,
  taskId: number,
  scheduleId: number,
  timeControlId: number,
  ownerHistory = "$",
): string {
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    `(#${taskId})`,
    "$",
    `#${scheduleId}`,
    `#${timeControlId}`,
  ];
  return serializeEntity(expressId, "IFCRELASSIGNSTASKS", args);
}

export function serializeRelDeclares(
  expressId: number,
  projectId: number,
  definitionIds: number[],
  ownerHistory = "$",
): string {
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    `#${projectId}`,
    stepSet(definitionIds),
  ];
  return serializeEntity(expressId, "IFCRELDECLARES", args);
}

export function serializeRelAggregates(
  expressId: number,
  relatingId: number,
  relatedIds: number[],
  ownerHistory = "$",
): string {
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    `#${relatingId}`,
    stepSet(relatedIds),
  ];
  return serializeEntity(expressId, "IFCRELAGGREGATES", args);
}

export function serializeRelNests(
  expressId: number,
  parentId: number,
  childIds: number[],
  ownerHistory = "$",
): string {
  if (childIds.length === 0) return "";
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    `#${parentId}`,
    stepSet(childIds),
  ];
  return serializeEntity(expressId, "IFCRELNESTS", args);
}

export function serializeIfcLagTime(expressId: number, lagDays: number): string {
  const args = ["$", "$", "$", ifcDurationDays(lagDays), ".WORKTIME."];
  return serializeEntity(expressId, "IFCLAGTIME", args);
}

export function rewriteIfcLagTime(ent: StepEntity, lagDays: number): string {
  const args = [...ent.args];
  while (args.length < 5) args.push("$");
  args[3] = ifcDurationDays(lagDays);
  if (args[4] === "$") args[4] = ".WORKTIME.";
  return serializeEntity(ent.expressId, ent.type, args);
}

export function serializeRelSequence(
  expressId: number,
  predId: number,
  succId: number,
  type: SequenceType,
  schema: IfcSchemaKind = "IFC4",
  timeLagArg = "$",
): string {
  const args = [
    ifcString(createIfcGuid()),
    "$",
    "$",
    "$",
    `#${predId}`,
    `#${succId}`,
    timeLagArg,
    sequenceEnum(type),
  ];
  if (schema !== "IFC2X3") args.push("$");
  return serializeEntity(expressId, "IFCRELSEQUENCE", args);
}

export function rewriteRelSequence(
  ent: StepEntity,
  predId: number,
  succId: number,
  type: SequenceType,
  timeLagArg: string,
): string {
  const args = [...ent.args];
  while (args.length < 8) args.push("$");
  args[4] = `#${predId}`;
  args[5] = `#${succId}`;
  args[6] = timeLagArg;
  args[7] = sequenceEnum(type);
  return serializeEntity(ent.expressId, ent.type, args);
}

export function ifcDurationDays(days: number): string {
  const n = Math.round(days);
  if (n === 0) return "$";
  const body = n < 0 ? `-P${Math.abs(n)}D` : `P${n}D`;
  return `IFCDURATION('${body}')`;
}

export function ifcTimeMeasureDays(days: number): string {
  const seconds = Math.round(days * 86400);
  return Number.isInteger(seconds) ? `${seconds}.` : String(seconds);
}

export function rewriteWorkControlName(ent: StepEntity, name: string): string {
  const args = [...ent.args];
  while (args.length < 3) args.push("$");
  args[2] = ifcOptionalString(name);
  return serializeEntity(ent.expressId, ent.type, args);
}

export function rewriteRelNests(ent: StepEntity, parentId: number, childIds: number[]): string {
  if (childIds.length === 0) return `/* empty #${ent.expressId} IFCRELNESTS */`;
  const args = [...ent.args];
  while (args.length < 6) args.push("$");
  args[4] = `#${parentId}`;
  args[5] = stepSet(childIds);
  return serializeEntity(ent.expressId, ent.type, args);
}

export function rewriteRelatedObjects(ent: StepEntity, relatedArgIndex: number, ids: number[]): string {
  if (ids.length === 0) return `/* empty #${ent.expressId} ${ent.type} */`;
  const args = [...ent.args];
  while (args.length <= relatedArgIndex) args.push("$");
  args[relatedArgIndex] = stepSet(ids);
  return serializeEntity(ent.expressId, ent.type, args);
}

export function sequenceEnum(type: SequenceType): string {
  if (type === "SS") return ".START_START.";
  if (type === "FF") return ".FINISH_FINISH.";
  if (type === "SF") return ".START_FINISH.";
  return ".FINISH_START.";
}

export function findSequenceEntities(text: string, index?: StepIndex | null): StepEntity[] {
  const out: StepEntity[] = [];
  const ids = index?.typeIds.get("IFCRELSEQUENCE");
  if (ids) {
    for (const id of ids) {
      const ent = findEntity(text, id, index);
      if (ent) out.push(ent);
    }
    return out;
  }
  const re = /#(\d+)\s*=\s*IFCRELSEQUENCE\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ent = findEntity(text, Number(m[1]), index);
    if (ent) out.push(ent);
  }
  return out;
}

export function sequenceInvolves(ent: StepEntity, taskId: number): boolean {
  return ent.args[4] === `#${taskId}` || ent.args[5] === `#${taskId}`;
}
