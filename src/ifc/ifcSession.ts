import type { ScheduleData, SelectionGroup, Task } from "../schedule/types";
import { VISTA4D_SET_TYPE } from "../schedule/types";
import { inclusiveCalendarDays, ownAndGroupGuids, recomputeProductGuidsByTask, recomputeScheduleRange } from "../schedule/range";
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
  findExpressIdByGlobalId,
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
 * (IfcTask / IfcTaskTime / IfcCostItem / IfcCostValue / IfcGroup /
 * IfcRelAssignsToGroup / IfcRelAssignsToProduct / IfcSite)
 * na exportação — o resto do ficheiro fica intacto.
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
  /** key = `${taskId}:${productId}` */
  private readonly createdProductRels = new Map<string, { relId: number; taskId: number; productId: number }>();
  private readonly removedExistingAssignRels = new Map<number, { taskId: number; productId: number }>();
  private readonly createdGroupIds = new Set<number>();
  private readonly createdGroupAssignRel = new Map<number, number>();
  private readonly createdGroupTaskRels = new Map<string, { relId: number; taskId: number; groupId: number }>();
  private readonly renamedGroupIds = new Set<number>();
  private readonly dirtyGroupMemberIds = new Set<number>();
  private readonly deletedGroupIds = new Set<number>();
  private readonly removedGroupTaskRels = new Map<number, { taskId: number; groupId: number }>();
  private extra = emptyExtraTransform();
  private geoWrite: GeoAnchorWrite | null = null;
  private geoChanged = false;
  dirty = false;

  constructor(buffer: Uint8Array, fileName: string, schedule: ScheduleData) {
    this.originalText = bytesToLatin1(buffer);
    this.fileName = fileName;
    this.schedule = schedule;
    this.nextExpressId = maxExpressId(this.originalText) + 1;
    if (!this.schedule.groups) this.schedule.groups = [];
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
    if (this.schedule.georef) {
      this.schedule.georef.lat = geo.lat;
      this.schedule.georef.lon = geo.lon;
      this.schedule.georef.elevation = geo.elevation;
    }
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

  /**
   * Liga ou desliga um IfcProduct à IfcTask (IfcRelAssignsToProduct no formato Bonsai 4D).
   * Clique repetido no mesmo elemento remove a associação.
   */
  assignProductToTask(
    taskId: number,
    guid: string,
    expressIdHint?: number,
  ): { added: boolean; guids: string[] } {
    const task = this.schedule.byId.get(taskId);
    if (!task) throw new Error(`Tarefa #${taskId} não encontrada.`);
    const productId = this.resolveProductId(guid, expressIdHint);
    const already = task.productGuids.includes(guid) || task.productIds.includes(productId);
    if (already) this.removeProductLink(task, guid, productId);
    else this.addProductLink(task, guid, productId);
    recomputeProductGuidsByTask(this.schedule);
    this.dirty = true;
    return {
      added: !already,
      guids: this.schedule.productGuidsByTask.get(taskId) ?? [...task.productGuids],
    };
  }

  createGroup(
    name: string,
    members: Array<{ guid: string; expressId?: number }>,
  ): SelectionGroup {
    const trimmed = name.trim() || "Conjunto";
    const groupId = this.nextExpressId++;
    const productIds: number[] = [];
    const productGuids: string[] = [];
    for (const m of members) {
      const pid = this.resolveProductId(m.guid, m.expressId);
      if (productIds.includes(pid)) continue;
      productIds.push(pid);
      productGuids.push(m.guid);
    }
    const assignRelId = productIds.length ? this.nextExpressId++ : undefined;
    const group: SelectionGroup = {
      id: groupId,
      globalId: createIfcGuid(),
      name: trimmed,
      objectType: VISTA4D_SET_TYPE,
      productIds,
      productGuids,
      taskIds: [],
      assignRelId,
    };
    this.schedule.groups.push(group);
    this.createdGroupIds.add(groupId);
    if (assignRelId != null) this.createdGroupAssignRel.set(groupId, assignRelId);
    this.dirty = true;
    return group;
  }

  renameGroup(groupId: number, name: string): SelectionGroup {
    const group = this.requireGroup(groupId);
    const next = name.trim();
    if (!next) throw new Error("O conjunto precisa de um nome.");
    group.name = next;
    if (!this.createdGroupIds.has(groupId)) this.renamedGroupIds.add(groupId);
    this.dirty = true;
    return group;
  }

  setGroupMembers(groupId: number, members: Array<{ guid: string; expressId?: number }>): SelectionGroup {
    const group = this.requireGroup(groupId);
    const nextIds: number[] = [];
    const nextGuids: string[] = [];
    for (const m of members) {
      const pid = this.resolveProductId(m.guid, m.expressId);
      if (nextIds.includes(pid)) continue;
      nextIds.push(pid);
      nextGuids.push(m.guid);
    }
    const removed: Array<{ id: number; guid: string }> = [];
    for (let i = 0; i < group.productIds.length; i++) {
      if (!nextIds.includes(group.productIds[i])) {
        removed.push({ id: group.productIds[i], guid: group.productGuids[i] });
      }
    }
    const added: Array<{ id: number; guid: string }> = [];
    for (let i = 0; i < nextIds.length; i++) {
      if (!group.productIds.includes(nextIds[i])) {
        added.push({ id: nextIds[i], guid: nextGuids[i] });
      }
    }
    group.productIds = nextIds;
    group.productGuids = nextGuids;
    if (this.createdGroupIds.has(groupId)) {
      if (nextIds.length && !this.createdGroupAssignRel.has(groupId)) {
        const relId = this.nextExpressId++;
        group.assignRelId = relId;
        this.createdGroupAssignRel.set(groupId, relId);
      }
    } else {
      this.dirtyGroupMemberIds.add(groupId);
    }
    for (const taskId of group.taskIds) {
      const task = this.schedule.byId.get(taskId);
      if (!task) continue;
      for (const p of added) this.addProductLink(task, p.guid, p.id);
      for (const p of removed) this.removeProductLink(task, p.guid, p.id);
    }
    recomputeProductGuidsByTask(this.schedule);
    this.dirty = true;
    return group;
  }

  deleteGroup(groupId: number): void {
    const group = this.requireGroup(groupId);
    for (const taskId of [...group.taskIds]) {
      this.assignGroupToTask(taskId, groupId);
    }
    this.schedule.groups = this.schedule.groups.filter((g) => g.id !== groupId);
    if (this.createdGroupIds.has(groupId)) {
      this.createdGroupIds.delete(groupId);
      this.createdGroupAssignRel.delete(groupId);
    } else {
      this.deletedGroupIds.add(groupId);
    }
    this.renamedGroupIds.delete(groupId);
    this.dirtyGroupMemberIds.delete(groupId);
    recomputeProductGuidsByTask(this.schedule);
    this.dirty = true;
  }

  assignGroupToTask(taskId: number, groupId: number): { added: boolean; guids: string[] } {
    const task = this.schedule.byId.get(taskId);
    if (!task) throw new Error(`Tarefa #${taskId} não encontrada.`);
    const group = this.requireGroup(groupId);
    const key = `${taskId}:${groupId}`;
    const already = (task.groupIds ??= []).includes(groupId);

    if (already) {
      task.groupIds = task.groupIds.filter((id) => id !== groupId);
      group.taskIds = group.taskIds.filter((id) => id !== taskId);
      for (let i = 0; i < group.productIds.length; i++) {
        this.removeProductLink(task, group.productGuids[i], group.productIds[i]);
      }
      if (this.createdGroupTaskRels.has(key)) this.createdGroupTaskRels.delete(key);
      else {
        const ent = findGroupTaskRel(this.originalText, taskId, groupId);
        if (ent) this.removedGroupTaskRels.set(ent.expressId, { taskId, groupId });
      }
    } else {
      task.groupIds.push(groupId);
      if (!group.taskIds.includes(taskId)) group.taskIds.push(taskId);
      for (let i = 0; i < group.productIds.length; i++) {
        this.addProductLink(task, group.productGuids[i], group.productIds[i]);
      }
      const pending = [...this.removedGroupTaskRels.entries()].find(
        ([, v]) => v.taskId === taskId && v.groupId === groupId,
      );
      if (pending) this.removedGroupTaskRels.delete(pending[0]);
      else {
        this.createdGroupTaskRels.set(key, { relId: this.nextExpressId++, taskId, groupId });
      }
    }

    recomputeProductGuidsByTask(this.schedule);
    this.dirty = true;
    return {
      added: !already,
      guids: this.schedule.productGuidsByTask.get(taskId) ?? ownAndGroupGuids(this.schedule, task),
    };
  }

  private requireGroup(groupId: number): SelectionGroup {
    const group = this.schedule.groups.find((g) => g.id === groupId);
    if (!group || this.deletedGroupIds.has(groupId)) {
      throw new Error(`Conjunto #${groupId} não encontrado.`);
    }
    return group;
  }

  private resolveProductId(guid: string, expressIdHint?: number): number {
    const productId =
      findExpressIdByGlobalId(this.originalText, guid) ??
      (expressIdHint != null && findEntity(this.originalText, expressIdHint) ? expressIdHint : undefined);
    if (productId == null) {
      throw new Error("Este elemento não tem GlobalId no IFC — não dá para associar nativamente.");
    }
    return productId;
  }

  private addProductLink(task: Task, guid: string, productId: number): void {
    if (task.productGuids.includes(guid) || task.productIds.includes(productId)) return;
    task.productGuids.push(guid);
    task.productIds.push(productId);
    const key = `${task.id}:${productId}`;
    const pendingRemove = [...this.removedExistingAssignRels.entries()].find(
      ([, v]) => v.taskId === task.id && v.productId === productId,
    );
    if (pendingRemove) this.removedExistingAssignRels.delete(pendingRemove[0]);
    else if (!this.createdProductRels.has(key)) {
      this.createdProductRels.set(key, { relId: this.nextExpressId++, taskId: task.id, productId });
    }
  }

  private removeProductLink(task: Task, guid: string, productId: number): void {
    const gi = task.productGuids.indexOf(guid);
    if (gi >= 0) task.productGuids.splice(gi, 1);
    const pi = task.productIds.indexOf(productId);
    if (pi >= 0) task.productIds.splice(pi, 1);
    const key = `${task.id}:${productId}`;
    if (this.createdProductRels.has(key)) this.createdProductRels.delete(key);
    else {
      const ent = findProductTaskRel(this.originalText, task.id, productId);
      if (ent) this.removedExistingAssignRels.set(ent.expressId, { taskId: task.id, productId });
    }
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

    for (const { relId, taskId, productId } of this.createdProductRels.values()) {
      newLines.push(serializeNewAssignToProduct(relId, taskId, productId));
    }
    for (const [relId, { taskId, productId }] of this.removedExistingAssignRels) {
      const ent = findEntity(this.originalText, relId);
      if (!ent) continue;
      replacements.push({
        start: ent.start,
        end: ent.end,
        text: rewriteAssignRelWithout(ent, taskId, productId),
      });
    }

    for (const group of this.schedule.groups) {
      if (this.deletedGroupIds.has(group.id)) continue;
      if (this.createdGroupIds.has(group.id)) {
        newLines.push(serializeNewIfcGroup(group));
        const assignRelId = this.createdGroupAssignRel.get(group.id) ?? group.assignRelId;
        if (assignRelId != null && group.productIds.length) {
          newLines.push(serializeNewAssignToGroup(assignRelId, group));
        }
      } else {
        if (this.renamedGroupIds.has(group.id)) {
          const ent = findEntity(this.originalText, group.id);
          if (ent) {
            replacements.push({
              start: ent.start,
              end: ent.end,
              text: rewriteIfcGroup(ent, group),
            });
          }
        }
        if (this.dirtyGroupMemberIds.has(group.id)) {
          const relId = group.assignRelId;
          if (relId != null) {
            const ent = findEntity(this.originalText, relId);
            if (ent) {
              replacements.push({
                start: ent.start,
                end: ent.end,
                text: rewriteAssignToGroupMembers(ent, group),
              });
            }
          } else {
            const assignRelId = this.nextExpressId++;
            group.assignRelId = assignRelId;
            newLines.push(serializeNewAssignToGroup(assignRelId, group));
          }
        }
      }
    }
    for (const groupId of this.deletedGroupIds) {
      const groupEnt = findEntity(this.originalText, groupId);
      if (groupEnt) {
        replacements.push({
          start: groupEnt.start,
          end: groupEnt.end,
          text: `/* deleted #${groupId} IFCGROUP */`,
        });
      }
      const assignEnt = findGroupAssignRel(this.originalText, groupId);
      if (assignEnt) {
        replacements.push({
          start: assignEnt.start,
          end: assignEnt.end,
          text: `/* deleted #${assignEnt.expressId} IFCRELASSIGNSTOGROUP */`,
        });
      }
    }
    for (const { relId, taskId, groupId } of this.createdGroupTaskRels.values()) {
      newLines.push(serializeNewAssignToProcess(relId, taskId, groupId));
    }
    for (const [relId, { taskId, groupId }] of this.removedGroupTaskRels) {
      const ent = findEntity(this.originalText, relId);
      if (!ent) continue;
      replacements.push({
        start: ent.start,
        end: ent.end,
        text: rewriteAssignRelWithout(ent, taskId, groupId),
      });
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
    this.dirty = false;
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

/** Bonsai 4D: RelatingProduct = elemento 3D, RelatedObjects = IfcTask. */
function serializeNewAssignToProduct(expressId: number, taskId: number, productId: number): string {
  const args = [
    ifcString(createIfcGuid()),
    "$",
    "$",
    "$",
    `(#${taskId})`,
    "$",
    `#${productId}`,
  ];
  return serializeEntity(expressId, "IFCRELASSIGNSTOPRODUCT", args);
}

function serializeNewIfcGroup(group: SelectionGroup): string {
  const args = [
    ifcString(group.globalId),
    "$",
    ifcOptionalString(group.name),
    ifcString("Selection set 4D"),
    ifcString(group.objectType || VISTA4D_SET_TYPE),
  ];
  return serializeEntity(group.id, "IFCGROUP", args);
}

function serializeNewAssignToGroup(expressId: number, group: SelectionGroup): string {
  const ids = group.productIds;
  if (ids.length === 0) return `/* empty group #${group.id} */`;
  const args = [
    ifcString(createIfcGuid()),
    "$",
    ifcOptionalString(group.name),
    "$",
    `(${ids.map((id) => `#${id}`).join(",")})`,
    "$",
    `#${group.id}`,
  ];
  return serializeEntity(expressId, "IFCRELASSIGNSTOGROUP", args);
}

function serializeNewAssignToProcess(expressId: number, taskId: number, relatedId: number): string {
  const args = [
    ifcString(createIfcGuid()),
    "$",
    ifcString("4D set"),
    "$",
    `(#${relatedId})`,
    "$",
    `#${taskId}`,
  ];
  return serializeEntity(expressId, "IFCRELASSIGNSTOPROCESS", args);
}

function rewriteIfcGroup(ent: StepEntity, group: SelectionGroup): string {
  const args = [...ent.args];
  while (args.length < 5) args.push("$");
  args[2] = ifcOptionalString(group.name);
  args[4] = ifcString(group.objectType || VISTA4D_SET_TYPE);
  return serializeEntity(ent.expressId, ent.type, args);
}

function rewriteAssignToGroupMembers(ent: StepEntity, group: SelectionGroup): string {
  if (group.productIds.length === 0) {
    return `/* empty #${ent.expressId} IFCRELASSIGNSTOGROUP */`;
  }
  const args = [...ent.args];
  while (args.length < 7) args.push("$");
  args[4] = `(${group.productIds.map((id) => `#${id}`).join(",")})`;
  args[6] = `#${group.id}`;
  return serializeEntity(ent.expressId, ent.type, args);
}

function findGroupAssignRel(text: string, groupId: number): StepEntity | null {
  const re = /#(\d+)\s*=\s*IFCRELASSIGNSTOGROUP\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ent = findEntity(text, Number(m[1]));
    if (!ent || ent.args.length < 7) continue;
    if (ent.args[6] === `#${groupId}`) return ent;
  }
  return null;
}

function findGroupTaskRel(text: string, taskId: number, groupId: number): StepEntity | null {
  const re = /#(\d+)\s*=\s*IFCRELASSIGNSTOPROCESS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ent = findEntity(text, Number(m[1]));
    if (!ent || ent.args.length < 7) continue;
    if (ent.args[6] === `#${taskId}` && relatedIncludes(ent.args[4] ?? "", groupId)) return ent;
  }
  return null;
}

function findProductTaskRel(text: string, taskId: number, productId: number): StepEntity | null {
  const re = /#(\d+)\s*=\s*IFCRELASSIGNS(?:TOPRODUCT|TOPROCESS)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ent = findEntity(text, Number(m[1]));
    if (!ent || ent.args.length < 7) continue;
    const related = ent.args[4] ?? "";
    const relating = ent.args[6] ?? "";
    const type = ent.type.toUpperCase();
    if (type === "IFCRELASSIGNSTOPRODUCT") {
      if (relating === `#${productId}` && relatedIncludes(related, taskId)) return ent;
    } else if (type === "IFCRELASSIGNSTOPROCESS") {
      if (relating === `#${taskId}` && relatedIncludes(related, productId)) return ent;
    }
  }
  return null;
}

function relatedIncludes(setArg: string, id: number): boolean {
  return new RegExp(`#${id}(?!\\d)`).test(setArg);
}

function stripRefFromSet(setArg: string, id: number): string {
  if (!setArg || setArg === "$") return "()";
  const inner = setArg.replace(/^\(/, "").replace(/\)$/, "");
  const parts = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== `#${id}`);
  return parts.length ? `(${parts.join(",")})` : "()";
}

function rewriteAssignRelWithout(ent: StepEntity, taskId: number, productId: number): string {
  const args = [...ent.args];
  const type = ent.type.toUpperCase();
  if (type === "IFCRELASSIGNSTOPRODUCT") args[4] = stripRefFromSet(args[4] ?? "()", taskId);
  else args[4] = stripRefFromSet(args[4] ?? "()", productId);
  const related = args[4] ?? "()";
  if (related === "()" || related === "$") {
    return `/* unlinked #${ent.expressId} ${ent.type} */`;
  }
  return serializeEntity(ent.expressId, ent.type, args);
}
