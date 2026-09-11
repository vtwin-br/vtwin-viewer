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
  commentEntity,
  createIfcGuid,
  detectIfcSchema,
  findEntity,
  findExpressIdByGlobalId,
  findFirstExpressIdByType,
  formatIfcDateTime,
  formatMonetaryMeasure,
  ifcOptionalString,
  ifcString,
  insertBeforeLastEndsec,
  latin1ToBytes,
  maxExpressId,
  serializeEntity,
  stepSet,
  type IfcSchemaKind,
  type StepEntity,
} from "./stepText";
import {
  findSequenceEntities,
  rewriteRelatedObjects,
  rewriteRelNests,
  rewriteWorkControlName,
  serializeIfcCalendarDate,
  serializeIfcDateAndTime,
  serializeIfcLocalTime,
  serializeIfcScheduleTimeControl,
  serializeNewIfcTask,
  serializeNewWorkPlan,
  serializeNewWorkSchedule,
  serializeRelAggregates,
  serializeRelAssignsTasks,
  serializeRelDeclares,
  serializeRelNests,
  serializeRelSequence,
  sequenceInvolves,
  type NewTaskInput,
  type OutlineRowInput,
  type SequenceType,
} from "./scheduleWrite";

export type { NewTaskInput, OutlineRowInput, SequenceType };

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
 * (IfcTask / IfcTaskTime / IfcWorkSchedule / IfcRelNests / IfcRelSequence /
 * IfcCostItem / IfcCostValue / IfcGroup / IfcRelAssignsToGroup /
 * IfcRelAssignsToProduct / IfcSite)
 * na exportação — o resto do ficheiro fica intacto.
 */
export class IfcSession {
  readonly fileName: string;
  readonly schedule: ScheduleData;
  private readonly originalText: string;
  /** Preenchido na primeira alocação — evita varrer o STEP inteiro só para abrir. */
  private nextExpressId: number | undefined;
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
  private readonly createdTaskIds = new Set<number>();
  private readonly deletedTaskIds = new Set<number>();
  private readonly deletedEntityIds = new Set<number>();
  private readonly createdNestsRelIds = new Set<number>();
  private readonly dirtyNestsParentIds = new Set<number>();
  private readonly createdSequenceRels: Array<{
    relId: number;
    predId: number;
    succId: number;
    type: SequenceType;
  }> = [];
  private createdWorkPlan = false;
  private createdWorkSchedule = false;
  private createdDeclaresRelId: number | undefined;
  private createdAggregatesRel = false;
  private createdScheduleControlRel = false;
  private dirtyScheduleControl = false;
  private renamedSchedule = false;
  private readonly schema: IfcSchemaKind;
  private readonly ownerHistoryRef: string;
  private workControlDateId?: number;
  private localTimeId?: number;
  private readonly dateTimeByDay = new Map<string, number>();
  private readonly createdDateLines: string[] = [];
  private readonly ifc2x3Times = new Map<
    number,
    { stcId: number; relId: number; startRef: number; endRef: number }
  >();
  private extra = emptyExtraTransform();
  private geoWrite: GeoAnchorWrite | null = null;
  private geoChanged = false;
  dirty = false;

  constructor(source: Uint8Array | string, fileName: string, schedule: ScheduleData) {
    this.originalText = typeof source === "string" ? source : bytesToLatin1(source);
    this.fileName = fileName;
    this.schedule = schedule;
    if (!this.schedule.groups) this.schedule.groups = [];
    this.schema = detectIfcSchema(this.originalText);
    const oh = findFirstExpressIdByType(this.originalText, "IFCOWNERHISTORY");
    this.ownerHistoryRef = oh != null ? `#${oh}` : "$";
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

    if (time && this.schema === "IFC2X3" && task.start && task.end) {
      this.attachIfc2x3Time(task);
    } else if (time && task.start && task.end && task.taskTimeId == null) {
      task.taskTimeId = this.allocId();
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

  renameWorkSchedule(name: string): void {
    const next = name.trim();
    if (!next) return;
    this.ensureWorkSchedule(next);
    if (this.schedule.name === next) return;
    this.schedule.name = next;
    this.renamedSchedule = true;
    this.dirty = true;
  }

  /**
   * Garante IfcWorkPlan + IfcWorkSchedule + relações ao IfcProject.
   * Sem isto não há onde aninhar IfcTask.
   */
  ensureWorkSchedule(name = "Cronograma"): { created: boolean } {
    if (this.schedule.workScheduleId != null) {
      return { created: false };
    }
    const projectId =
      this.schedule.projectId ?? findFirstExpressIdByType(this.originalText, "IFCPROJECT");
    if (projectId == null) {
      throw new Error("Este IFC não tem IfcProject — não dá para gravar um cronograma nativo.");
    }
    this.schedule.projectId = projectId;
    const label = name.trim() || "Cronograma";
    if (this.schedule.workPlanId == null) {
      this.schedule.workPlanId = this.allocId();
      this.createdWorkPlan = true;
      this.schedule.workPlanName = label;
    }
    this.schedule.workScheduleId = this.allocId();
    this.createdWorkSchedule = true;
    this.schedule.name =
      this.schedule.name === "—" || this.schedule.name === "Cronograma" ? label : this.schedule.name || label;
    if (this.schema === "IFC2X3") {
      this.workControlDateId = this.ensureDateTime(new Date());
    } else {
      this.createdDeclaresRelId = this.allocId();
    }
    if (this.schedule.aggregatesRelId == null && this.schedule.workPlanId != null) {
      this.schedule.aggregatesRelId = this.allocId();
      this.createdAggregatesRel = true;
    }
    this.dirty = true;
    return { created: true };
  }

  createTask(input: NewTaskInput): Task {
    this.ensureWorkSchedule(input.name);
    const id = this.allocId();
    const start = input.start;
    const end = input.end;
    let taskTimeId: number | undefined;
    if (start && end) {
      if (this.schema !== "IFC2X3") {
        taskTimeId = this.allocId();
        this.createdTaskTimeIds.add(taskTimeId);
        this.timeEdited.add(id);
      }
    }
    const task: Task = {
      id,
      globalId: createIfcGuid(),
      name: input.name.trim() || "Nova tarefa",
      identification: input.identification?.trim() || undefined,
      start,
      end,
      taskTimeId,
      isMilestone: input.isMilestone,
      parentId: input.parentId,
      children: [],
      productIds: [],
      productGuids: [],
      groupIds: [],
      predecessors: [],
    };
    this.schedule.byId.set(id, task);
    this.createdTaskIds.add(id);
    this.identityEdited.add(id);
    if (this.schema === "IFC2X3" && start && end) this.attachIfc2x3Time(task);

    const parent = input.parentId != null ? this.schedule.byId.get(input.parentId) : undefined;
    if (input.parentId != null && !parent) {
      throw new Error(`Tarefa pai #${input.parentId} não encontrada.`);
    }
    if (parent) {
      task.parentId = parent.id;
      insertSibling(parent.children, task, input.afterId);
      this.touchNests(parent);
    } else {
      task.parentId = undefined;
      insertSibling(this.schedule.roots, task, input.afterId);
      this.touchScheduleControl();
    }
    recomputeScheduleRange(this.schedule);
    recomputeProductGuidsByTask(this.schedule);
    this.dirty = true;
    return task;
  }

  deleteTask(taskId: number): void {
    const task = this.schedule.byId.get(taskId);
    if (!task) return;
    for (const child of [...task.children]) this.deleteTask(child.id);

    for (const gid of [...(task.groupIds ?? [])]) {
      this.assignGroupToTask(taskId, gid);
    }
    for (let i = task.productIds.length - 1; i >= 0; i--) {
      this.removeProductLink(task, task.productGuids[i], task.productIds[i]);
    }

    if (task.parentId != null) {
      const parent = this.schedule.byId.get(task.parentId);
      if (parent) {
        parent.children = parent.children.filter((c) => c.id !== taskId);
        this.touchNests(parent);
      }
    } else {
      this.schedule.roots = this.schedule.roots.filter((t) => t.id !== taskId);
      this.touchScheduleControl();
    }

    this.dropSequencesInvolving(taskId);
    this.schedule.byId.delete(taskId);
    this.identityEdited.delete(taskId);
    this.timeEdited.delete(taskId);
    this.costEdited.delete(taskId);

    if (this.createdTaskIds.has(taskId)) {
      this.createdTaskIds.delete(taskId);
      if (task.taskTimeId != null) this.createdTaskTimeIds.delete(task.taskTimeId);
      if (task.nestsRelId != null) this.createdNestsRelIds.delete(task.nestsRelId);
    } else {
      this.deletedTaskIds.add(taskId);
      if (task.taskTimeId != null) this.deletedEntityIds.add(task.taskTimeId);
      if (task.nestsRelId != null) {
        if (this.createdNestsRelIds.has(task.nestsRelId)) this.createdNestsRelIds.delete(task.nestsRelId);
        else this.deletedEntityIds.add(task.nestsRelId);
      }
    }
    recomputeScheduleRange(this.schedule);
    recomputeProductGuidsByTask(this.schedule);
    this.dirty = true;
  }

  /**
   * Move a tarefa na árvore IfcRelNests. Os filhos da tarefa acompanham o pai.
   * `parentId` indefinido coloca a tarefa na raiz do IfcWorkSchedule.
   */
  reparentTask(taskId: number, parentId: number | undefined, afterId?: number): void {
    const task = this.schedule.byId.get(taskId);
    if (!task) throw new Error(`Tarefa #${taskId} não encontrada.`);
    if (parentId === taskId) return;
    if (parentId != null) {
      const parent = this.schedule.byId.get(parentId);
      if (!parent) throw new Error(`Tarefa pai #${parentId} não encontrada.`);
      if (this.containsTask(task, parentId)) {
        throw new Error("Não é possível aninhar uma tarefa dentro de si própria.");
      }
    }

    const sameParent = (task.parentId ?? null) === (parentId ?? null);
    if (sameParent) {
      const list = parentId != null ? this.schedule.byId.get(parentId)!.children : this.schedule.roots;
      const at = list.indexOf(task);
      const after = afterId != null ? list.findIndex((t) => t.id === afterId) : -1;
      const desired = after >= 0 ? after + 1 : list.length;
      const current = at >= 0 && at < desired ? desired - 1 : desired;
      if (at === current || (at >= 0 && after >= 0 && at === after + 1)) return;
    }

    if (task.parentId != null) {
      const oldParent = this.schedule.byId.get(task.parentId);
      if (oldParent) {
        oldParent.children = oldParent.children.filter((c) => c.id !== taskId);
        this.touchNests(oldParent);
      }
    } else {
      this.schedule.roots = this.schedule.roots.filter((t) => t.id !== taskId);
      this.touchScheduleControl();
    }

    task.parentId = parentId;
    if (parentId != null) {
      const parent = this.schedule.byId.get(parentId)!;
      insertSibling(parent.children, task, afterId);
      this.touchNests(parent);
    } else {
      insertSibling(this.schedule.roots, task, afterId);
      this.touchScheduleControl();
    }
    this.dirty = true;
  }

  private containsTask(root: Task, id: number): boolean {
    if (root.id === id) return true;
    return root.children.some((c) => this.containsTask(c, id));
  }

  /**
   * CSV / XML → IfcTask. Casa por WBS (Identification) ou nome entre irmãos;
   * o que não existir é criado com IfcRelNests / IfcRelAssignsToControl.
   */
  importOutline(rows: OutlineRowInput[], scheduleName?: string): { created: number; updated: number } {
    if (!rows.length) throw new Error("Não há tarefas para gravar no IFC.");
    this.ensureWorkSchedule(scheduleName || rows[0]?.name || "Cronograma");
    if (scheduleName && !this.schedule.roots.length) this.renameWorkSchedule(scheduleName);

    const stack: Array<Task | undefined> = [];
    const idByIndex: number[] = [];
    let created = 0;
    let updated = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const level = Math.max(1, Math.floor(row.outlineLevel) || 1);
      const parent = level <= 1 ? undefined : stack[level - 1];
      const existing = this.findMergeTarget(row, parent);
      let task: Task;
      if (existing) {
        this.applyTaskEdit(existing.id, {
          name: row.name,
          identification: row.identification,
          start: row.start,
          end: row.end,
        });
        task = existing;
        updated += 1;
      } else {
        task = this.createTask({
          name: row.name,
          identification: row.identification,
          start: row.start,
          end: row.end,
          isMilestone: row.isMilestone,
          parentId: parent?.id,
        });
        created += 1;
      }
      idByIndex[i] = task.id;
      stack[level] = task;
      stack.length = level + 1;
    }

    for (let i = 0; i < rows.length; i++) {
      const succId = idByIndex[i];
      if (succId == null) continue;
      for (const pred of rows[i].predecessorIndexes ?? []) {
        const predId = idByIndex[pred.index];
        if (predId == null || predId === succId) continue;
        this.addSequence(predId, succId, pred.type);
      }
    }
    return { created, updated };
  }

  private findMergeTarget(row: OutlineRowInput, parent?: Task): Task | undefined {
    const ident = row.identification?.trim();
    if (ident) {
      for (const t of this.schedule.byId.values()) {
        if (t.identification === ident) return t;
      }
    }
    const name = row.name.trim();
    if (!name) return undefined;
    const siblings = parent ? parent.children : this.schedule.roots;
    return siblings.find((t) => t.name === name);
  }

  private addSequence(predId: number, succId: number, type: SequenceType): void {
    const succ = this.schedule.byId.get(succId);
    const pred = this.schedule.byId.get(predId);
    if (!succ || !pred) return;
    if (succ.predecessors.some((p) => p.taskId === predId)) return;
    succ.predecessors.push({ taskId: predId, type });
    this.createdSequenceRels.push({ relId: this.allocId(), predId, succId, type });
    this.dirty = true;
  }

  private dropSequencesInvolving(taskId: number): void {
    for (const t of this.schedule.byId.values()) {
      t.predecessors = t.predecessors.filter((p) => p.taskId !== taskId);
    }
    for (let i = this.createdSequenceRels.length - 1; i >= 0; i--) {
      const rel = this.createdSequenceRels[i];
      if (rel.predId === taskId || rel.succId === taskId) this.createdSequenceRels.splice(i, 1);
    }
  }

  private touchNests(parent: Task): void {
    if (parent.children.length === 0) {
      if (parent.nestsRelId != null) {
        if (this.createdNestsRelIds.has(parent.nestsRelId)) this.createdNestsRelIds.delete(parent.nestsRelId);
        else this.deletedEntityIds.add(parent.nestsRelId);
        parent.nestsRelId = undefined;
      }
      this.dirtyNestsParentIds.delete(parent.id);
      return;
    }
    if (parent.nestsRelId == null) {
      parent.nestsRelId = this.allocId();
      this.createdNestsRelIds.add(parent.nestsRelId);
    }
    this.dirtyNestsParentIds.add(parent.id);
  }

  private touchScheduleControl(): void {
    if (this.schedule.roots.length === 0) {
      if (this.schedule.scheduleControlRelId != null) {
        if (this.createdScheduleControlRel) this.createdScheduleControlRel = false;
        else this.deletedEntityIds.add(this.schedule.scheduleControlRelId);
        this.schedule.scheduleControlRelId = undefined;
      }
      this.dirtyScheduleControl = false;
      return;
    }
    if (this.schedule.scheduleControlRelId == null) {
      this.schedule.scheduleControlRelId = this.allocId();
      this.createdScheduleControlRel = true;
    } else if (!this.createdScheduleControlRel) {
      this.dirtyScheduleControl = true;
    }
  }

  private attachIfc2x3Time(task: Task): void {
    if (!task.start || !task.end || this.schedule.workScheduleId == null) return;
    const startRef = this.ensureDateTime(task.start);
    const endRef = this.ensureDateTime(task.end);
    const existing = this.ifc2x3Times.get(task.id);
    if (existing) {
      existing.startRef = startRef;
      existing.endRef = endRef;
      return;
    }
    const stcId = this.allocId();
    const relId = this.allocId();
    task.taskTimeId = stcId;
    this.ifc2x3Times.set(task.id, { stcId, relId, startRef, endRef });
  }

  private ensureDateTime(d: Date): number {
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const hit = this.dateTimeByDay.get(key);
    if (hit != null) return hit;
    if (this.localTimeId == null) {
      this.localTimeId = this.allocId();
      this.createdDateLines.push(serializeIfcLocalTime(this.localTimeId));
    }
    const calId = this.allocId();
    const dtId = this.allocId();
    this.createdDateLines.push(serializeIfcCalendarDate(calId, d));
    this.createdDateLines.push(serializeIfcDateAndTime(dtId, calId, this.localTimeId));
    this.dateTimeByDay.set(key, dtId);
    return dtId;
  }

  private allocId(): number {
    if (this.nextExpressId == null) this.nextExpressId = maxExpressId(this.originalText) + 1;
    return this.nextExpressId++;
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
    const groupId = this.allocId();
    const productIds: number[] = [];
    const productGuids: string[] = [];
    for (const m of members) {
      const pid = this.resolveProductId(m.guid, m.expressId);
      if (productIds.includes(pid)) continue;
      productIds.push(pid);
      productGuids.push(m.guid);
    }
    const assignRelId = productIds.length ? this.allocId() : undefined;
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
        const relId = this.allocId();
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
        this.createdGroupTaskRels.set(key, { relId: this.allocId(), taskId, groupId });
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
      this.createdProductRels.set(key, { relId: this.allocId(), taskId: task.id, productId });
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
      task.costValueId = this.allocId();
      this.createdCostValueIds.add(task.costValueId);
      if (task.costItemId != null) {
        this.costItemNeedsValueLink.add(task.costItemId);
        if (task.costIsBreakdown) this.createdStarCostValueIds.add(task.costValueId);
      }
    }
    if (task.costItemId == null) {
      task.costItemId = this.allocId();
      this.createdCostItemIds.add(task.costItemId);
      const assignRelId = this.allocId();
      const scheduleRelId =
        this.schedule.costScheduleId != null ? this.allocId() : undefined;
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
    const now = new Date();
    const oh = this.ownerHistoryRef;

    newLines.push(...this.createdDateLines);

    if (this.createdWorkPlan && this.schedule.workPlanId != null) {
      newLines.push(
        serializeNewWorkPlan(
          this.schedule.workPlanId,
          this.schedule.workPlanName || this.schedule.name,
          now,
          this.schema,
          oh,
          this.workControlDateId,
        ),
      );
    } else if (this.renamedSchedule && this.schedule.workPlanId != null && this.createdWorkPlan === false) {
      /* o título do Gantt grava IfcWorkSchedule, não o WorkPlan */
    }
    if (this.createdWorkSchedule && this.schedule.workScheduleId != null) {
      newLines.push(
        serializeNewWorkSchedule(this.schedule.workScheduleId, this.schedule.name, now, this.schema, oh, this.workControlDateId),
      );
    } else if (this.renamedSchedule && this.schedule.workScheduleId != null) {
      const ent = findEntity(this.originalText, this.schedule.workScheduleId);
      if (ent) {
        replacements.push({
          start: ent.start,
          end: ent.end,
          text: rewriteWorkControlName(ent, this.schedule.name),
        });
      }
    }
    if (this.schema !== "IFC2X3" && this.createdDeclaresRelId != null && this.schedule.projectId != null) {
      const defs = [this.schedule.workScheduleId, this.schedule.workPlanId].filter(
        (id): id is number => id != null,
      );
      newLines.push(serializeRelDeclares(this.createdDeclaresRelId, this.schedule.projectId, defs, oh));
    }
    if (
      this.createdAggregatesRel &&
      this.schedule.aggregatesRelId != null &&
      this.schedule.workPlanId != null &&
      this.schedule.workScheduleId != null
    ) {
      newLines.push(
        serializeRelAggregates(
          this.schedule.aggregatesRelId,
          this.schedule.workPlanId,
          [this.schedule.workScheduleId],
          oh,
        ),
      );
    }

    const taskIds = new Set([...this.identityEdited, ...this.timeEdited, ...this.costEdited]);

    for (const taskId of taskIds) {
      if (this.deletedTaskIds.has(taskId)) continue;
      const task = this.schedule.byId.get(taskId);
      if (!task) continue;

      if (this.createdTaskIds.has(taskId)) {
        newLines.push(serializeNewIfcTask(task, this.schema, oh));
      } else if (this.identityEdited.has(taskId)) {
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

      if (
        this.schema !== "IFC2X3" &&
        this.timeEdited.has(taskId) &&
        task.start &&
        task.end &&
        task.taskTimeId != null
      ) {
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
            const assignRelId = this.allocId();
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

    if (this.schema === "IFC2X3" && this.schedule.workScheduleId != null) {
      for (const [taskId, rec] of this.ifc2x3Times) {
        if (this.deletedTaskIds.has(taskId)) continue;
        const task = this.schedule.byId.get(taskId);
        if (!task) continue;
        newLines.push(
          serializeIfcScheduleTimeControl(rec.stcId, task.name, oh, rec.startRef, rec.endRef),
        );
        newLines.push(
          serializeRelAssignsTasks(rec.relId, task.id, this.schedule.workScheduleId, rec.stcId, oh),
        );
      }
    }

    for (const parentId of this.dirtyNestsParentIds) {
      const parent = this.schedule.byId.get(parentId);
      if (!parent || parent.nestsRelId == null) continue;
      const childIds = parent.children.map((c) => c.id);
      if (this.createdNestsRelIds.has(parent.nestsRelId)) {
        if (childIds.length) newLines.push(serializeRelNests(parent.nestsRelId, parent.id, childIds, oh));
      } else {
        const ent = findEntity(this.originalText, parent.nestsRelId);
        if (ent) {
          replacements.push({
            start: ent.start,
            end: ent.end,
            text: rewriteRelNests(ent, parent.id, childIds),
          });
        }
      }
    }

    if (this.schedule.scheduleControlRelId != null && this.schedule.workScheduleId != null) {
      const rootIds = this.schedule.roots.map((t) => t.id);
      if (this.createdScheduleControlRel) {
        if (rootIds.length) {
          newLines.push(
            serializeAssignToControlSet(
              this.schedule.scheduleControlRelId,
              rootIds,
              this.schedule.workScheduleId,
              oh,
            ),
          );
        }
      } else if (this.dirtyScheduleControl) {
        const ent = findEntity(this.originalText, this.schedule.scheduleControlRelId);
        if (ent) {
          replacements.push({
            start: ent.start,
            end: ent.end,
            text: rewriteRelatedObjects(ent, 4, rootIds),
          });
        }
      }
    }

    for (const rel of this.createdSequenceRels) {
      newLines.push(serializeRelSequence(rel.relId, rel.predId, rel.succId, rel.type));
    }

    const commented = new Set<number>();
    const comment = (id: number, reason?: string) => {
      if (commented.has(id)) return;
      const ent = findEntity(this.originalText, id);
      if (!ent) return;
      commented.add(id);
      replacements.push({ start: ent.start, end: ent.end, text: commentEntity(ent, reason) });
    };
    for (const taskId of this.deletedTaskIds) comment(taskId);
    for (const expressId of this.deletedEntityIds) comment(expressId);
    if (this.deletedTaskIds.size) {
      for (const ent of findSequenceEntities(this.originalText)) {
        if (![...this.deletedTaskIds].some((id) => sequenceInvolves(ent, id))) continue;
        comment(ent.expressId, "unlinked");
      }
    }

    const patched = applyReplacements(this.originalText, replacements);
    const withTasks = insertBeforeLastEndsec(patched, newLines.filter((l) => l.trim()));
    const georef = this.schedule.georef;
    const spatial =
      georef && (this.geoChanged || !extraIsIdentity(this.extra))
        ? patchIfcGeoref(
            withTasks,
            this.nextExpressId ?? maxExpressId(this.originalText) + 1,
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
  if (args.length >= 13) {
    args[2] = ifcOptionalString(task.name);
    args[5] = ifcOptionalString(task.identification);
    if (task.taskTimeId != null) args[11] = `#${task.taskTimeId}`;
    return serializeEntity(ent.expressId, ent.type, args);
  }
  if (args.length >= 10) {
    args[2] = ifcOptionalString(task.name);
    args[5] = ifcString(task.identification?.trim() || `T${task.id}`);
    return serializeEntity(ent.expressId, ent.type, args);
  }
  throw new Error(`IfcTask #${task.id} tem ${args.length} atributos; esperado ≥ 10.`);
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

function serializeNewAssignToControl(
  expressId: number,
  relatedId: number,
  relatingControlId: number,
  ownerHistory = "$",
): string {
  return serializeAssignToControlSet(expressId, [relatedId], relatingControlId, ownerHistory);
}

function serializeAssignToControlSet(
  expressId: number,
  relatedIds: number[],
  relatingControlId: number,
  ownerHistory = "$",
): string {
  const args = [
    ifcString(createIfcGuid()),
    ownerHistory,
    "$",
    "$",
    stepSet(relatedIds),
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

function insertSibling(list: Task[], task: Task, afterId?: number): void {
  const i = afterId != null ? list.findIndex((t) => t.id === afterId) : -1;
  if (i >= 0) list.splice(i + 1, 0, task);
  else list.push(task);
}
