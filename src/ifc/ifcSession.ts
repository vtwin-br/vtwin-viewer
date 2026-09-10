import type { ScheduleData, Task } from "../schedule/types";
import { inclusiveCalendarDays, recomputeScheduleRange } from "../schedule/range";
import {
  extraIsIdentity,
  emptyExtraTransform,
  type IfcGeoref,
  type ModelExtraTransform,
} from "./georef";
import { patchIfcGeoref, type GeoAnchorWrite } from "./georefWrite";
import {
  applyReplacements,
  bytesToLatin1,
  createIfcGuid,
  findEntity,
  formatIfcDateTime,
  formatMonetaryMeasure,
  ifcOptionalString,
  ifcString,
  insertBeforeLastEndsec,
  latin1ToBytes,
  maxExpressId,
  serializeEntity,
  type StepEntity,
} from "./stepText";

export interface TaskPatch {
  name?: string;
  identification?: string;
  start?: Date;
  end?: Date;
  /** Custo 5D (IfcCostValue.AppliedValue). */
  cost?: number;
}

/**
 * Mantém o IFC original em memória e aplica só as linhas alteradas
 * (IfcTask / IfcTaskTime / IfcCostItem / IfcCostValue / IfcSite) na exportação —
 * o resto do ficheiro fica intacto.
 */
export class IfcSession {
  readonly fileName: string;
  readonly schedule: ScheduleData;
  private readonly originalText: string;
  private nextExpressId: number;
  private readonly identityEdited = new Set<number>();
  private readonly timeEdited = new Set<number>();
  private readonly costEdited = new Set<number>();
  private readonly createdTaskTimeIds = new Set<number>();
  private readonly createdCostValueIds = new Set<number>();
  private readonly createdStarCostValueIds = new Set<number>();
  private readonly createdCostItemIds = new Set<number>();
  private readonly costItemNeedsValueLink = new Set<number>();
  private readonly createdCostRels = new Map<number, { assignRelId: number; scheduleRelId?: number }>();
  private extra = emptyExtraTransform();
  private geoWrite: GeoAnchorWrite | null = null;
  private geoChanged = false;
  dirty = false;

  constructor(buffer: Uint8Array, fileName: string, schedule: ScheduleData) {
    this.originalText = bytesToLatin1(buffer);
    this.fileName = fileName;
    this.schedule = schedule;
    this.nextExpressId = maxExpressId(this.originalText) + 1;
  }

  get georef(): IfcGeoref | undefined {
    return this.schedule.georef;
  }

  setExtraTransform(extra: ModelExtraTransform): void {
    this.extra = { ...extra };
    if (!extraIsIdentity(extra)) this.dirty = true;
  }

  setGeoAnchor(geo: GeoAnchorWrite, markDirty = true): void {
    this.geoWrite = { ...geo };
    this.geoChanged = true;
    if (markDirty) this.dirty = true;
  }

  applyTaskEdit(taskId: number, patch: TaskPatch): { task: Task; changed: boolean; timeChanged: boolean } {
    const task = this.schedule.byId.get(taskId);
    if (!task) throw new Error(`Tarefa #${taskId} não encontrada.`);

    let identity = false;
    let time = false;
    let cost = false;

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name && name !== task.name) {
        task.name = name;
        identity = true;
      }
    }
    if (patch.identification !== undefined) {
      const ident = patch.identification.trim() || undefined;
      if (ident !== task.identification) {
        task.identification = ident;
        identity = true;
      }
    }
    if (patch.start !== undefined && task.start?.getTime() !== patch.start.getTime()) {
      task.start = patch.start;
      time = true;
    }
    if (patch.end !== undefined && task.end?.getTime() !== patch.end.getTime()) {
      task.end = patch.end;
      time = true;
    }

    if (time && task.start && task.end && task.taskTimeId == null) {
      task.taskTimeId = this.nextExpressId++;
      this.createdTaskTimeIds.add(task.taskTimeId);
      identity = true;
    }

    if (patch.cost !== undefined) {
      const next = roundMoney(patch.cost);
      if (!(task.cost == null && next === 0) && roundMoney(task.cost ?? 0) !== next) {
        task.cost = next;
        cost = true;
        this.ensureCostEntities(task);
        if (task.costItemId != null) {
          for (const other of this.schedule.byId.values()) {
            if (other.id !== task.id && other.costItemId === task.costItemId) {
              other.cost = next;
            }
          }
        }
      }
    }

    if (identity) this.identityEdited.add(taskId);
    if (time) this.timeEdited.add(taskId);
    if (cost) this.costEdited.add(taskId);
    if (identity || time || cost) this.dirty = true;
    recomputeScheduleRange(this.schedule);
    return { task, changed: identity || time || cost, timeChanged: time };
  }

  private ensureCostEntities(task: Task): void {
    if (task.costValueId == null) {
      task.costValueId = this.nextExpressId++;
      this.createdCostValueIds.add(task.costValueId);
      if (task.costItemId != null) {
        this.costItemNeedsValueLink.add(task.costItemId);
        if (task.costIsBreakdown) this.createdStarCostValueIds.add(task.costValueId);
      }
    }
    if (task.costItemId == null) {
      task.costItemId = this.nextExpressId++;
      this.createdCostItemIds.add(task.costItemId);
      const assignRelId = this.nextExpressId++;
      const scheduleRelId =
        this.schedule.costScheduleId != null ? this.nextExpressId++ : undefined;
      this.createdCostRels.set(task.id, { assignRelId, scheduleRelId });
    }
    if (task.costItemId != null && task.costValueId != null) {
      for (const other of this.schedule.byId.values()) {
        if (other.id === task.id || other.costItemId !== task.costItemId) continue;
        other.costValueId = task.costValueId;
      }
    }
  }

  exportBytes(): Uint8Array {
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    const newLines: string[] = [];
    const taskIds = new Set([...this.identityEdited, ...this.timeEdited, ...this.costEdited]);

    for (const taskId of taskIds) {
      const task = this.schedule.byId.get(taskId);
      if (!task) continue;

      if (this.identityEdited.has(taskId)) {
        const taskEnt = findEntity(this.originalText, task.id);
        if (!taskEnt) {
          throw new Error(`Não foi possível localizar IfcTask #${task.id} no IFC.`);
        }
        replacements.push({
          start: taskEnt.start,
          end: taskEnt.end,
          text: rewriteIfcTask(taskEnt, task),
        });
      }

      if (this.timeEdited.has(taskId) && task.start && task.end && task.taskTimeId != null) {
        if (this.createdTaskTimeIds.has(task.taskTimeId)) {
          newLines.push(serializeNewTaskTime(task.taskTimeId, task.start, task.end));
        } else {
          const timeEnt = findEntity(this.originalText, task.taskTimeId);
          if (!timeEnt) {
            throw new Error(`Não foi possível localizar IfcTaskTime #${task.taskTimeId} no IFC.`);
          }
          replacements.push({
            start: timeEnt.start,
            end: timeEnt.end,
            text: rewriteIfcTaskTime(timeEnt, task.start, task.end),
          });
        }
      }

      if (!this.costEdited.has(taskId) || task.cost == null || task.costValueId == null) continue;
      const amount = task.cost;

      if (this.createdCostValueIds.has(task.costValueId)) {
        newLines.push(
          serializeNewCostValue(task.costValueId, amount, task, this.createdStarCostValueIds.has(task.costValueId)),
        );
      } else {
        const valueEnt = findEntity(this.originalText, task.costValueId);
        if (!valueEnt) {
          throw new Error(`Não foi possível localizar IfcCostValue #${task.costValueId} no IFC.`);
        }
        replacements.push({
          start: valueEnt.start,
          end: valueEnt.end,
          text: rewriteIfcCostValue(valueEnt, amount),
        });
      }

      if (task.costItemId != null && this.createdCostItemIds.has(task.costItemId)) {
        newLines.push(serializeNewCostItem(task.costItemId, task.costValueId, task));
      } else if (
        task.costItemId != null &&
        this.costItemNeedsValueLink.has(task.costItemId) &&
        this.createdCostValueIds.has(task.costValueId)
      ) {
        const itemEnt = findEntity(this.originalText, task.costItemId);
        if (!itemEnt) {
          throw new Error(`Não foi possível localizar IfcCostItem #${task.costItemId} no IFC.`);
        }
        replacements.push({
          start: itemEnt.start,
          end: itemEnt.end,
          text: rewriteIfcCostItemValues(itemEnt, task.costValueId),
        });
      }

      const rels = this.createdCostRels.get(taskId);
      if (rels && task.costItemId != null) {
        newLines.push(serializeNewAssignToControl(rels.assignRelId, task.id, task.costItemId));
        if (rels.scheduleRelId != null && this.schedule.costScheduleId != null) {
          newLines.push(
            serializeNewAssignToControl(rels.scheduleRelId, task.costItemId, this.schedule.costScheduleId),
          );
        }
      }
    }

    const patched = applyReplacements(this.originalText, replacements);
    const withTasks = insertBeforeLastEndsec(patched, newLines);
    const georef = this.schedule.georef;
    const spatial =
      georef && (this.geoChanged || !extraIsIdentity(this.extra))
        ? patchIfcGeoref(
            withTasks,
            this.nextExpressId,
            georef,
            this.extra,
            this.geoWrite,
            this.geoChanged,
          )
        : null;
    if (spatial) this.nextExpressId = spatial.nextExpressId;
    return latin1ToBytes(spatial?.text ?? withTasks);
  }

  download(fileName = this.fileName): void {
    const bytes = this.exportBytes();
    const blob = new Blob([bytes as BlobPart], { type: "application/x-step" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.endsWith(".ifc") ? fileName : `${fileName}.ifc`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

function rewriteIfcTask(ent: StepEntity, task: Task): string {
  const args = [...ent.args];
  if (args.length < 13) {
    throw new Error(`IfcTask #${task.id} tem ${args.length} atributos; esperado ≥ 13 (IFC4).`);
  }
  args[2] = ifcOptionalString(task.name);
  args[5] = ifcOptionalString(task.identification);
  if (task.taskTimeId != null) args[11] = `#${task.taskTimeId}`;
  return serializeEntity(ent.expressId, ent.type, args);
}

function rewriteIfcTaskTime(ent: StepEntity, start: Date, end: Date): string {
  const args = [...ent.args];
  if (args.length < 7) {
    throw new Error(`IfcTaskTime #${ent.expressId} tem ${args.length} atributos; esperado ≥ 7.`);
  }
  const days = inclusiveCalendarDays(start, end);
  if (args[3] === "$") args[3] = ".WORKTIME.";
  args[4] = ifcString(`P${days}D`);
  args[5] = ifcString(formatIfcDateTime(start));
  args[6] = ifcString(formatIfcDateTime(end));
  return serializeEntity(ent.expressId, ent.type, args);
}

function serializeNewTaskTime(expressId: number, start: Date, end: Date): string {
  const days = inclusiveCalendarDays(start, end);
  const args = [
    "$",
    "$",
    "$",
    ".WORKTIME.",
    ifcString(`P${days}D`),
    ifcString(formatIfcDateTime(start)),
    ifcString(formatIfcDateTime(end)),
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
    "$",
    "$",
    "$",
  ];
  return serializeEntity(expressId, "IFCTASKTIME", args);
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function rewriteIfcCostValue(ent: StepEntity, amount: number): string {
  const args = [...ent.args];
  if (args.length < 3) {
    throw new Error(`IfcCostValue #${ent.expressId} tem ${args.length} atributos; esperado ≥ 3.`);
  }
  args[2] = formatMonetaryMeasure(amount);
  return serializeEntity(ent.expressId, ent.type, args);
}

function rewriteIfcCostItemValues(ent: StepEntity, valueId: number): string {
  const args = [...ent.args];
  while (args.length < 9) args.push("$");
  const cur = args[7] ?? "$";
  if (cur === "$") {
    args[7] = `(#${valueId})`;
  } else if (cur.startsWith("(") && cur.endsWith(")")) {
    const inner = cur.slice(1, -1).trim();
    args[7] = inner ? `(${inner},#${valueId})` : `(#${valueId})`;
  } else {
    args[7] = `(#${valueId})`;
  }
  return serializeEntity(ent.expressId, ent.type, args);
}

function serializeNewCostValue(expressId: number, amount: number, task: Task, categoryStar: boolean): string {
  const args = [
    ifcOptionalString(task.name),
    "$",
    formatMonetaryMeasure(amount),
    "$",
    "$",
    "$",
    "$",
    categoryStar ? ifcString("*") : "$",
    "$",
    "$",
  ];
  return serializeEntity(expressId, "IFCCOSTVALUE", args);
}

function serializeNewCostItem(expressId: number, valueId: number, task: Task): string {
  const args = [
    ifcString(createIfcGuid()),
    "$",
    ifcOptionalString(task.name),
    "$",
    "$",
    ifcOptionalString(task.identification),
    "$",
    `(#${valueId})`,
    "$",
  ];
  return serializeEntity(expressId, "IFCCOSTITEM", args);
}

function serializeNewAssignToControl(expressId: number, relatedId: number, relatingControlId: number): string {
  const args = [
    ifcString(createIfcGuid()),
    "$",
    "$",
    "$",
    `(#${relatedId})`,
    "$",
    `#${relatingControlId}`,
  ];
  return serializeEntity(expressId, "IFCRELASSIGNSTOCONTROL", args);
}
