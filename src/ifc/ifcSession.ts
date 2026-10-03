import type { ScheduleData, SelectionGroup, Task } from "../schedule/types";
import { VISTA4D_SET_TYPE } from "../schedule/types";
import { inclusiveCalendarDays, ownAndGroupGuids, recomputeProductGuidsByTask, recomputeScheduleRange } from "../schedule/range";
import { scheduleFromJson, scheduleToJson } from "../schedule/serialize";
import { rematchProductGuids, type GuidRematchReport } from "../project/rematch";
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
import { libraryItem } from "../site/library";
import { parseSiteAssets } from "../site/parseAssets";
import { planSiteAssetIds, serializeSiteAsset, siteAssetHasContainer, siteAssetNeedsContext } from "../site/serializeAsset";
import { cloneSiteAsset, type SiteAsset } from "../site/types";
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
  serializeNewCostSchedule,
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
import {
  cloneSemantic,
  emitSemantic,
  emptySemanticState,
  isSpatialContainer,
  isSpatialElement,
  matchProductGuids,
  readClassifications,
  readDocuments,
  readInterferences,
  readPropertySets,
  readSpatialNodes,
  readTables,
  VISTA4D_SEARCH_PSET,
  VISTA4D_SEARCH_QUERY,
  VISTA4D_SEARCH_TYPE,
  VISTA4D_TABLE_DOC,
  type ClassificationView,
  type DocumentView,
  type InterferenceView,
  type PropertySetView,
  type SemanticState,
  type SpatialNode,
  type TableView,
} from "./semanticWrite";

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
  semantic?: SemanticState;
  siteAssets?: SiteAsset[];
  removedSiteAssetClusters?: number[];
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
  fileName: string;
  readonly schedule: ScheduleData;
  readonly changeSet = new IfcChangeSet();
  private stepText: string | null;
  private index: StepIndex;
  private typeById: Map<number, string> | null = null;
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
  /** ExpressID → GlobalId de IfcBuildingElementProxy criado só para ligar GUIDs federados. */
  private readonly createdProductStubs = new Map<number, string>();
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
  private createdCostSchedule = false;
  private createdCostDeclaresRelId: number | undefined;
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
  private siteAssets: SiteAsset[] = [];
  private removedSiteAssetClusters: number[] = [];
  private siteAssetsDirty = false;
  private semantic: SemanticState = emptySemanticState();
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

  attachStore(hash: string): void {
    this.storeHash = hash;
  }

  stepTextBytes(): Uint8Array {
    if (this.stepText != null) return latin1ToBytes(this.stepText);
    throw new Error("O STEP deste modelo não está em memória.");
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

  /**
   * Se o cronograma está só em memória (JSON / CSV) e o STEP ainda não tem IfcTask,
   * volta a marcar tudo para o próximo export.
   */
  markPlanningForExport(): void {
    if (!this.schedule.roots.length) return;
    if (this.createdTaskIds.size > 0) return;
    if ((this.index.typeIds.get("IFCTASK")?.length ?? 0) > 0) return;
    this.adoptPlanningFrom(this.schedule, { keepExternalProducts: true });
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

  /** Aplica a transform sem marcar o STEP como sujo (abrir projeto). */
  hydrateExtraTransform(extra: ModelExtraTransform): void {
    this.extra = { ...extra };
  }

  /**
   * Leva o cronograma/custo/conjuntos de uma revisão anterior para este STEP.
   * Recasa produtos pelo GUID e volta a alocar express IDs neste ficheiro.
   */
  adoptPlanningFrom(source: ScheduleData, opts?: { keepExternalProducts?: boolean }): GuidRematchReport {
    const cloned = scheduleFromJson(scheduleToJson(source));
    if (!cloned) {
      return { matched: 0, orphans: [], keptTasks: 0 };
    }
    const report = rematchProductGuids(cloned, this.index.guidToId, {
      keepOrphans: !!opts?.keepExternalProducts,
    });
    const projectId = this.schedule.projectId ?? firstIdOfType(this.index, "IFCPROJECT");
    const georef = this.schedule.georef;
    this.rebasePlanningOntoThisFile(cloned);
    cloned.projectId = projectId;
    if (!cloned.georef) cloned.georef = georef;

    this.schedule.projectId = cloned.projectId;
    this.schedule.workPlanId = cloned.workPlanId;
    this.schedule.workScheduleId = cloned.workScheduleId;
    this.schedule.declaresRelId = cloned.declaresRelId;
    this.schedule.aggregatesRelId = cloned.aggregatesRelId;
    this.schedule.scheduleControlRelId = cloned.scheduleControlRelId;
    this.schedule.name = cloned.name;
    this.schedule.workPlanName = cloned.workPlanName;
    this.schedule.documents = cloned.documents;
    this.schedule.roots = cloned.roots;
    this.schedule.byId = cloned.byId;
    this.schedule.productGuidsByTask = cloned.productGuidsByTask;
    this.schedule.groups = cloned.groups;
    this.schedule.minDate = cloned.minDate;
    this.schedule.maxDate = cloned.maxDate;
    this.schedule.leafTaskCount = cloned.leafTaskCount;
    this.schedule.costScheduleId = cloned.costScheduleId;
    this.schedule.currency = cloned.currency;
    if (!this.schedule.georef) this.schedule.georef = cloned.georef;
    this.schedule.siteLimit = cloned.siteLimit;
    if (cloned.siteLimit) this.siteLimitDirty = true;
    this.dirty = true;
    return report;
  }

  listSiteAssets(): SiteAsset[] {
    return this.siteAssets.map(cloneSiteAsset);
  }

  async hydrateSiteAssets(): Promise<SiteAsset[]> {
    if (this.siteAssetsDirty || this.siteAssets.length) return this.listSiteAssets();
    if (!this.stepText && !this.storeHash) return [];
    if (!this.index.typeIds.get("IFCBUILDINGELEMENTPROXY")?.length) return [];
    const text = await this.ensureText();
    this.siteAssets = parseSiteAssets(text, this.index);
    return this.listSiteAssets();
  }

  placeSiteAsset(input: { libraryKey: string; x: number; y: number; z: number; yaw?: number; taskId?: number }): SiteAsset {
    const item = libraryItem(input.libraryKey);
    if (!item) throw new Error("Esse equipamento não está na biblioteca do canteiro.");
    if (input.taskId != null && !this.schedule.byId.has(input.taskId)) {
      throw new Error("A fase escolhida não está neste IFC.");
    }
    const quantities = [item.count, item.length, item.volume].filter((value) => value > 0).length;
    const planned = planSiteAssetIds(() => this.allocId(), {
      needsContext: siteAssetNeedsContext(this.index),
      quantities,
      hasContainer: siteAssetHasContainer(this.index),
    });
    const asset: SiteAsset = {
      proxyId: planned.proxyId,
      globalId: createIfcGuid(),
      libraryKey: item.key,
      name: item.name,
      x: input.x,
      y: input.y,
      z: input.z,
      yaw: input.yaw ?? 0,
      count: item.count,
      length: item.length,
      volume: item.volume,
      clusterIds: planned.clusterIds,
      isNew: true,
      dirty: true,
    };
    this.rememberSiteProxy(asset.proxyId, asset.globalId);
    this.siteAssets.push(asset);
    this.siteAssetsDirty = true;
    if (input.taskId != null) this.addProductsToTask(input.taskId, [{ guid: asset.globalId, expressIdHint: asset.proxyId }]);
    this.changeSet.append({ kind: "semantic:write", target: "site-asset" });
    this.dirty = true;
    return cloneSiteAsset(asset);
  }

  moveSiteAsset(globalId: string, patch: { x?: number; y?: number; z?: number; yaw?: number }): SiteAsset {
    const asset = this.siteAssets.find((item) => item.globalId === globalId);
    if (!asset) throw new Error("Esse elemento de canteiro não está na sessão.");
    if (patch.x != null) asset.x = patch.x;
    if (patch.y != null) asset.y = patch.y;
    if (patch.z != null) asset.z = patch.z;
    if (patch.yaw != null) asset.yaw = patch.yaw;
    if (!asset.isNew) this.retargetSavedSiteAsset(asset);
    asset.dirty = true;
    this.siteAssetsDirty = true;
    this.dirty = true;
    return cloneSiteAsset(asset);
  }

  removeSiteAsset(globalId: string): void {
    const asset = this.siteAssets.find((item) => item.globalId === globalId);
    if (!asset) return;
    if (!asset.isNew) this.removedSiteAssetClusters.push(...asset.clusterIds);
    for (const task of this.schedule.byId.values()) {
      if (task.productGuids.includes(asset.globalId)) this.removeProductLink(task, asset.globalId, asset.proxyId);
    }
    recomputeProductGuidsByTask(this.schedule);
    this.siteAssets = this.siteAssets.filter((item) => item.globalId !== globalId);
    this.siteAssetsDirty = true;
    this.dirty = true;
  }

  private retargetSavedSiteAsset(asset: SiteAsset): void {
    const oldId = asset.proxyId;
    this.removedSiteAssetClusters.push(...asset.clusterIds);
    const item = libraryItem(asset.libraryKey);
    const quantities = item ? [item.count, item.length, item.volume].filter((value) => value > 0).length : 1;
    const planned = planSiteAssetIds(() => this.allocId(), {
      needsContext: siteAssetNeedsContext(this.index),
      quantities,
      hasContainer: siteAssetHasContainer(this.index),
    });
    asset.proxyId = planned.proxyId;
    asset.clusterIds = planned.clusterIds;
    asset.isNew = true;
    this.rememberSiteProxy(asset.proxyId, asset.globalId);
    for (const task of this.schedule.byId.values()) {
      if (!task.productGuids.includes(asset.globalId)) continue;
      this.removeProductLink(task, asset.globalId, oldId);
      this.addProductLink(task, asset.globalId, asset.proxyId);
    }
  }

  private rememberSiteProxy(id: number, guid: string): void {
    this.index.guidToId.set(guid, id);
    const list = this.index.typeIds.get("IFCBUILDINGELEMENTPROXY") ?? [];
    if (!list.includes(id)) {
      list.push(id);
      this.index.typeIds.set("IFCBUILDINGELEMENTPROXY", list);
    }
    this.typeById = null;
  }

  getSiteLimit(): SiteLimit | null {
    const limit = this.schedule.siteLimit;
    if (!limit?.points.length) return null;
    return cloneSiteLimit(limit);
  }

  async hydrateSiteLimit(): Promise<SiteLimit | null> {
    if (this.schedule.siteLimit?.points.length) return this.getSiteLimit();
    if (!this.stepText && !this.storeHash) return this.getSiteLimit();
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
    if (!this.schedule.georef) {
      this.schedule.georef = { source: "ifc-site", heading: 0 };
    }
    this.schedule.georef.lat = geo.lat;
    this.schedule.georef.lon = geo.lon;
    this.schedule.georef.elevation = geo.elevation;
    if (this.schedule.georef.source === "none") this.schedule.georef.source = "ifc-site";
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

  async listPropertySets(globalId: string): Promise<PropertySetView[]> {
    const ownerId = this.requireGuid(globalId);
    const fromFile = await this.readStep((text) => readPropertySets(text, this.index, ownerId));
    for (const pset of fromFile) {
      for (const prop of pset.properties) {
        if (!this.propertyValueEdited.has(prop.id)) continue;
        const edited = this.propertyValueEdited.get(prop.id);
        prop.value = edited == null ? "" : String(edited);
      }
    }
    for (const write of this.semantic.properties) {
      if (write.ownerId !== ownerId) continue;
      let pset = fromFile.find((item) => item.id === write.psetId);
      if (!pset) {
        pset = { id: write.psetId, name: write.psetName, properties: [] };
        fromFile.push(pset);
      }
      const existing = pset.properties.find(
        (prop) => prop.id === write.propertyId || prop.name.toLowerCase() === write.propertyName.toLowerCase(),
      );
      if (existing) existing.value = write.value;
      else pset.properties.push({ id: write.propertyId, name: write.propertyName, value: write.value });
    }
    return fromFile;
  }

  async upsertProperty(globalId: string, psetName: string, propName: string, value: string): Promise<void> {
    const ownerId = this.requireGuid(globalId);
    const psetLabel = psetName.trim();
    const propLabel = propName.trim();
    if (!psetLabel || !propLabel) throw new Error("O conjunto de propriedades e a propriedade precisam de nome.");
    const sets = await this.listPropertySets(globalId);
    const pset = sets.find((item) => item.name.toLowerCase() === psetLabel.toLowerCase());
    const prop = pset?.properties.find((item) => item.name.toLowerCase() === propLabel.toLowerCase());
    if (prop && this.index.offset.has(prop.id)) {
      this.setPropertySingleValue(prop.id, value);
      return;
    }
    if (prop) {
      const pending = this.semantic.properties.find((item) => item.propertyId === prop.id);
      if (pending) {
        pending.value = value;
        this.markSemantic("property");
        return;
      }
    }
    const pendingPset = this.semantic.properties.find(
      (item) => item.ownerId === ownerId && item.psetName.toLowerCase() === psetLabel.toLowerCase(),
    );
    const psetIsNew = pset == null || !this.index.offset.has(pset.id);
    const psetId = !psetIsNew && pset ? pset.id : (pendingPset?.psetId ?? this.allocId());
    const relId = psetIsNew ? (pendingPset?.relId ?? this.allocId()) : undefined;
    this.semantic.properties.push({
      ownerId,
      psetId,
      psetName: pset?.name || psetLabel,
      psetIsNew,
      relId,
      propertyId: this.allocId(),
      propertyName: propLabel,
      value,
    });
    this.markSemantic("property");
  }

  async listClassifications(globalId: string): Promise<ClassificationView[]> {
    const ownerId = this.requireGuid(globalId);
    const fromFile = await this.readStep((text) => readClassifications(text, this.index, ownerId));
    for (const write of this.semantic.classifications) {
      if (write.ownerId !== ownerId) continue;
      const existing = fromFile.find((item) => item.referenceId === write.referenceId);
      const view: ClassificationView = {
        referenceId: write.referenceId,
        relId: write.relId,
        identification: write.identification,
        name: write.name,
        location: write.location,
        sourceName: write.sourceName,
      };
      if (existing) Object.assign(existing, view);
      else fromFile.push(view);
    }
    return fromFile;
  }

  async addClassification(
    globalId: string,
    input: { identification: string; name: string; location?: string; sourceName?: string },
  ): Promise<void> {
    const ownerId = this.requireGuid(globalId);
    const identification = input.identification.trim();
    const name = input.name.trim() || identification;
    if (!identification && !name) throw new Error("A classificação precisa de código ou nome.");
    const sourceName = input.sourceName?.trim() || "";
    this.semantic.classifications.push({
      ownerId,
      referenceId: this.allocId(),
      relId: this.allocId(),
      sourceId: sourceName ? this.allocId() : undefined,
      isNew: true,
      identification,
      name,
      location: input.location?.trim() || "",
      sourceName,
    });
    this.markSemantic("classification");
  }

  async listDocuments(): Promise<DocumentView[]> {
    let fromFile: DocumentView[] = [];
    if (this.stepText || this.storeHash) {
      try {
        fromFile = readDocuments(await this.ensureText(), this.index);
      } catch {
        fromFile = [];
      }
    }
    for (const write of this.semantic.documents) {
      const view: DocumentView = {
        documentId: write.documentId,
        relId: write.relId,
        name: write.name,
        identification: write.identification,
        location: write.location,
        description: write.description,
      };
      const existing = fromFile.find((item) => item.documentId === write.documentId);
      if (existing) Object.assign(existing, view);
      else if (write.isNew) fromFile.push(view);
    }
    for (const table of this.semantic.tables) {
      if (!table.documentIsNew || table.documentId == null) continue;
      if (fromFile.some((item) => item.documentId === table.documentId)) continue;
      fromFile.push({
        documentId: table.documentId,
        relId: table.relId,
        name: table.name,
        identification: "TABLE",
        location: "",
        description: VISTA4D_TABLE_DOC,
      });
    }
    if (this.stepText || this.storeHash || this.semantic.documents.length || this.semantic.tables.length) {
      const visible = fromFile.filter((item) => item.description !== VISTA4D_TABLE_DOC);
      this.schedule.documents = visible.map((item) => ({
        name: item.name,
        identification: item.identification || undefined,
        location: item.location || undefined,
        description: item.description || undefined,
        expressId: item.documentId,
      }));
    }
    return fromFile;
  }

  addDocumentReference(input: {
    name: string;
    identification?: string;
    location?: string;
    description?: string;
    relatedGlobalIds?: string[];
  }): DocumentView {
    const name = input.name.trim();
    if (!name) throw new Error("O documento precisa de um nome.");
    const location = input.location?.trim() || "";
    const identification = input.identification?.trim() || "";
    const description = input.description?.trim() || "";
    const key = `${name}|${location}|${identification}`;
    const known = this.schedule.documents.some(
      (doc) => `${doc.name}|${doc.location ?? ""}|${doc.identification ?? ""}` === key,
    );
    const pending = this.semantic.documents.some(
      (doc) => `${doc.name}|${doc.location}|${doc.identification}` === key,
    );
    if (known || pending) {
      const existing = this.semantic.documents.find(
        (doc) => `${doc.name}|${doc.location}|${doc.identification}` === key,
      );
      return {
        documentId: existing?.documentId ?? 0,
        name,
        identification,
        location,
        description,
      };
    }
    const relatedIds = this.resolveRelatedIds(input.relatedGlobalIds);
    const documentId = this.allocId();
    const relId = this.allocId();
    this.semantic.documents.push({
      documentId,
      relId,
      isNew: true,
      name,
      identification,
      location,
      description,
      relatedIds,
    });
    this.schedule.documents.push({
      name,
      identification: identification || undefined,
      location: location || undefined,
      description: description || undefined,
      expressId: documentId,
    });
    this.markSemantic("document");
    return { documentId, relId, name, identification, location, description };
  }

  async listTables(): Promise<TableView[]> {
    const fromFile = await this.readStep((text) => readTables(text, this.index));
    for (const write of this.semantic.tables) {
      const view: TableView = {
        tableId: write.tableId,
        name: write.name,
        columns: [...write.columns],
        rows: write.rows.map((row) => [...row]),
        clusterIds: [write.tableId, ...write.columnIds, ...write.rowIds],
      };
      const existing = fromFile.findIndex(
        (item) => item.tableId === write.tableId || item.name.toLowerCase() === write.name.toLowerCase(),
      );
      if (existing >= 0) fromFile[existing] = view;
      else fromFile.push(view);
    }
    return fromFile;
  }

  async upsertTable(name: string, columns: string[], rows: string[][]): Promise<void> {
    const label = name.trim();
    if (!label) throw new Error("A tabela precisa de um nome.");
    const head = columns.map((column) => column.trim()).filter(Boolean);
    if (!head.length) throw new Error("A tabela precisa de pelo menos uma coluna.");
    const body = rows.map((row) => head.map((_, index) => row[index]?.trim() ?? ""));
    const existing = (await this.listTables()).find((item) => item.name.toLowerCase() === label.toLowerCase());
    const pending = this.semantic.tables.find((item) => item.name.toLowerCase() === label.toLowerCase());
    const projectId = this.schedule.projectId ?? firstIdOfType(this.index, "IFCPROJECT");
    if (projectId == null) throw new Error("Este IFC não tem IfcProject para associar a tabela.");
    const columnIds = head.map(() => this.allocId());
    const rowIds =
      this.schema === "IFC2X3" ? [this.allocId(), ...body.map(() => this.allocId())] : body.map(() => this.allocId());
    const replaceIds = [
      ...(existing && this.index.offset.has(existing.tableId) ? existing.clusterIds : []),
      ...(pending?.replaceIds ?? []),
    ];
    const documentIsNew = !pending?.documentId;
    const next = {
      name: label,
      columns: head,
      rows: body,
      tableId: this.allocId(),
      columnIds,
      rowIds,
      documentId: pending?.documentId ?? this.allocId(),
      relId: pending?.relId ?? this.allocId(),
      documentIsNew,
      relatedIds: [projectId],
      replaceIds: [...new Set(replaceIds)],
    };
    this.semantic.tables = this.semantic.tables.filter((item) => item.name.toLowerCase() !== label.toLowerCase());
    this.semantic.tables.push(next);
    this.markSemantic("table");
  }

  async listSpatialNodes(): Promise<SpatialNode[]> {
    return this.readStep((text) => readSpatialNodes(text, this.index));
  }

  async moveSpatial(productGuid: string, parentGuid: string): Promise<void> {
    await this.ensureText();
    const productId = this.requireGuid(productGuid);
    const parentId = this.requireGuid(parentGuid);
    if (productId === parentId) throw new Error("O elemento não pode ser contido nele próprio.");
    const productType = this.entityType(productId) ?? "";
    if (productType === "IFCPROJECT") throw new Error("O IfcProject não se move.");
    const parentType = this.entityType(parentId) ?? "";
    const mode = isSpatialElement(productType) && productType !== "IFCPROJECT" ? "aggregate" : "contain";
    const parentOk = mode === "contain" ? isSpatialContainer(parentType) : isSpatialElement(parentType);
    if (!parentOk) {
      throw new Error(
        mode === "contain"
          ? "O contentor tem de ser IfcSite, IfcBuilding, IfcBuildingStorey ou IfcSpace."
          : "A agregação pede um elemento espacial (ou o IfcProject).",
      );
    }
    this.semantic.containments = this.semantic.containments.filter((item) => item.productId !== productId);
    this.semantic.containments.push({ productId, parentId, mode });
    this.markSemantic("spatial");
  }

  async listInterferences(): Promise<InterferenceView[]> {
    const fromFile = await this.readStep((text) => readInterferences(text, this.index));
    for (const write of this.semantic.interferences) {
      if (!write.isNew) continue;
      if (fromFile.some((item) => item.relId === write.relId)) continue;
      fromFile.push({
        relId: write.relId,
        name: write.name,
        description: write.description,
        relatingId: write.relatingId,
        relatedId: write.relatedId,
        interferenceType: write.interferenceType,
      });
    }
    return fromFile;
  }

  addInterference(input: {
    name?: string;
    description?: string;
    relatingGuid: string;
    relatedGuid: string;
    interferenceType?: string;
  }): void {
    if (this.schema === "IFC2X3") {
      throw new Error("IfcRelInterferesElements existe a partir do IFC4. Este ficheiro é IFC2X3.");
    }
    const relatingGuid = input.relatingGuid.trim();
    const relatedGuid = input.relatedGuid.trim();
    if (!relatingGuid || !relatedGuid) throw new Error("A interferência precisa de dois GlobalId.");
    if (relatingGuid === relatedGuid) throw new Error("Os dois elementos da interferência têm de ser distintos.");
    const relatingId = this.ensureFederatedProductStub(relatingGuid);
    const relatedId = this.ensureFederatedProductStub(relatedGuid);
    this.semantic.interferences.push({
      relId: this.allocId(),
      name: input.name?.trim() || "Interferência",
      description: input.description?.trim() || "",
      relatingId,
      relatedId,
      interferenceType: input.interferenceType?.trim() || "CLASH",
      isNew: true,
    });
    this.markSemantic("interference");
  }

  async createSearchSet(
    name: string,
    query: string,
    selectionGuids: string[] = [],
  ): Promise<SelectionGroup> {
    const text = await this.ensureText();
    const trimmed = query.trim();
    if (!trimmed) throw new Error("O search set precisa de uma consulta (Tipo=IfcWall ou Pset.Prop=valor).");
    const matched = matchProductGuids(text, this.index, trimmed, this.semantic.properties);
    const guids = matched.length ? matched : selectionGuids.filter((guid) => this.index.guidToId.has(guid));
    if (!guids.length) {
      throw new Error("A consulta não encontrou elementos neste IFC e não há seleção local.");
    }
    const group = this.createGroup(
      name,
      guids.map((guid) => ({ guid })),
      VISTA4D_SEARCH_TYPE,
    );
    this.semantic.searchQueries.push({
      groupId: group.id,
      psetId: this.allocId(),
      propertyId: this.allocId(),
      relId: this.allocId(),
      query: trimmed,
    });
    this.markSemantic("search");
    return group;
  }

  async listSearchSets(): Promise<Array<SelectionGroup & { query: string }>> {
    const out: Array<SelectionGroup & { query: string }> = [];
    for (const group of this.schedule.groups) {
      if (this.deletedGroupIds.has(group.id) || group.objectType !== VISTA4D_SEARCH_TYPE) continue;
      const pending = this.semantic.searchQueries.find((item) => item.groupId === group.id);
      let query = pending?.query ?? "";
      if (!query && group.globalId) {
        try {
          const sets = await this.listPropertySets(group.globalId);
          query =
            sets
              .find((set) => set.name === VISTA4D_SEARCH_PSET)
              ?.properties.find((prop) => prop.name === VISTA4D_SEARCH_QUERY)?.value ?? "";
        } catch {
          query = "";
        }
      }
      out.push({ ...group, query });
    }
    return out;
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
        this.ensureCostSchedule();
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

  /**
   * Garante IfcCostSchedule (BUDGET) no projeto — dono dos IfcCostItem 5D.
   * Na federação isto vive na COORD (IFC4).
   */
  ensureCostSchedule(name = "Orçamento"): { created: boolean } {
    if (this.schedule.costScheduleId != null) return { created: false };
    const projectId = this.schedule.projectId ?? firstIdOfType(this.index, "IFCPROJECT");
    if (projectId == null) {
      throw new Error("Este IFC não tem IfcProject — não dá para gravar um orçamento nativo.");
    }
    this.schedule.projectId = projectId;
    this.schedule.costScheduleId = this.allocId();
    this.createdCostSchedule = true;
    if (this.schema !== "IFC2X3") {
      if (this.createdDeclaresRelId == null && this.schedule.declaresRelId == null) {
        this.createdCostDeclaresRelId = this.allocId();
      }
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
      globalId: input.globalId?.trim() || createIfcGuid(),
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
    for (let i = task.productGuids.length - 1; i >= 0; i--) {
      this.removeProductLink(task, task.productGuids[i]!, task.productIds[i] ?? 0);
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
          cost: row.cost,
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
        if (row.cost != null && row.cost !== 0) this.applyTaskEdit(task.id, { cost: row.cost });
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

  private rebasePlanningOntoThisFile(cloned: ScheduleData): void {
    const idMap = new Map<number, number>();
    const take = (old?: number): number | undefined => {
      if (old == null) return undefined;
      const hit = idMap.get(old);
      if (hit != null) return hit;
      const nid = this.allocId();
      idMap.set(old, nid);
      return nid;
    };

    cloned.workPlanId = cloned.workPlanId != null ? take(cloned.workPlanId) : undefined;
    if (cloned.workPlanId != null) this.createdWorkPlan = true;
    cloned.workScheduleId = cloned.workScheduleId != null ? take(cloned.workScheduleId) : this.allocId();
    this.createdWorkSchedule = true;
    this.schedule.workScheduleId = cloned.workScheduleId;
    this.schedule.workPlanId = cloned.workPlanId;
    if (this.schema !== "IFC2X3") {
      cloned.declaresRelId = this.allocId();
      this.createdDeclaresRelId = cloned.declaresRelId;
    } else {
      cloned.declaresRelId = undefined;
      this.workControlDateId = this.ensureDateTime(new Date());
    }
    if (cloned.workPlanId != null) {
      cloned.aggregatesRelId = this.allocId();
      this.createdAggregatesRel = true;
    } else {
      cloned.aggregatesRelId = undefined;
    }
    if (cloned.costScheduleId != null) {
      cloned.costScheduleId = take(cloned.costScheduleId);
      this.createdCostSchedule = true;
    }
    this.schedule.costScheduleId = cloned.costScheduleId;

    const visit = (task: Task) => {
      const oldId = task.id;
      task.id = this.allocId();
      idMap.set(oldId, task.id);
      this.createdTaskIds.add(task.id);
      this.identityEdited.add(task.id);
      task.nestsRelId = undefined;
      task.sourceModelId = undefined;
      task.sourceFileName = undefined;
      task.isFederationRoot = false;
      if (task.start && task.end) {
        this.timeEdited.add(task.id);
        if (this.schema !== "IFC2X3") {
          task.taskTimeId = this.allocId();
          this.createdTaskTimeIds.add(task.taskTimeId);
        } else {
          task.taskTimeId = undefined;
        }
      } else {
        task.taskTimeId = undefined;
      }
      const hadCost = task.cost != null && task.cost !== 0;
      task.costItemId = undefined;
      task.costValueId = undefined;
      if (hadCost) {
        this.ensureCostSchedule();
        this.ensureCostEntities(task);
        this.costEdited.add(task.id);
      }
      for (let i = 0; i < task.productGuids.length; i++) {
        const guid = task.productGuids[i]!;
        const localPid = this.lookupLocalProductId(guid) ?? this.ensureFederatedProductStub(guid);
        task.productIds[i] = localPid;
        this.createdProductRels.set(`${task.id}:${localPid}`, {
          relId: this.allocId(),
          taskId: task.id,
          productId: localPid,
        });
      }
      for (const child of task.children) visit(child);
    };
    for (const root of cloned.roots) visit(root);

    const remapTask = (task: Task) => {
      task.parentId = task.parentId != null ? idMap.get(task.parentId) : undefined;
      const oldPreds = task.predecessors ?? [];
      task.predecessors = [];
      for (const pred of oldPreds) {
        const predId = idMap.get(pred.taskId);
        if (predId == null) continue;
        const relId = this.allocId();
        const lag = Math.round(pred.lagDays || 0);
        const lagTimeId = this.allocLagTime(lag);
        task.predecessors.push({
          taskId: predId,
          type: pred.type,
          lagDays: lag || undefined,
          relId,
          lagTimeId,
        });
        this.createdSequenceRels.push({
          relId,
          predId,
          succId: task.id,
          type: pred.type,
          lagDays: lag,
          lagTimeId,
        });
      }
      task.groupIds = (task.groupIds ?? []).map((gid) => idMap.get(gid)).filter((id): id is number => id != null);
      for (const child of task.children) remapTask(child);
    };

    for (const group of cloned.groups ?? []) {
      const oldId = group.id;
      group.id = this.allocId();
      idMap.set(oldId, group.id);
      this.createdGroupIds.add(group.id);
      group.sourceModelId = undefined;
      group.sourceFileName = undefined;
      const localMemberIds: number[] = [];
      for (let i = 0; i < group.productGuids.length; i++) {
        const localPid = this.lookupLocalProductId(group.productGuids[i]!);
        group.productIds[i] = localPid ?? 0;
        if (localPid != null) localMemberIds.push(localPid);
      }
      if (localMemberIds.length) {
        const relId = this.allocId();
        group.assignRelId = relId;
        this.createdGroupAssignRel.set(group.id, relId);
      } else {
        group.assignRelId = undefined;
      }
    }
    for (const root of cloned.roots) remapTask(root);
    cloned.byId = new Map();
    const index = (t: Task) => {
      cloned.byId.set(t.id, t);
      for (const c of t.children) index(c);
    };
    for (const r of cloned.roots) index(r);
    for (const group of cloned.groups ?? []) {
      group.taskIds = (group.taskIds ?? [])
        .map((tid) => idMap.get(tid))
        .filter((id): id is number => id != null);
      for (const taskId of group.taskIds) {
        this.createdGroupTaskRels.set(`${taskId}:${group.id}`, {
          relId: this.allocId(),
          taskId,
          groupId: group.id,
        });
        const task = cloned.byId.get(taskId);
        if (task && !task.groupIds.includes(group.id)) task.groupIds.push(group.id);
      }
    }

    if (this.schema === "IFC2X3") {
      for (const task of cloned.byId.values()) {
        if (task.start && task.end) this.attachIfc2x3Time(task);
      }
    }
    for (const task of cloned.byId.values()) {
      if (task.children.length) this.touchNestsOn(task, cloned);
    }
    cloned.scheduleControlRelId = cloned.roots.length ? this.allocId() : undefined;
    this.createdScheduleControlRel = cloned.scheduleControlRelId != null;
    if (cloned.siteLimit) {
      cloned.siteLimit = {
        ...cloned.siteLimit,
        annotationId: undefined,
        clusterIds: undefined,
      };
    }
    recomputeProductGuidsByTask(cloned);
    recomputeScheduleRange(cloned);
  }

  private touchNestsOn(parent: Task, schedule: ScheduleData): void {
    const live = schedule.byId.get(parent.id) ?? parent;
    if (live.children.length === 0) {
      live.nestsRelId = undefined;
      return;
    }
    live.nestsRelId = this.allocId();
    this.createdNestsRelIds.add(live.nestsRelId);
    this.dirtyNestsParentIds.add(live.id);
  }

  private allocId(): number {
    if (this.nextExpressId == null) this.nextExpressId = this.index.maxId + 1;
    return this.nextExpressId++;
  }

  /**
   * Liga ou desliga um IfcProduct à IfcTask (IfcRelAssignsToProduct no formato Bonsai 4D).
   * Clique repetido no mesmo elemento remove a associação.
   * GUIDs que não existem neste STEP ficam só na tarefa (ligação federada).
   */
  assignProductToTask(
    taskId: number,
    guid: string,
    expressIdHint?: number,
  ): { added: boolean; guids: string[] } {
    const task = this.schedule.byId.get(taskId);
    if (!task) throw new Error(`Tarefa #${taskId} não encontrada.`);
    const productId = this.lookupLocalProductId(guid, expressIdHint) ?? 0;
    const already = task.productGuids.includes(guid);
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

  /** Acrescenta produtos à IfcTask sem desligar os já associados (assistente 4D). */
  addProductsToTask(
    taskId: number,
    items: Array<{ guid: string; expressIdHint?: number }>,
  ): { added: number; guids: string[] } {
    const task = this.schedule.byId.get(taskId);
    if (!task) throw new Error(`Tarefa #${taskId} não encontrada.`);
    let added = 0;
    for (const item of items) {
      if (!item.guid || task.productGuids.includes(item.guid)) continue;
      const productId = this.lookupLocalProductId(item.guid, item.expressIdHint) ?? 0;
      this.addProductLink(task, item.guid, productId);
      this.changeSet.append({
        kind: "product:assign",
        taskId,
        globalId: item.guid,
        assigned: true,
      });
      added += 1;
    }
    if (added) {
      recomputeProductGuidsByTask(this.schedule);
      this.dirty = true;
    }
    return {
      added,
      guids: this.schedule.productGuidsByTask.get(taskId) ?? [...task.productGuids],
    };
  }

  /**
   * No export da disciplina: IfcTask stub com o GlobalId da COORD + RelAssignsToProduct
   * para cada GUID local ligado a essa tarefa.
   */
  syncCoordinationBindings(coordSchedule: ScheduleData): void {
    const visit = (task: Task) => {
      this.bindLocalProductsToCoordTask(task);
      for (const child of task.children) visit(child);
    };
    for (const root of coordSchedule.roots) visit(root);
  }

  createGroup(
    name: string,
    members: Array<{ guid: string; expressId?: number }>,
    objectType = VISTA4D_SET_TYPE,
  ): SelectionGroup {
    const trimmed = name.trim() || "Conjunto";
    const groupId = this.allocId();
    const productIds: number[] = [];
    const productGuids: string[] = [];
    for (const m of members) {
      if (productGuids.includes(m.guid)) continue;
      const pid = this.lookupLocalProductId(m.guid, m.expressId) ?? 0;
      productGuids.push(m.guid);
      productIds.push(pid);
    }
    const assignRelId = productIds.some((id) => id > 0) ? this.allocId() : undefined;
    const group: SelectionGroup = {
      id: groupId,
      globalId: createIfcGuid(),
      name: trimmed,
      objectType,
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
      if (nextGuids.includes(m.guid)) continue;
      nextGuids.push(m.guid);
      nextIds.push(this.lookupLocalProductId(m.guid, m.expressId) ?? 0);
    }
    const removed: Array<{ id: number; guid: string }> = [];
    for (let i = 0; i < group.productGuids.length; i++) {
      const guid = group.productGuids[i]!;
      if (!nextGuids.includes(guid)) {
        removed.push({ id: group.productIds[i] ?? 0, guid });
      }
    }
    const added: Array<{ id: number; guid: string }> = [];
    for (let i = 0; i < nextGuids.length; i++) {
      const guid = nextGuids[i]!;
      if (!group.productGuids.includes(guid)) {
        added.push({ id: nextIds[i] ?? 0, guid });
      }
    }
    group.productIds = nextIds;
    group.productGuids = nextGuids;
    if (this.createdGroupIds.has(groupId)) {
      if (nextIds.some((id) => id > 0) && !this.createdGroupAssignRel.has(groupId)) {
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
      for (let i = 0; i < group.productGuids.length; i++) {
        this.removeProductLink(task, group.productGuids[i]!, group.productIds[i] ?? 0);
      }
      if (this.createdGroupTaskRels.has(key)) this.createdGroupTaskRels.delete(key);
      else {
        this.removedGroupTaskLinks.set(key, { taskId, groupId });
      }
    } else {
      task.groupIds.push(groupId);
      if (!group.taskIds.includes(taskId)) group.taskIds.push(taskId);
      for (let i = 0; i < group.productGuids.length; i++) {
        this.addProductLink(task, group.productGuids[i]!, group.productIds[i] ?? 0);
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

  private requireGuid(globalId: string): number {
    const id = this.index.guidToId.get(globalId.trim());
    if (id == null) throw new Error(`GlobalId ${globalId} não está neste IFC.`);
    return id;
  }

  private async readStep<T>(read: (text: string) => T): Promise<T> {
    try {
      return read(await this.ensureText());
    } catch {
      return read("");
    }
  }

  private markSemantic(target: string): void {
    this.changeSet.append({ kind: "semantic:write", target });
    this.dirty = true;
  }

  private resolveRelatedIds(globalIds: string[] | undefined): number[] {
    const ids: number[] = [];
    for (const guid of globalIds ?? []) {
      const id = this.index.guidToId.get(guid.trim());
      if (id != null) ids.push(id);
    }
    if (ids.length) return ids;
    const projectId = this.schedule.projectId ?? firstIdOfType(this.index, "IFCPROJECT");
    if (projectId == null) throw new Error("Este IFC não tem IfcProject para associar o documento.");
    return [projectId];
  }

  private requireGroup(groupId: number): SelectionGroup {
    const group = this.schedule.groups.find((g) => g.id === groupId);
    if (!group || this.deletedGroupIds.has(groupId)) {
      throw new Error(`Conjunto #${groupId} não encontrado.`);
    }
    return group;
  }

  private entityType(expressId: number): string | undefined {
    if (!this.typeById) {
      this.typeById = new Map();
      for (const [type, ids] of this.index.typeIds) {
        for (const id of ids) this.typeById.set(id, type);
      }
    }
    return this.typeById.get(expressId);
  }

  private isAssignableProduct(expressId: number): boolean {
    const type = this.entityType(expressId);
    if (!type) return true;
    if (type.startsWith("IFCREL")) return false;
    if (
      type === "IFCTASK" ||
      type === "IFCTASKTIME" ||
      type === "IFCGROUP" ||
      type === "IFCWORKPLAN" ||
      type === "IFCWORKSCHEDULE" ||
      type === "IFCCOSTSCHEDULE" ||
      type === "IFCCOSTITEM" ||
      type === "IFCCOSTVALUE"
    ) {
      return false;
    }
    return true;
  }

  private lookupLocalProductId(guid: string, expressIdHint?: number): number | undefined {
    const productId =
      this.index.guidToId.get(guid) ??
      (expressIdHint != null && this.index.offset.has(expressIdHint) ? expressIdHint : undefined);
    if (productId == null || !this.isAssignableProduct(productId)) return undefined;
    return productId;
  }

  /** Âncora no STEP da COORD para um GlobalId que só existe noutro IFC. */
  private ensureFederatedProductStub(guid: string): number {
    const existing = this.lookupLocalProductId(guid);
    if (existing != null) return existing;
    for (const [id, g] of this.createdProductStubs) {
      if (g === guid) return id;
    }
    const id = this.allocId();
    this.createdProductStubs.set(id, guid);
    this.index.guidToId.set(guid, id);
    return id;
  }

  private addProductLink(task: Task, guid: string, productId: number): void {
    if (task.productGuids.includes(guid)) return;
    const id = productId > 0 ? productId : this.ensureFederatedProductStub(guid);
    task.productGuids.push(guid);
    task.productIds.push(id);
    const key = `${task.id}:${id}`;
    const pendingRemove = [...this.removedExistingAssignRels.entries()].find(
      ([, v]) => v.taskId === task.id && v.productId === id,
    );
    const pendingLazyRemove = this.removedProductLinks.get(key);
    if (pendingRemove) this.removedExistingAssignRels.delete(pendingRemove[0]);
    else if (pendingLazyRemove) this.removedProductLinks.delete(key);
    else if (!this.createdProductRels.has(key)) {
      this.createdProductRels.set(key, { relId: this.allocId(), taskId: task.id, productId: id });
    }
  }

  private removeProductLink(task: Task, guid: string, productId: number): void {
    const gi = task.productGuids.indexOf(guid);
    if (gi >= 0) {
      task.productGuids.splice(gi, 1);
      if (gi < task.productIds.length) task.productIds.splice(gi, 1);
    } else if (productId > 0) {
      const pi = task.productIds.indexOf(productId);
      if (pi >= 0) task.productIds.splice(pi, 1);
    }
    if (productId <= 0) return;
    const key = `${task.id}:${productId}`;
    if (this.createdProductRels.has(key)) this.createdProductRels.delete(key);
    else this.removedProductLinks.set(key, { taskId: task.id, productId });
  }

  private bindLocalProductsToCoordTask(coordTask: Task): void {
    const local: Array<{ guid: string; id: number }> = [];
    for (const guid of coordTask.productGuids) {
      const id = this.lookupLocalProductId(guid);
      if (id != null) local.push({ guid, id });
    }
    if (!local.length) return;
    const stub = this.ensureTaskStub(coordTask);
    for (const { guid, id } of local) {
      if (!stub.productGuids.includes(guid)) this.addProductLink(stub, guid, id);
    }
    this.dirty = true;
  }

  /** Stub IfcTask com o mesmo GlobalId da tarefa da COORD — âncora, sem WBS. */
  private ensureTaskStub(src: Task): Task {
    for (const existing of this.schedule.byId.values()) {
      if (existing.globalId === src.globalId) return existing;
    }
    const indexed = this.index.guidToId.get(src.globalId);
    if (indexed != null && this.entityType(indexed) === "IFCTASK") {
      const live = this.schedule.byId.get(indexed);
      if (live) return live;
      const stub: Task = {
        id: indexed,
        globalId: src.globalId,
        name: src.name,
        identification: src.identification,
        children: [],
        productIds: [],
        productGuids: [],
        groupIds: [],
        predecessors: [],
      };
      this.schedule.byId.set(indexed, stub);
      return stub;
    }
    const id = this.allocId();
    const stub: Task = {
      id,
      globalId: src.globalId,
      name: src.name.trim() || "Tarefa",
      identification: src.identification,
      children: [],
      productIds: [],
      productGuids: [],
      groupIds: [],
      predecessors: [],
    };
    this.schedule.byId.set(id, stub);
    this.createdTaskIds.add(id);
    this.identityEdited.add(id);
    return stub;
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
        createdProductStubs: [...this.createdProductStubs],
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
        createdCostSchedule: this.createdCostSchedule,
        createdAggregatesRel: this.createdAggregatesRel,
        createdScheduleControlRel: this.createdScheduleControlRel,
        dirtyScheduleControl: this.dirtyScheduleControl,
        renamedSchedule: this.renamedSchedule,
        geoChanged: this.geoChanged,
        siteLimitDirty: this.siteLimitDirty,
        siteAssetsDirty: this.siteAssetsDirty,
      },
      ids: {
        createdDeclaresRelId: this.createdDeclaresRelId,
        createdCostDeclaresRelId: this.createdCostDeclaresRelId,
        workControlDateId: this.workControlDateId,
        localTimeId: this.localTimeId,
      },
      extra: { ...this.extra },
      geoWrite: this.geoWrite ? { ...this.geoWrite } : null,
      wasmPath: this.wasmPath,
      semantic: cloneSemantic(this.semantic),
      siteAssets: this.siteAssets.map(cloneSiteAsset),
      removedSiteAssetClusters: [...this.removedSiteAssetClusters],
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
    restoreMap(this.createdProductStubs, snapshot.maps.createdProductStubs);
    for (const [id, guid] of this.createdProductStubs) {
      if (guid) this.index.guidToId.set(guid, id);
    }
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
    this.createdCostSchedule = !!snapshot.flags.createdCostSchedule;
    this.createdAggregatesRel = !!snapshot.flags.createdAggregatesRel;
    this.createdScheduleControlRel = !!snapshot.flags.createdScheduleControlRel;
    this.dirtyScheduleControl = !!snapshot.flags.dirtyScheduleControl;
    this.renamedSchedule = !!snapshot.flags.renamedSchedule;
    this.geoChanged = !!snapshot.flags.geoChanged;
    this.siteLimitDirty = !!snapshot.flags.siteLimitDirty;
    this.siteAssetsDirty = !!snapshot.flags.siteAssetsDirty;
    this.siteAssets = (snapshot.siteAssets ?? []).map(cloneSiteAsset);
    this.removedSiteAssetClusters = [...(snapshot.removedSiteAssetClusters ?? [])];
    this.createdDeclaresRelId = snapshot.ids.createdDeclaresRelId;
    this.createdCostDeclaresRelId = snapshot.ids.createdCostDeclaresRelId;
    this.workControlDateId = snapshot.ids.workControlDateId;
    this.localTimeId = snapshot.ids.localTimeId;
    this.extra = { ...snapshot.extra };
    this.geoWrite = snapshot.geoWrite ? { ...snapshot.geoWrite } : null;
    this.semantic = cloneSemantic(snapshot.semantic);
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
    if (this.createdCostSchedule && this.schedule.costScheduleId != null) {
      newLines.push(
        serializeNewCostSchedule(
          this.schedule.costScheduleId,
          this.schedule.name || "Orçamento",
          now,
          this.schema,
          oh,
          this.workControlDateId,
        ),
      );
    }
    if (this.schema !== "IFC2X3" && this.createdDeclaresRelId != null && this.schedule.projectId != null) {
      const defs = [this.schedule.workScheduleId, this.schedule.workPlanId, this.schedule.costScheduleId].filter(
        (id): id is number => id != null,
      );
      newLines.push(serializeRelDeclares(this.createdDeclaresRelId, this.schedule.projectId, defs, oh));
    } else if (
      this.schema !== "IFC2X3" &&
      this.createdCostDeclaresRelId != null &&
      this.schedule.projectId != null &&
      this.schedule.costScheduleId != null
    ) {
      newLines.push(
        serializeRelDeclares(this.createdCostDeclaresRelId, this.schedule.projectId, [this.schedule.costScheduleId], oh),
      );
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

    for (const [id, guid] of this.createdProductStubs) {
      newLines.push(serializeFederatedProductStub(id, guid, oh));
    }
    for (const { relId, taskId, productId } of this.createdProductRels.values()) {
      if (productId <= 0) continue;
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

    const semantic = emitSemantic(this.semantic, {
      schema: this.schema,
      ownerHistory: oh,
      find: (id) => this.find(id),
      index: this.index,
      allocId: () => this.allocId(),
    });
    newLines.push(...semantic.lines);
    replacements.push(...semantic.replacements);

    if (this.siteAssetsDirty) {
      for (const id of this.removedSiteAssetClusters) comment(id, "site-asset");
      for (const asset of this.siteAssets) {
        if (!asset.isNew && !asset.dirty) continue;
        if (!asset.isNew) for (const id of asset.clusterIds) comment(id, "site-asset");
        newLines.push(...serializeSiteAsset(asset, this.schema, oh, this.index));
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
      if (bytes) return bytes.slice();
    }
    if (this.stepText != null) return latin1ToBytes(this.stepText);
    throw new Error("Não há IFC canônico disponível para exportar.");
  }

  private async commitExport(bytes: Uint8Array, nextIndex: StepIndex | null): Promise<void> {
    if (nextIndex) this.index = nextIndex;
    else this.index = buildStepIndex(bytesToLatin1(bytes));
    this.typeById = null;
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
    this.createdProductStubs.clear();
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
    this.createdCostSchedule = false;
    this.createdDeclaresRelId = undefined;
    this.createdCostDeclaresRelId = undefined;
    this.createdAggregatesRel = false;
    this.createdScheduleControlRel = false;
    this.dirtyScheduleControl = false;
    this.renamedSchedule = false;
    this.geoChanged = false;
    this.siteLimitDirty = false;
    this.removedSiteLimitCluster = [];
    this.siteAssetsDirty = false;
    this.removedSiteAssetClusters = [];
    for (const asset of this.siteAssets) {
      asset.isNew = false;
      asset.dirty = false;
    }
    this.geoWrite = null;
    this.semantic = emptySemanticState();
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

function serializeFederatedProductStub(expressId: number, guid: string, ownerHistory: string): string {
  return serializeEntity(expressId, "IFCBUILDINGELEMENTPROXY", [
    ifcString(guid),
    ownerHistory,
    ifcOptionalString("4D"),
    ifcOptionalString("Referência federada"),
    ifcString("VISTA4D_PRODUCT_REF"),
    "$",
    "$",
    "$",
    "$",
  ]);
}

function serializeNewIfcGroup(group: SelectionGroup): string {
  const args = [
    ifcString(group.globalId),
    "$",
    ifcOptionalString(group.name),
    ifcString(group.objectType === VISTA4D_SEARCH_TYPE ? "Search set" : "Selection set 4D"),
    ifcString(group.objectType || VISTA4D_SET_TYPE),
  ];
  return serializeEntity(group.id, "IFCGROUP", args);
}

function serializeNewAssignToGroup(expressId: number, group: SelectionGroup): string {
  const ids = group.productIds.filter((id) => id > 0);
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
