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
  buildStepIndex,
  deserializeStepIndex,
  firstIdOfType,
  idsOfType,
  serializeStepIndex,
  type StepIndex,
  type StepIndexWire,
} from "./stepIndex";
import { loadIfcBytes, saveIfcBytes } from "./stepStore";
import { IfcChangeSet } from "./changeSet";
import { hashIfcBytes } from "./fragCache";
import {
  applyReplacements,
  bytesToLatin1,
  commentEntity,
  createIfcGuid,
  detectIfcSchema,
  findEntity,
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
  serializeIfcLagTime,
  serializeRelNests,
  serializeRelSequence,
  sequenceInvolves,
  rewriteIfcLagTime,
  rewriteRelSequence,
  ifcTimeMeasureDays,
  type NewTaskInput,
  type OutlineRowInput,
  type SequenceType,
} from "./scheduleWrite";
import { wouldCreateIfcCycle } from "../schedule/links";
import { cloneSiteLimit, type SiteLimit } from "../logistics/types";
import { parseSiteLimitFromStep } from "../logistics/parseSiteLimit";
import { serializeSiteLimit } from "../logistics/serializeSiteLimit";

export type { NewTaskInput, OutlineRowInput, SequenceType };

export interface TaskPatch {
  name?: string;
  identification?: string;
  start?: Date;
  end?: Date;
  /** Custo 5D (IfcCostValue.AppliedValue). */
  cost?: number;
  isMilestone?: boolean;
}

export interface SequenceRelRecord {
  relId: number;
  predId: number;
  succId: number;
  type: SequenceType;
  lagDays: number;
  lagTimeId?: number;
}

export interface IfcSessionOptions {
  index?: StepIndex;
  storeHash?: string;
  schema?: IfcSchemaKind;
  wasmPath?: string;
}

export interface IfcSessionExportSnapshot {
  fileName: string;
  schedule: ScheduleData;
  schema: IfcSchemaKind;
  index: StepIndex;
  nextExpressId?: number;
  sets: Record<string, number[]>;
  maps: Record<string, Array<[unknown, unknown]>>;
  createdSequenceRels: SequenceRelRecord[];
  dirtySequenceRels: SequenceRelRecord[];
  createdDateLines: string[];
  flags: Record<string, boolean>;
  ids: Record<string, number | undefined>;
  extra: ModelExtraTransform;
  geoWrite: GeoAnchorWrite | null;
  wasmPath?: string;
}

interface ExportWorkerResult {
  bytes?: ArrayBuffer;
  index?: StepIndexWire;
  error?: string;
}

/**
 * Mantém o IFC original (texto em RAM enquanto visível, bytes em OPFS) e aplica
 * só as linhas alteradas na exportação — o resto do ficheiro fica intacto.
 */
export class IfcSession {
  readonly fileName: string;
  readonly schedule: ScheduleData;
  readonly changeSet = new IfcChangeSet();
  private stepText: string | null;
  private index: StepIndex;
  private storeHash?: string;
  private readonly wasmPath?: string;
  /** Preenchido na primeira alocação — evita varrer o STEP inteiro só para abrir. */
  private nextExpressId: number | undefined;
  private readonly identityEdited = new Set<number>();
  private readonly elementNameEdited = new Map<number, { globalId: string; name: string }>();
  private readonly propertyValueEdited = new Map<number, string | number | boolean | null>();
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
  /** Desassociações descobertas no export; evita carregar STEP durante a edição. */
  private readonly removedProductLinks = new Map<string, { taskId: number; productId: number }>();
  private readonly createdGroupIds = new Set<number>();
  private readonly createdGroupAssignRel = new Map<number, number>();
  private readonly createdGroupTaskRels = new Map<string, { relId: number; taskId: number; groupId: number }>();
  private readonly renamedGroupIds = new Set<number>();
  private readonly dirtyGroupMemberIds = new Set<number>();
  private readonly deletedGroupIds = new Set<number>();
  private readonly removedGroupTaskRels = new Map<number, { taskId: number; groupId: number }>();
  private readonly removedGroupTaskLinks = new Map<string, { taskId: number; groupId: number }>();
  private readonly createdTaskIds = new Set<number>();
  private readonly deletedTaskIds = new Set<number>();
  private readonly deletedEntityIds = new Set<number>();
  private readonly createdNestsRelIds = new Set<number>();
  private readonly dirtyNestsParentIds = new Set<number>();
  private readonly createdSequenceRels: SequenceRelRecord[] = [];
  private readonly dirtySequenceRels = new Map<number, SequenceRelRecord>();
  private readonly createdLagTimeIds = new Set<number>();
  private readonly dirtyLagTimeIds = new Set<number>();
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
  private siteLimitDirty = false;
  private removedSiteLimitCluster: number[] = [];
  dirty = false;

  constructor(source: Uint8Array | string | null, fileName: string, schedule: ScheduleData, opts?: IfcSessionOptions) {
    this.stepText = source == null ? null : typeof source === "string" ? source : bytesToLatin1(source);
    this.fileName = fileName;
    this.schedule = schedule;
    if (!this.schedule.groups) this.schedule.groups = [];
    this.storeHash = opts?.storeHash;
    this.wasmPath = opts?.wasmPath;
    if (!opts?.index && this.stepText == null) {
      throw new Error("Uma sessão IFC lazy precisa de um índice persistido.");
    }
    this.index = opts?.index ?? buildStepIndex(this.stepText!);
    this.schema = opts?.schema ?? (this.stepText != null ? detectIfcSchema(this.stepText) : "IFC4");
    const oh =
      firstIdOfType(this.index, "IFCOWNERHISTORY") ??
      (this.stepText != null
        ? findFirstExpressIdByType(this.stepText, "IFCOWNERHISTORY", this.index)
        : undefined);
    this.ownerHistoryRef = oh != null ? `#${oh}` : "$";
    this.nextExpressId = this.index.maxId > 0 ? this.index.maxId + 1 : undefined;
  }

  private step(): string {
    if (this.stepText == null) {
      throw new Error("O STEP deste modelo não está em memória (disciplina oculta).");
    }
    return this.stepText;
  }

  private find(expressId: number | undefined): StepEntity | null {
    if (expressId == null) return null;
    return findEntity(this.step(), expressId, this.index);
  }

  async ensureText(): Promise<string> {
    if (this.stepText != null) return this.stepText;
    if (!this.storeHash) throw new Error("Não há cópia OPFS do IFC para recarregar o STEP.");
    const bytes = await loadIfcBytes(this.storeHash);
    if (!bytes) throw new Error("Falha a ler o IFC do armazenamento local.");
    this.stepText = bytesToLatin1(bytes);
    if (this.index.offset.size === 0) this.index = buildStepIndex(this.stepText);
    return this.stepText;
  }

  /** Liberta a string STEP; o change set e o índice bastam até ao export. */
  dropText(): void {
    if (!this.storeHash) return;
    this.stepText = null;
  }

  get georef(): IfcGeoref | undefined {
    return this.schedule.georef;
  }

  get ifcSchema(): IfcSchemaKind {
    return this.schema;
  }

  get stepIndex(): StepIndex {
    return this.index;
  }

  get sourceHash(): string | undefined {
    return this.storeHash;
  }

  getExtraTransform(): ModelExtraTransform {
    return { ...this.extra };
  }

  setExtraTransform(extra: ModelExtraTransform): void {
    this.extra = { ...extra };
    if (!extraIsIdentity(extra)) {
      this.changeSet.append({ kind: "georef:transform", value: extra });
      this.dirty = true;
    }
  }

  getSiteLimit(): SiteLimit | null {
    const limit = this.schedule.siteLimit;
    if (!limit?.points.length) return null;
    return cloneSiteLimit(limit);
  }

  async hydrateSiteLimit(): Promise<SiteLimit | null> {
    if (this.schedule.siteLimit?.points.length) return this.getSiteLimit();
    if (!this.index.typeIds.get("IFCANNOTATION")?.length) return null;
    const text = await this.ensureText();
    const parsed = parseSiteLimitFromStep(text, this.index);
    if (parsed) this.schedule.siteLimit = parsed;
    return this.getSiteLimit();
  }

  setSiteLimit(limit: SiteLimit): SiteLimit {
    if (limit.points.length < 3) throw new Error("O limite do canteiro precisa de pelo menos 3 vértices.");
    const prev = this.schedule.siteLimit;
    const next = cloneSiteLimit(limit);
    if (!next.globalId) next.globalId = prev?.globalId || createIfcGuid();
    if (next.annotationId == null) next.annotationId = prev?.annotationId;
    if (!next.clusterIds?.length && prev?.clusterIds?.length) next.clusterIds = [...prev.clusterIds];
    this.schedule.siteLimit = next;
    this.siteLimitDirty = true;
    this.changeSet.append({ kind: "siteLimit:set", value: cloneSiteLimit(next) });
    this.dirty = true;
    return cloneSiteLimit(next);
  }

  clearSiteLimit(): void {
    const prev = this.schedule.siteLimit;
    if (!prev && !this.siteLimitDirty) return;
    if (prev?.clusterIds?.length) this.removedSiteLimitCluster = [...prev.clusterIds];
    this.schedule.siteLimit = undefined;
    this.siteLimitDirty = true;
    this.changeSet.append({ kind: "siteLimit:clear" });
    this.dirty = true;
  }

  setGeoAnchor(geo: GeoAnchorWrite, markDirty = true): void {
    this.geoWrite = { ...geo };
    this.geoChanged = true;
    if (this.schedule.georef) {
      this.schedule.georef.lat = geo.lat;
      this.schedule.georef.lon = geo.lon;
      this.schedule.georef.elevation = geo.elevation;
    }
    if (markDirty) {
      this.changeSet.append({ kind: "georef:anchor", value: geo });
      this.dirty = true;
    }
  }

  /** Edita IfcRoot.Name de um produto sem depender do localId do renderer. */
  setElementName(globalId: string, name: string): void {
    const expressId = this.index.guidToId.get(globalId);
    const next = name.trim();
    if (expressId == null) throw new Error("GlobalId não encontrado no IFC.");
    if (!next) throw new Error("O elemento precisa de um nome.");
    this.elementNameEdited.set(expressId, { globalId, name: next });
    this.changeSet.append({
      kind: "element:rename",
      expressId,
      globalId,
      name: next,
    });
    this.dirty = true;
  }

  /** Edita o NominalValue de um IfcPropertySingleValue existente. */
  setPropertySingleValue(
    propertyId: number,
    value: string | number | boolean | null,
  ): void {
    if (!this.index.offset.has(propertyId)) {
      throw new Error(`Propriedade #${propertyId} não encontrada no IFC.`);
    }
    this.propertyValueEdited.set(propertyId, value);
    this.changeSet.append({ kind: "property:update", propertyId, value });
    this.dirty = true;
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
    if (patch.isMilestone !== undefined && !!task.isMilestone !== !!patch.isMilestone) {
      task.isMilestone = patch.isMilestone;
      identity = true;
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
    if (identity || time || cost) {
      const fields = [
        ...(identity ? ["identity"] : []),
        ...(time ? ["time"] : []),
        ...(cost ? ["cost"] : []),
      ];
      this.changeSet.append({ kind: "task:update", taskId, fields });
      this.dirty = true;
    }
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
    this.changeSet.append({ kind: "schedule:rename", name: next });
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
    const projectId = this.schedule.projectId ?? firstIdOfType(this.index, "IFCPROJECT");
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
    this.changeSet.append({ kind: "task:create", taskId: id });
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
    this.changeSet.append({ kind: "task:delete", taskId });
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
    this.changeSet.append({ kind: "task:reparent", taskId, parentId });
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
        this.linkSequence(predId, succId, pred.type, pred.lagDays ?? 0);
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

  /**
   * Cria ou atualiza IfcRelSequence (RelatingProcess = predecessora).
   * Folga grava-se em IfcLagTime (IFC4) ou IfcTimeMeasure (IFC2X3).
   */
  linkSequence(predId: number, succId: number, type: SequenceType = "FS", lagDays = 0): void {
    const pred = this.schedule.byId.get(predId);
    const succ = this.schedule.byId.get(succId);
    if (!pred || !succ) throw new Error("Tarefa da ligação não encontrada.");
    const existing = succ.predecessors.find((p) => p.taskId === predId);
    if (existing) {
      this.setSequence(predId, succId, type, lagDays);
      return;
    }
    if (wouldCreateIfcCycle(this.schedule.byId, predId, succId)) {
      throw new Error("Esta ligação criaria um ciclo entre as tarefas.");
    }
    const lag = Math.round(lagDays || 0);
    const relId = this.allocId();
    const lagTimeId = this.allocLagTime(lag);
    succ.predecessors.push({
      taskId: predId,
      type,
      lagDays: lag || undefined,
      relId,
      lagTimeId,
    });
    this.createdSequenceRels.push({ relId, predId, succId, type, lagDays: lag, lagTimeId });
    this.changeSet.append({ kind: "sequence:link", predId, succId });
    this.dirty = true;
  }

  setSequence(predId: number, succId: number, type: SequenceType, lagDays = 0): void {
    const succ = this.schedule.byId.get(succId);
    const entry = succ?.predecessors.find((p) => p.taskId === predId);
    if (!succ || !entry) {
      this.linkSequence(predId, succId, type, lagDays);
      return;
    }
    const lag = Math.round(lagDays || 0);
    if (entry.type === type && (entry.lagDays ?? 0) === lag) return;
    entry.type = type;
    entry.lagDays = lag || undefined;
    const record: SequenceRelRecord = {
      relId: entry.relId ?? this.allocId(),
      predId,
      succId,
      type,
      lagDays: lag,
      lagTimeId: entry.lagTimeId,
    };
    if (entry.relId == null) {
      entry.relId = record.relId;
      record.lagTimeId = this.allocLagTime(lag);
      entry.lagTimeId = record.lagTimeId;
      this.createdSequenceRels.push(record);
    } else {
      const created = this.createdSequenceRels.find((r) => r.relId === entry.relId);
      record.lagTimeId = this.syncLagTime(entry.lagTimeId, lag, created != null);
      entry.lagTimeId = record.lagTimeId;
      if (created) {
        created.type = type;
        created.lagDays = lag;
        created.lagTimeId = record.lagTimeId;
      } else {
        this.dirtySequenceRels.set(record.relId, record);
      }
    }
    this.changeSet.append({ kind: "sequence:update", predId, succId });
    this.dirty = true;
  }

  unlinkSequence(predId: number, succId: number): void {
    const succ = this.schedule.byId.get(succId);
    if (!succ) return;
    const entry = succ.predecessors.find((p) => p.taskId === predId);
    if (!entry) return;
    succ.predecessors = succ.predecessors.filter((p) => p.taskId !== predId);
    this.forgetSequence(entry.relId, entry.lagTimeId);
    this.changeSet.append({ kind: "sequence:unlink", predId, succId });
    this.dirty = true;
  }

  private allocLagTime(lagDays: number): number | undefined {
    if (!lagDays || this.schema === "IFC2X3") return undefined;
    const id = this.allocId();
    this.createdLagTimeIds.add(id);
    return id;
  }

  private syncLagTime(currentId: number | undefined, lagDays: number, createdRel: boolean): number | undefined {
    if (this.schema === "IFC2X3" || !lagDays) {
      if (currentId != null) {
        if (this.createdLagTimeIds.has(currentId)) this.createdLagTimeIds.delete(currentId);
        else this.deletedEntityIds.add(currentId);
        this.dirtyLagTimeIds.delete(currentId);
      }
      return undefined;
    }
    if (currentId == null) return this.allocLagTime(lagDays);
    if (createdRel || this.createdLagTimeIds.has(currentId)) return currentId;
    this.dirtyLagTimeIds.add(currentId);
    return currentId;
  }

  private forgetSequence(relId?: number, lagTimeId?: number): void {
    if (relId == null) return;
    const createdIdx = this.createdSequenceRels.findIndex((r) => r.relId === relId);
    if (createdIdx >= 0) this.createdSequenceRels.splice(createdIdx, 1);
    else this.deletedEntityIds.add(relId);
    this.dirtySequenceRels.delete(relId);
    if (lagTimeId == null) return;
    if (this.createdLagTimeIds.has(lagTimeId)) this.createdLagTimeIds.delete(lagTimeId);
    else this.deletedEntityIds.add(lagTimeId);
    this.dirtyLagTimeIds.delete(lagTimeId);
  }

  private timeLagArg(rel: SequenceRelRecord): string {
    if (!rel.lagDays) return "$";
    if (this.schema === "IFC2X3") return ifcTimeMeasureDays(rel.lagDays);
    return rel.lagTimeId != null ? `#${rel.lagTimeId}` : "$";
  }

  private dropSequencesInvolving(taskId: number): void {
    const pairs: Array<{ predId: number; succId: number }> = [];
    for (const t of this.schedule.byId.values()) {
      for (const p of t.predecessors) {
        if (p.taskId === taskId || t.id === taskId) pairs.push({ predId: p.taskId, succId: t.id });
      }
    }
    for (const pair of pairs) this.unlinkSequence(pair.predId, pair.succId);
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
    if (this.nextExpressId == null) this.nextExpressId = this.index.maxId + 1;
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
    this.changeSet.append({
      kind: "product:assign",
      taskId,
      globalId: guid,
      assigned: !already,
    });
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
    this.changeSet.append({ kind: "group:create", groupId });
    this.dirty = true;
    return group;
  }

  renameGroup(groupId: number, name: string): SelectionGroup {
    const group = this.requireGroup(groupId);
    const next = name.trim();
    if (!next) throw new Error("O conjunto precisa de um nome.");
    group.name = next;
    if (!this.createdGroupIds.has(groupId)) this.renamedGroupIds.add(groupId);
    this.changeSet.append({ kind: "group:update", groupId, fields: ["name"] });
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
    this.changeSet.append({ kind: "group:update", groupId, fields: ["members"] });
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
    this.changeSet.append({ kind: "group:delete", groupId });
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
        this.removedGroupTaskLinks.set(key, { taskId, groupId });
      }
    } else {
      task.groupIds.push(groupId);
      if (!group.taskIds.includes(taskId)) group.taskIds.push(taskId);
      for (let i = 0; i < group.productIds.length; i++) {
        this.addProductLink(task, group.productGuids[i], group.productIds[i]);
      }
      const pending = this.removedGroupTaskLinks.get(key);
      if (pending) this.removedGroupTaskLinks.delete(key);
      else {
        this.createdGroupTaskRels.set(key, { relId: this.allocId(), taskId, groupId });
      }
    }

    recomputeProductGuidsByTask(this.schedule);
    this.changeSet.append({ kind: "group:assign", taskId, groupId, assigned: !already });
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
      this.index.guidToId.get(guid) ??
      (expressIdHint != null && this.index.offset.has(expressIdHint) ? expressIdHint : undefined);
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
    const pendingLazyRemove = this.removedProductLinks.get(key);
    if (pendingRemove) this.removedExistingAssignRels.delete(pendingRemove[0]);
    else if (pendingLazyRemove) this.removedProductLinks.delete(key);
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
    else this.removedProductLinks.set(key, { taskId: task.id, productId });
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

  createExportSnapshot(): IfcSessionExportSnapshot {
    return {
      fileName: this.fileName,
      schedule: this.schedule,
      schema: this.schema,
      index: this.index,
      nextExpressId: this.nextExpressId,
      sets: {
        identityEdited: [...this.identityEdited],
        timeEdited: [...this.timeEdited],
        costEdited: [...this.costEdited],
        createdTaskTimeIds: [...this.createdTaskTimeIds],
        createdCostValueIds: [...this.createdCostValueIds],
        createdStarCostValueIds: [...this.createdStarCostValueIds],
        createdCostItemIds: [...this.createdCostItemIds],
        costItemNeedsValueLink: [...this.costItemNeedsValueLink],
        createdGroupIds: [...this.createdGroupIds],
        renamedGroupIds: [...this.renamedGroupIds],
        dirtyGroupMemberIds: [...this.dirtyGroupMemberIds],
        deletedGroupIds: [...this.deletedGroupIds],
        createdTaskIds: [...this.createdTaskIds],
        deletedTaskIds: [...this.deletedTaskIds],
        deletedEntityIds: [...this.deletedEntityIds],
        createdNestsRelIds: [...this.createdNestsRelIds],
        dirtyNestsParentIds: [...this.dirtyNestsParentIds],
        createdLagTimeIds: [...this.createdLagTimeIds],
        dirtyLagTimeIds: [...this.dirtyLagTimeIds],
        removedSiteLimitCluster: [...this.removedSiteLimitCluster],
      },
      maps: {
        elementNameEdited: [...this.elementNameEdited],
        propertyValueEdited: [...this.propertyValueEdited],
        createdCostRels: [...this.createdCostRels],
        createdProductRels: [...this.createdProductRels],
        removedExistingAssignRels: [...this.removedExistingAssignRels],
        removedProductLinks: [...this.removedProductLinks],
        createdGroupAssignRel: [...this.createdGroupAssignRel],
        createdGroupTaskRels: [...this.createdGroupTaskRels],
        removedGroupTaskRels: [...this.removedGroupTaskRels],
        removedGroupTaskLinks: [...this.removedGroupTaskLinks],
        dateTimeByDay: [...this.dateTimeByDay],
        ifc2x3Times: [...this.ifc2x3Times],
      },
      createdSequenceRels: this.createdSequenceRels.map((rel) => ({ ...rel })),
      dirtySequenceRels: [...this.dirtySequenceRels.values()].map((rel) => ({ ...rel })),
      createdDateLines: [...this.createdDateLines],
      flags: {
        createdWorkPlan: this.createdWorkPlan,
        createdWorkSchedule: this.createdWorkSchedule,
        createdAggregatesRel: this.createdAggregatesRel,
        createdScheduleControlRel: this.createdScheduleControlRel,
        dirtyScheduleControl: this.dirtyScheduleControl,
        renamedSchedule: this.renamedSchedule,
        geoChanged: this.geoChanged,
        siteLimitDirty: this.siteLimitDirty,
      },
      ids: {
        createdDeclaresRelId: this.createdDeclaresRelId,
        workControlDateId: this.workControlDateId,
        localTimeId: this.localTimeId,
      },
      extra: { ...this.extra },
      geoWrite: this.geoWrite ? { ...this.geoWrite } : null,
      wasmPath: this.wasmPath,
    };
  }

  static fromExportSnapshot(
    source: Uint8Array,
    snapshot: IfcSessionExportSnapshot,
  ): IfcSession {
    const session = new IfcSession(source, snapshot.fileName, snapshot.schedule, {
      index: snapshot.index,
      schema: snapshot.schema,
    });
    session.restoreExportSnapshot(snapshot);
    return session;
  }

  private restoreExportSnapshot(snapshot: IfcSessionExportSnapshot): void {
    this.nextExpressId = snapshot.nextExpressId;
    restoreSet(this.identityEdited, snapshot.sets.identityEdited);
    restoreSet(this.timeEdited, snapshot.sets.timeEdited);
    restoreSet(this.costEdited, snapshot.sets.costEdited);
    restoreSet(this.createdTaskTimeIds, snapshot.sets.createdTaskTimeIds);
    restoreSet(this.createdCostValueIds, snapshot.sets.createdCostValueIds);
    restoreSet(this.createdStarCostValueIds, snapshot.sets.createdStarCostValueIds);
    restoreSet(this.createdCostItemIds, snapshot.sets.createdCostItemIds);
    restoreSet(this.costItemNeedsValueLink, snapshot.sets.costItemNeedsValueLink);
    restoreSet(this.createdGroupIds, snapshot.sets.createdGroupIds);
    restoreSet(this.renamedGroupIds, snapshot.sets.renamedGroupIds);
    restoreSet(this.dirtyGroupMemberIds, snapshot.sets.dirtyGroupMemberIds);
    restoreSet(this.deletedGroupIds, snapshot.sets.deletedGroupIds);
    restoreSet(this.createdTaskIds, snapshot.sets.createdTaskIds);
    restoreSet(this.deletedTaskIds, snapshot.sets.deletedTaskIds);
    restoreSet(this.deletedEntityIds, snapshot.sets.deletedEntityIds);
    restoreSet(this.createdNestsRelIds, snapshot.sets.createdNestsRelIds);
    restoreSet(this.dirtyNestsParentIds, snapshot.sets.dirtyNestsParentIds);
    restoreSet(this.createdLagTimeIds, snapshot.sets.createdLagTimeIds);
    restoreSet(this.dirtyLagTimeIds, snapshot.sets.dirtyLagTimeIds);
    this.removedSiteLimitCluster = [...(snapshot.sets.removedSiteLimitCluster ?? [])];

    restoreMap(this.createdCostRels, snapshot.maps.createdCostRels);
    restoreMap(this.elementNameEdited, snapshot.maps.elementNameEdited);
    restoreMap(this.propertyValueEdited, snapshot.maps.propertyValueEdited);
    restoreMap(this.createdProductRels, snapshot.maps.createdProductRels);
    restoreMap(this.removedExistingAssignRels, snapshot.maps.removedExistingAssignRels);
    restoreMap(this.removedProductLinks, snapshot.maps.removedProductLinks);
    restoreMap(this.createdGroupAssignRel, snapshot.maps.createdGroupAssignRel);
    restoreMap(this.createdGroupTaskRels, snapshot.maps.createdGroupTaskRels);
    restoreMap(this.removedGroupTaskRels, snapshot.maps.removedGroupTaskRels);
    restoreMap(this.removedGroupTaskLinks, snapshot.maps.removedGroupTaskLinks);
    restoreMap(this.dateTimeByDay, snapshot.maps.dateTimeByDay);
    restoreMap(this.ifc2x3Times, snapshot.maps.ifc2x3Times);

    this.createdSequenceRels.splice(0, this.createdSequenceRels.length, ...snapshot.createdSequenceRels);
    this.dirtySequenceRels.clear();
    for (const rel of snapshot.dirtySequenceRels ?? []) this.dirtySequenceRels.set(rel.relId, { ...rel });
    this.createdDateLines.splice(0, this.createdDateLines.length, ...snapshot.createdDateLines);
    this.createdWorkPlan = !!snapshot.flags.createdWorkPlan;
    this.createdWorkSchedule = !!snapshot.flags.createdWorkSchedule;
    this.createdAggregatesRel = !!snapshot.flags.createdAggregatesRel;
    this.createdScheduleControlRel = !!snapshot.flags.createdScheduleControlRel;
    this.dirtyScheduleControl = !!snapshot.flags.dirtyScheduleControl;
    this.renamedSchedule = !!snapshot.flags.renamedSchedule;
    this.geoChanged = !!snapshot.flags.geoChanged;
    this.siteLimitDirty = !!snapshot.flags.siteLimitDirty;
    this.createdDeclaresRelId = snapshot.ids.createdDeclaresRelId;
    this.workControlDateId = snapshot.ids.workControlDateId;
    this.localTimeId = snapshot.ids.localTimeId;
    this.extra = { ...snapshot.extra };
    this.geoWrite = snapshot.geoWrite ? { ...snapshot.geoWrite } : null;
    this.dirty = true;
  }

  private buildExportBytes(): Uint8Array {
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
      const ent = this.find(this.schedule.workScheduleId);
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

    for (const [expressId, edit] of this.elementNameEdited) {
      const ent = this.find(expressId);
      if (!ent || ent.args.length < 3) {
        throw new Error(`Não foi possível editar o nome do elemento #${expressId}.`);
      }
      const args = [...ent.args];
      args[2] = ifcOptionalString(edit.name);
      replacements.push({
        start: ent.start,
        end: ent.end,
        text: serializeEntity(ent.expressId, ent.type, args),
      });
    }

    for (const [propertyId, value] of this.propertyValueEdited) {
      const ent = this.find(propertyId);
      if (!ent || ent.type !== "IFCPROPERTYSINGLEVALUE" || ent.args.length < 3) {
        throw new Error(`#${propertyId} não é um IfcPropertySingleValue editável.`);
      }
      const args = [...ent.args];
      args[2] = serializeNominalValue(args[2]!, value);
      replacements.push({
        start: ent.start,
        end: ent.end,
        text: serializeEntity(ent.expressId, ent.type, args),
      });
    }

    const taskIds = new Set([...this.identityEdited, ...this.timeEdited, ...this.costEdited]);

    for (const taskId of taskIds) {
      if (this.deletedTaskIds.has(taskId)) continue;
      const task = this.schedule.byId.get(taskId);
      if (!task) continue;

      if (this.createdTaskIds.has(taskId)) {
        newLines.push(serializeNewIfcTask(task, this.schema, oh));
      } else if (this.identityEdited.has(taskId)) {
        const taskEnt = this.find(task.id);
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
          const timeEnt = this.find(task.taskTimeId);
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
        const valueEnt = this.find(task.costValueId);
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
        const itemEnt = this.find(task.costItemId);
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
    for (const { taskId, productId } of this.removedProductLinks.values()) {
      const ent = findProductTaskRel(this.step(), taskId, productId, this.index);
      if (ent) this.removedExistingAssignRels.set(ent.expressId, { taskId, productId });
    }
    for (const [relId, { taskId, productId }] of this.removedExistingAssignRels) {
      const ent = this.find(relId);
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
          const ent = this.find(group.id);
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
            const ent = this.find(relId);
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
      const groupEnt = this.find(groupId);
      if (groupEnt) {
        replacements.push({
          start: groupEnt.start,
          end: groupEnt.end,
          text: `/* deleted #${groupId} IFCGROUP */`,
        });
      }
      const assignEnt = findGroupAssignRel(this.step(), groupId, this.index);
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
    for (const { taskId, groupId } of this.removedGroupTaskLinks.values()) {
      const ent = findGroupTaskRel(this.step(), taskId, groupId, this.index);
      if (ent) this.removedGroupTaskRels.set(ent.expressId, { taskId, groupId });
    }
    for (const [relId, { taskId, groupId }] of this.removedGroupTaskRels) {
      const ent = this.find(relId);
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
        const ent = this.find(parent.nestsRelId);
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
        const ent = this.find(this.schedule.scheduleControlRelId);
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
      if (rel.lagTimeId != null && this.createdLagTimeIds.has(rel.lagTimeId) && rel.lagDays) {
        newLines.push(serializeIfcLagTime(rel.lagTimeId, rel.lagDays));
      }
      newLines.push(
        serializeRelSequence(rel.relId, rel.predId, rel.succId, rel.type, this.schema, this.timeLagArg(rel)),
      );
    }
    const writtenLag = new Set(this.createdSequenceRels.map((r) => r.lagTimeId).filter((id): id is number => id != null));
    for (const rel of this.dirtySequenceRels.values()) {
      if (rel.lagTimeId != null && rel.lagDays) {
        if (this.createdLagTimeIds.has(rel.lagTimeId) && !writtenLag.has(rel.lagTimeId)) {
          newLines.push(serializeIfcLagTime(rel.lagTimeId, rel.lagDays));
        } else if (this.dirtyLagTimeIds.has(rel.lagTimeId)) {
          const lagEnt = this.find(rel.lagTimeId);
          if (lagEnt) {
            replacements.push({
              start: lagEnt.start,
              end: lagEnt.end,
              text: rewriteIfcLagTime(lagEnt, rel.lagDays),
            });
          }
        }
      }
      const ent = this.find(rel.relId);
      if (ent) {
        replacements.push({
          start: ent.start,
          end: ent.end,
          text: rewriteRelSequence(ent, rel.predId, rel.succId, rel.type, this.timeLagArg(rel)),
        });
      }
    }

    const commented = new Set<number>();
    const comment = (id: number, reason?: string) => {
      if (commented.has(id)) return;
      const ent = this.find(id);
      if (!ent) return;
      commented.add(id);
      replacements.push({ start: ent.start, end: ent.end, text: commentEntity(ent, reason) });
    };
    for (const taskId of this.deletedTaskIds) comment(taskId);
    for (const expressId of this.deletedEntityIds) comment(expressId);
    if (this.deletedTaskIds.size) {
      for (const ent of findSequenceEntities(this.step(), this.index)) {
        if (![...this.deletedTaskIds].some((id) => sequenceInvolves(ent, id))) continue;
        comment(ent.expressId, "unlinked");
      }
    }

    if (this.siteLimitDirty) {
      const toComment = new Set<number>(this.removedSiteLimitCluster);
      const limit = this.schedule.siteLimit;
      if (limit?.clusterIds) for (const id of limit.clusterIds) toComment.add(id);
      for (const id of toComment) comment(id, "site-limit");
      if (limit && limit.points.length >= 3) {
        const written = serializeSiteLimit({
          limit,
          ownerHistory: oh,
          index: this.index,
          nextExpressId: this.nextExpressId ?? this.index.maxId + 1,
        });
        newLines.push(...written.lines);
        this.nextExpressId = written.nextExpressId;
        limit.annotationId = written.annotationId;
        limit.globalId = written.globalId;
        limit.clusterIds = written.clusterIds;
        this.schedule.siteLimit = limit;
      } else {
        this.schedule.siteLimit = undefined;
      }
    }

    const originalText = this.step();
    const patched = applyReplacements(originalText, replacements);
    const withTasks = insertBeforeLastEndsec(patched, newLines.filter((l) => l.trim()));
    const georef = this.schedule.georef;
    const spatial =
      georef && (this.geoChanged || !extraIsIdentity(this.extra))
        ? patchIfcGeoref(
            withTasks,
            this.nextExpressId ?? maxExpressId(originalText, this.index) + 1,
            georef,
            this.extra,
            this.geoWrite,
            this.geoChanged,
          )
        : null;
    if (spatial) this.nextExpressId = spatial.nextExpressId;
    const outText = spatial?.text ?? withTasks;
    this.stepText = outText;
    this.index = buildStepIndex(outText);
    return latin1ToBytes(outText);
  }

  async exportBytes(): Promise<Uint8Array> {
    const source = await this.sourceBytesForExport();
    let bytes: Uint8Array;
    let nextIndex: StepIndex | null = null;
    if (typeof Worker !== "undefined") {
      try {
        const result = await runExportWorker(source, this.createExportSnapshot());
        bytes = new Uint8Array(result.bytes!);
        nextIndex = deserializeStepIndex(result.index);
      } catch (error) {
        console.warn("Worker de export IFC indisponível:", error);
        const fallback = this.storeHash ? await loadIfcBytes(this.storeHash) : null;
        if (fallback) this.stepText = bytesToLatin1(fallback);
        else if (this.stepText == null) throw error;
        bytes = await this.exportBytesOnCurrentThread();
        nextIndex = this.index;
      }
    } else {
      if (this.stepText == null) this.stepText = bytesToLatin1(source);
      bytes = await this.exportBytesOnCurrentThread();
      nextIndex = this.index;
    }
    await this.commitExport(bytes, nextIndex);
    return bytes;
  }

  /** Usado pelo export worker; não chamar no fluxo normal da UI. */
  async exportBytesOnCurrentThread(): Promise<Uint8Array> {
    await this.ensureText();
    return this.buildExportBytes();
  }

  async download(fileName = this.fileName): Promise<void> {
    const bytes = await this.exportBytes();
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

  private async sourceBytesForExport(): Promise<Uint8Array> {
    if (this.storeHash) {
      const bytes = await loadIfcBytes(this.storeHash);
      if (bytes) return bytes;
    }
    if (this.stepText != null) return latin1ToBytes(this.stepText);
    throw new Error("Não há IFC canônico disponível para exportar.");
  }

  private async commitExport(bytes: Uint8Array, nextIndex: StepIndex | null): Promise<void> {
    if (nextIndex) this.index = nextIndex;
    else this.index = buildStepIndex(bytesToLatin1(bytes));
    const exported = bytesToLatin1(bytes);
    if (this.siteLimitDirty || this.schedule.siteLimit) {
      this.schedule.siteLimit = parseSiteLimitFromStep(exported, this.index) ?? undefined;
    }
    if (this.storeHash) {
      const nextHash = await hashIfcBytes(bytes);
      const stored = await saveIfcBytes(nextHash, bytes);
      if (stored) this.storeHash = nextHash;
      this.stepText = null;
    } else {
      this.stepText = exported;
    }
    this.nextExpressId = this.index.maxId + 1;
    this.clearCommittedChanges();
  }

  private clearCommittedChanges(): void {
    const sets = [
      this.identityEdited,
      this.timeEdited,
      this.costEdited,
      this.createdTaskTimeIds,
      this.createdCostValueIds,
      this.createdStarCostValueIds,
      this.createdCostItemIds,
      this.costItemNeedsValueLink,
      this.createdGroupIds,
      this.renamedGroupIds,
      this.dirtyGroupMemberIds,
      this.deletedGroupIds,
      this.createdTaskIds,
      this.deletedTaskIds,
      this.deletedEntityIds,
      this.createdNestsRelIds,
      this.dirtyNestsParentIds,
      this.createdLagTimeIds,
      this.dirtyLagTimeIds,
    ];
    for (const set of sets) set.clear();
    this.createdCostRels.clear();
    this.elementNameEdited.clear();
    this.propertyValueEdited.clear();
    this.createdProductRels.clear();
    this.removedExistingAssignRels.clear();
    this.removedProductLinks.clear();
    this.createdGroupAssignRel.clear();
    this.createdGroupTaskRels.clear();
    this.removedGroupTaskRels.clear();
    this.removedGroupTaskLinks.clear();
    this.ifc2x3Times.clear();
    this.createdSequenceRels.length = 0;
    this.dirtySequenceRels.clear();
    this.createdDateLines.length = 0;
    this.createdWorkPlan = false;
    this.createdWorkSchedule = false;
    this.createdDeclaresRelId = undefined;
    this.createdAggregatesRel = false;
    this.createdScheduleControlRel = false;
    this.dirtyScheduleControl = false;
    this.renamedSchedule = false;
    this.geoChanged = false;
    this.siteLimitDirty = false;
    this.removedSiteLimitCluster = [];
    this.geoWrite = null;
    this.extra = emptyExtraTransform();
    this.changeSet.clear();
    this.dirty = false;
  }
}

async function runExportWorker(
  source: Uint8Array,
  snapshot: IfcSessionExportSnapshot,
): Promise<ExportWorkerResult & { bytes: ArrayBuffer; index: StepIndexWire }> {
  const payload =
    source.buffer instanceof ArrayBuffer &&
    source.byteOffset === 0 &&
    source.byteLength === source.buffer.byteLength
      ? source.buffer
      : source.slice().buffer;
  const worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("Tempo limite ao exportar IFC."));
    }, 300_000);
    worker.onmessage = (event: MessageEvent<ExportWorkerResult>) => {
      window.clearTimeout(timer);
      worker.terminate();
      const result = event.data;
      if (!result?.bytes || !result.index || result.error) {
        reject(new Error(result?.error || "O worker não devolveu o IFC exportado."));
        return;
      }
      resolve(result as ExportWorkerResult & { bytes: ArrayBuffer; index: StepIndexWire });
    };
    worker.onerror = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      reject(event);
    };
    worker.postMessage({ source: payload, snapshot }, [payload]);
  });
}

function restoreSet<T>(target: Set<T>, values: unknown): void {
  target.clear();
  if (!Array.isArray(values)) return;
  for (const value of values) target.add(value as T);
}

function restoreMap<K, V>(target: Map<K, V>, entries: Array<[unknown, unknown]> | undefined): void {
  target.clear();
  for (const [key, value] of entries ?? []) target.set(key as K, value as V);
}

function serializeNominalValue(
  previous: string,
  value: string | number | boolean | null,
): string {
  if (value == null) return "$";
  const wrapper = /^\s*([A-Z][A-Z0-9_]*)\s*\(/i.exec(previous)?.[1]?.toUpperCase();
  if (typeof value === "string") {
    const scalar = ifcString(value);
    return `${wrapper ?? "IFCLABEL"}(${scalar})`;
  }
  if (typeof value === "boolean") {
    const scalar = value ? ".T." : ".F.";
    return `${wrapper ?? "IFCBOOLEAN"}(${scalar})`;
  }
  if (!Number.isFinite(value)) throw new Error("O valor numérico da propriedade é inválido.");
  const scalar = Number.isInteger(value) ? `${value}.` : String(value);
  return `${wrapper ?? "IFCREAL"}(${scalar})`;
}

function rewriteIfcTask(ent: StepEntity, task: Task): string {
  const args = [...ent.args];
  if (args.length >= 13) {
    args[2] = ifcOptionalString(task.name);
    args[5] = ifcOptionalString(task.identification);
    args[9] = task.isMilestone ? ".T." : ".F.";
    if (task.taskTimeId != null) args[11] = `#${task.taskTimeId}`;
    return serializeEntity(ent.expressId, ent.type, args);
  }
  if (args.length >= 10) {
    args[2] = ifcOptionalString(task.name);
    args[5] = ifcString(task.identification?.trim() || `T${task.id}`);
    args[8] = task.isMilestone ? ".T." : ".F.";
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

function findGroupAssignRel(text: string, groupId: number, index?: StepIndex | null): StepEntity | null {
  const ids = index ? idsOfType(index, "IFCRELASSIGNSTOGROUP") : null;
  if (ids) {
    for (const id of ids) {
      const ent = findEntity(text, id, index);
      if (!ent || ent.args.length < 7) continue;
      if (ent.args[6] === `#${groupId}`) return ent;
    }
    return null;
  }
  const re = /#(\d+)\s*=\s*IFCRELASSIGNSTOGROUP\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ent = findEntity(text, Number(m[1]), index);
    if (!ent || ent.args.length < 7) continue;
    if (ent.args[6] === `#${groupId}`) return ent;
  }
  return null;
}

function findGroupTaskRel(text: string, taskId: number, groupId: number, index?: StepIndex | null): StepEntity | null {
  const ids = index ? idsOfType(index, "IFCRELASSIGNSTOPROCESS") : null;
  if (ids) {
    for (const id of ids) {
      const ent = findEntity(text, id, index);
      if (!ent || ent.args.length < 7) continue;
      if (ent.args[6] === `#${taskId}` && relatedIncludes(ent.args[4] ?? "", groupId)) return ent;
    }
    return null;
  }
  const re = /#(\d+)\s*=\s*IFCRELASSIGNSTOPROCESS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ent = findEntity(text, Number(m[1]), index);
    if (!ent || ent.args.length < 7) continue;
    if (ent.args[6] === `#${taskId}` && relatedIncludes(ent.args[4] ?? "", groupId)) return ent;
  }
  return null;
}

function findProductTaskRel(text: string, taskId: number, productId: number, index?: StepIndex | null): StepEntity | null {
  const types = index
    ? [...idsOfType(index, "IFCRELASSIGNSTOPRODUCT"), ...idsOfType(index, "IFCRELASSIGNSTOPROCESS")]
    : null;
  if (types) {
    for (const id of types) {
      const ent = findEntity(text, id, index);
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
  const re = /#(\d+)\s*=\s*IFCRELASSIGNS(?:TOPRODUCT|TOPROCESS)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ent = findEntity(text, Number(m[1]), index);
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
