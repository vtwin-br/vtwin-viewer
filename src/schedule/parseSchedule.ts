import * as WebIFC from "web-ifc";
import { extractGeoref } from "../ifc/georef";
import { VISTA4D_SET_TYPE, type ScheduleData, type SelectionGroup, type Task } from "./types";

/**
 * Le o IFC com web-ifc (WASM reutilizado entre aberturas) e extrai a estrutura de cronograma:
 *
 *  - IfcWorkSchedule (raiz 4D)
 *  - IfcTask  +  IfcRelNests  ->  hierarquia
 *  - IfcTaskTime  ->  ScheduleStart / ScheduleFinish
 *  - IfcRelAssignsToProcess  ->  task -> produtos 3D / IfcGroup
 *  - IfcGroup + IfcRelAssignsToGroup  ->  conjuntos 4D (selection sets)
 *  - IfcCostSchedule / IfcCostItem / IfcCostValue  ->  5D
 *  - IfcRelAssignsToControl  ->  IfcCostItem <-> IfcTask (ou produto)
 *
 * Espelha a forma como o Bonsai (BlenderBIM) escreve cronogramas em IFC4.
 */
let scheduleApi: Promise<WebIFC.IfcAPI> | null = null;

async function getScheduleApi(wasmPath: string): Promise<WebIFC.IfcAPI> {
  if (!scheduleApi) {
    scheduleApi = (async () => {
      const api = new WebIFC.IfcAPI();
      api.SetWasmPath(wasmPath, true);
      await api.Init();
      return api;
    })();
  }
  return scheduleApi;
}

export async function parseSchedule(
  buffer: Uint8Array,
  wasmPath: string,
): Promise<ScheduleData> {
  const ifcApi = await getScheduleApi(wasmPath);
  const modelId = ifcApi.OpenModel(buffer);
  try {
    return extract(ifcApi, modelId);
  } finally {
    ifcApi.CloseModel(modelId);
  }
}

/** Extrai o cronograma de um modelo web-ifc já aberto (1.ª conversão IfcLoader). */
export function parseOpenIfcModel(ifcApi: WebIFC.IfcAPI, modelId: number): ScheduleData {
  return extract(ifcApi, modelId);
}

function extract(ifcApi: WebIFC.IfcAPI, modelId: number): ScheduleData {
  const projectId = idsOfType(ifcApi, modelId, WebIFC.IFCPROJECT)[0];
  const workPlanId = idsOfType(ifcApi, modelId, WebIFC.IFCWORKPLAN)[0];

  // ---------- 1) IfcWorkSchedule (escolhe a primeira) ----------
  const scheduleIds = idsOfType(ifcApi, modelId, WebIFC.IFCWORKSCHEDULE);
  const workScheduleId = scheduleIds[0];
  const workSchedule = workScheduleId
    ? (safeLine(ifcApi, modelId, workScheduleId) as any)
    : null;
  const scheduleName: string =
    str(workSchedule?.Name) ?? str(workSchedule?.LongName) ?? "Cronograma";

  // ---------- 2) Mapa de IfcTaskTime por expressID ----------
  const taskTimeMap = new Map<number, any>();
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCTASKTIME)) {
    taskTimeMap.set(id, safeLine(ifcApi, modelId, id));
  }

  // ---------- 3) Todas as IfcTask (cria objetos base) ----------
  const allTasks = new Map<number, Task>();
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCTASK)) {
    const raw = safeLine(ifcApi, modelId, id) as any;
    if (!raw) continue;
    const taskTimeRef = ref(raw?.TaskTime);
    const taskTime = taskTimeRef ? taskTimeMap.get(taskTimeRef) : null;

    const start = parseIfcDate(taskTime?.ScheduleStart);
    const end = parseIfcDate(taskTime?.ScheduleFinish);

    allTasks.set(id, {
      id,
      globalId: str(raw?.GlobalId) ?? "",
      name: str(raw?.Name) ?? "(sem nome)",
      identification: str(raw?.Identification) ?? str(raw?.TaskId) ?? undefined,
      start,
      end,
      taskTimeId: taskTimeRef,
      isMilestone: bool(raw?.IsMilestone),
      predefinedType: enumStr(raw?.PredefinedType),
      children: [],
      productIds: [],
      productGuids: [],
      groupIds: [],
      predecessors: [],
    });
  }

  // ---------- 4) Hierarquia via IfcRelNests ----------
  // RelatingObject -> [RelatedObjects]; pais sao IfcTask (ou IfcWorkSchedule p/ raizes).
  const childIds = new Set<number>();
  const scheduleChildIds = new Set<number>(); // filhos diretos da IfcWorkSchedule
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELNESTS)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    const parentId = ref(rel?.RelatingObject);
    if (parentId == null) continue;
    const related = arr(rel?.RelatedObjects).map(ref).filter((x): x is number => x != null);

    if (parentId === workScheduleId) {
      for (const rid of related) {
        if (allTasks.has(rid)) scheduleChildIds.add(rid);
      }
      continue;
    }

    const parent = allTasks.get(parentId);
    if (!parent) continue;
    if (parent.nestsRelId == null) parent.nestsRelId = id;
    for (const rid of related) {
      const child = allTasks.get(rid);
      if (!child) continue;
      parent.children.push(child);
      child.parentId = parentId;
      childIds.add(rid);
    }
  }

  // Bonsai / IFC4: a raiz do cronograma liga-se à IfcWorkSchedule por IfcRelAssignsToControl
  // (RelatingControl = schedule, RelatedObjects = IfcTask), não só por IfcRelNests.
  let scheduleControlRelId: number | undefined;
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELASSIGNSTOCONTROL)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    if (!rel) continue;
    const control = ref(rel?.RelatingControl);
    if (control == null || workScheduleId == null || control !== workScheduleId) continue;
    const timeForTask = ref(rel?.TimeForTask);
    for (const rid of refs(rel?.RelatedObjects)) {
      if (!allTasks.has(rid)) continue;
      scheduleChildIds.add(rid);
      if (timeForTask != null) applyScheduleTimeControl(ifcApi, modelId, allTasks, rid, timeForTask);
      if (timeForTask == null && scheduleControlRelId == null) scheduleControlRelId = id;
    }
  }

  // IFC2X3: datas da tarefa vivem em IfcRelAssignsTasks + IfcScheduleTimeControl
  for (const id of idsOfType(ifcApi, modelId, webIfcType("IFCRELASSIGNSTASKS"))) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    if (!rel) continue;
    const timeForTask = ref(rel?.TimeForTask);
    for (const rid of refs(rel?.RelatedObjects)) {
      if (allTasks.has(rid)) {
        scheduleChildIds.add(rid);
        if (timeForTask != null) applyScheduleTimeControl(ifcApi, modelId, allTasks, rid, timeForTask);
      }
    }
  }

  // IfcRelSequence: RelatingProcess = predecessor, RelatedProcess = sucessor
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELSEQUENCE)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    const predId = ref(rel?.RelatingProcess);
    const succId = ref(rel?.RelatedProcess);
    if (predId == null || succId == null) continue;
    const succ = allTasks.get(succId);
    if (!succ || !allTasks.has(predId)) continue;
    const lag = parseSequenceLag(ifcApi, modelId, rel?.TimeLag);
    succ.predecessors.push({
      taskId: predId,
      type: sequenceType(enumStr(rel?.SequenceType)),
      lagDays: lag.days,
      relId: id,
      lagTimeId: lag.lagTimeId,
    });
  }

  // ---------- 5) Task -> Produtos ----------
  // No padrao Bonsai (IfcOpenShell), a relacao 4D usada eh IfcRelAssignsToProduct
  // com semantica INVERTIDA:
  //   RelatingProduct = IfcProduct  (a parede / laje / etc)
  //   RelatedObjects  = [IfcTask]   (as tarefas que produzem aquele elemento)
  //
  // Tambem aceitamos IfcRelAssignsToProcess para o caso "padrao" (process -> products).
  // E o caso classico tambem, onde RelatingProduct=task e RelatedObjects=produtos.
  const linkProductToTask = (taskId: number, productExpressId: number) => {
    const task = allTasks.get(taskId);
    if (!task) return;
    let obj: any;
    try {
      obj = safeLine(ifcApi, modelId, productExpressId);
    } catch {
      return;
    }
    const guid = str(obj?.GlobalId);
    if (!guid) return;
    // Filtra apenas IfcProduct (tem ObjectPlacement), ignora resources/processos
    if (obj?.ObjectPlacement === undefined && obj?.Representation === undefined) return;
    task.productIds.push(productExpressId);
    task.productGuids.push(guid);
  };

  // (a) IfcRelAssignsToProduct (formato Bonsai 4D)
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELASSIGNSTOPRODUCT)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    const productId = ref(rel?.RelatingProduct);
    const related = arr(rel?.RelatedObjects).map(ref).filter((x): x is number => x != null);
    if (productId == null || related.length === 0) continue;

    // Bonsai/4D: RelatingProduct = produto 3D, RelatedObjects = tasks
    // Caso classico:  RelatingProduct = task, RelatedObjects = produtos
    const productIsTask = allTasks.has(productId);
    if (productIsTask) {
      // forma classica: produto = task, related = produtos 3D
      for (const rid of related) linkProductToTask(productId, rid);
    } else {
      // forma Bonsai: produto = 3D, related = tasks
      for (const rid of related) linkProductToTask(rid, productId);
    }
  }

  const groups = extractSelectionGroups(ifcApi, modelId, allTasks);

  // (b) IfcRelAssignsToProcess (forma padrao: process -> products OU IfcGroup)
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELASSIGNSTOPROCESS)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    const taskId = ref(rel?.RelatingProcess);
    if (taskId == null) continue;
    const objIds = arr(rel?.RelatedObjects)
      .map(ref)
      .filter((x): x is number => x != null);
    const task = allTasks.get(taskId);
    for (const oid of objIds) {
      const group = groups.find((g) => g.id === oid);
      if (group && task) {
        if (!task.groupIds.includes(oid)) task.groupIds.push(oid);
        if (!group.taskIds.includes(taskId)) group.taskIds.push(taskId);
        continue;
      }
      linkProductToTask(taskId, oid);
    }
  }

  // Deduplica produtos por task (pode haver overlap entre as duas relacoes)
  for (const t of allTasks.values()) {
    if (t.productGuids.length === 0) continue;
    const seen = new Set<string>();
    const uniqueGuids: string[] = [];
    const uniqueIds: number[] = [];
    for (let i = 0; i < t.productGuids.length; i++) {
      const g = t.productGuids[i];
      if (seen.has(g)) continue;
      seen.add(g);
      uniqueGuids.push(g);
      uniqueIds.push(t.productIds[i]);
    }
    t.productGuids = uniqueGuids;
    t.productIds = uniqueIds;
  }

  // ---------- 5b) 5D: IfcCostSchedule / IfcCostItem / IfcCostValue ----------
  const { costScheduleId, currency } = linkCosts(ifcApi, modelId, allTasks);

  // ---------- 6) Roots ----------
  // Preferimos IfcRelNests (workSchedule -> tasks). Se nao houver, tudo o que nao for filho de outra task.
  let roots: Task[] = [];
  if (scheduleChildIds.size > 0) {
    roots = [...scheduleChildIds]
      .map((id) => allTasks.get(id))
      .filter((t): t is Task => !!t && !childIds.has(t.id));
    if (roots.length === 0) {
      roots = [...allTasks.values()].filter((t) => !childIds.has(t.id));
    }
  } else {
    roots = [...allTasks.values()].filter((t) => !childIds.has(t.id));
  }

  // ---------- 7) Datas e produtos agregados (recursivos) ----------
  const productGuidsByTask = new Map<number, string[]>();
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  let leafTaskCount = 0;

  const groupById = new Map(groups.map((g) => [g.id, g]));
  const aggregateGuids = (t: Task): string[] => {
    const set = new Set<string>(t.productGuids);
    for (const gid of t.groupIds) {
      const group = groupById.get(gid);
      if (!group) continue;
      for (const guid of group.productGuids) set.add(guid);
    }
    for (const c of t.children) {
      for (const g of aggregateGuids(c)) set.add(g);
    }
    const all = [...set];
    productGuidsByTask.set(t.id, all);

    const isLeaf = t.children.length === 0;
    if (isLeaf && t.start && t.end) {
      leafTaskCount += 1;
      minTime = Math.min(minTime, t.start.getTime());
      maxTime = Math.max(maxTime, t.end.getTime());
    } else if (t.start) {
      minTime = Math.min(minTime, t.start.getTime());
      if (t.end) maxTime = Math.max(maxTime, t.end.getTime());
    }
    return all;
  };
  for (const r of roots) aggregateGuids(r);

  // Fallback: se nao achamos datas, usa hoje
  if (!isFinite(minTime) || !isFinite(maxTime) || minTime > maxTime) {
    const now = Date.now();
    minTime = now - 30 * 24 * 3600 * 1000;
    maxTime = now + 30 * 24 * 3600 * 1000;
  }

  const workPlanRaw = workPlanId ? (safeLine(ifcApi, modelId, workPlanId) as any) : null;
  const workPlanName = str(workPlanRaw?.Name) ?? str(workPlanRaw?.LongName);
  const documents = extractDocuments(ifcApi, modelId);
  const declaresRelId = findDeclaresRel(ifcApi, modelId, projectId, workPlanId, workScheduleId);
  const aggregatesRelId = findAggregatesRel(ifcApi, modelId, workPlanId, workScheduleId);

  return {
    projectId,
    workPlanId,
    workScheduleId,
    declaresRelId,
    aggregatesRelId,
    scheduleControlRelId,
    name: scheduleName,
    workPlanName,
    documents,
    roots,
    byId: allTasks,
    productGuidsByTask,
    groups,
    minDate: new Date(minTime),
    maxDate: new Date(maxTime),
    leafTaskCount,
    costScheduleId,
    currency,
    georef: extractGeoref(ifcApi, modelId),
  };
}

function extractSelectionGroups(
  ifcApi: WebIFC.IfcAPI,
  modelId: number,
  allTasks: Map<number, Task>,
): SelectionGroup[] {
  const groups = new Map<number, SelectionGroup>();
  const takeGroup = (id: number, raw: any) => {
    if (groups.has(id)) return;
    const objectType = str(raw?.ObjectType) ?? "";
    groups.set(id, {
      id,
      globalId: str(raw?.GlobalId) ?? "",
      name: str(raw?.Name) ?? "(sem nome)",
      objectType,
      productIds: [],
      productGuids: [],
      taskIds: [],
    });
  };

  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCGROUP)) {
    let raw: any;
    try {
      raw = safeLine(ifcApi, modelId, id);
    } catch {
      continue;
    }
    takeGroup(id, raw);
  }

  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELASSIGNSTOGROUP)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    const groupId = ref(rel?.RelatingGroup);
    if (groupId == null) continue;
    if (!groups.has(groupId)) {
      try {
        takeGroup(groupId, safeLine(ifcApi, modelId, groupId));
      } catch {
        continue;
      }
    }
    const group = groups.get(groupId);
    if (!group) continue;
    group.assignRelId = id;
    for (const pid of refs(rel?.RelatedObjects)) {
      if (allTasks.has(pid) || groups.has(pid)) continue;
      let obj: any;
      try {
        obj = safeLine(ifcApi, modelId, pid);
      } catch {
        continue;
      }
      const guid = str(obj?.GlobalId);
      if (!guid) continue;
      if (obj?.ObjectPlacement === undefined && obj?.Representation === undefined) continue;
      if (group.productIds.includes(pid)) continue;
      group.productIds.push(pid);
      group.productGuids.push(guid);
    }
  }

  const out: SelectionGroup[] = [];
  for (const g of groups.values()) {
    const ours = g.objectType === VISTA4D_SET_TYPE;
    if (!ours && g.productGuids.length === 0) continue;
    out.push(g);
  }
  return out;
}

function sequenceType(raw?: string): "FS" | "SS" | "FF" | "SF" {
  const s = (raw || "").toUpperCase().replace(/\./g, "");
  if (s.includes("START_START") || s === "SS") return "SS";
  if (s.includes("FINISH_FINISH") || s === "FF") return "FF";
  if (s.includes("START_FINISH") || s === "SF") return "SF";
  return "FS";
}

function parseSequenceLag(
  ifcApi: WebIFC.IfcAPI,
  modelId: number,
  timeLag: any,
): { days?: number; lagTimeId?: number } {
  if (timeLag == null || timeLag === "") return {};
  const asNumber = monetary(timeLag) ?? intVal(timeLag);
  if (asNumber != null && Number.isFinite(asNumber)) {
    return { days: timeMeasureToDays(asNumber) };
  }
  const iso = str(timeLag);
  if (iso) {
    const days = parseSignedDurationDays(iso);
    if (days != null) return { days };
  }
  const lagTimeId = ref(timeLag);
  if (lagTimeId == null) return {};
  const lag = safeLine(ifcApi, modelId, lagTimeId);
  if (!lag) return { lagTimeId };
  const days = parseLagValue(lag?.LagValue);
  return { days, lagTimeId };
}

function parseLagValue(v: any): number | undefined {
  if (v == null || v === "") return undefined;
  const asNumber = monetary(v) ?? intVal(v);
  if (asNumber != null && Number.isFinite(asNumber)) return timeMeasureToDays(asNumber);
  const iso = str(v);
  if (iso) return parseSignedDurationDays(iso);
  if (v && typeof v === "object") {
    const nested = str(v.value) ?? str(v.wrappedValue);
    if (nested) return parseSignedDurationDays(nested);
  }
  return undefined;
}

function parseSignedDurationDays(raw: string): number | undefined {
  const s = raw.trim().toUpperCase();
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  if (!body.startsWith("P")) return undefined;
  const day = /P(?:(\d+(?:\.\d+)?)D)?/.exec(body);
  const n = day?.[1] ? Number(day[1]) : undefined;
  if (n == null || !Number.isFinite(n)) return undefined;
  return neg ? -n : n;
}

function timeMeasureToDays(n: number): number {
  if (Math.abs(n) >= 3600) return Math.round(n / 86400);
  return Math.round(n);
}

function webIfcType(name: string): number | undefined {
  const v = (WebIFC as unknown as Record<string, unknown>)[name];
  return typeof v === "number" ? v : undefined;
}

function applyScheduleTimeControl(
  ifcApi: WebIFC.IfcAPI,
  modelId: number,
  allTasks: Map<number, Task>,
  taskId: number,
  stcId: number,
): void {
  const task = allTasks.get(taskId);
  if (!task) return;
  const stc = safeLine(ifcApi, modelId, stcId);
  if (!stc) return;
  const start = parseDateTimeSelect(ifcApi, modelId, stc.ScheduleStart);
  const end = parseDateTimeSelect(ifcApi, modelId, stc.ScheduleFinish);
  if (start) task.start = start;
  if (end) task.end = end;
  if (task.taskTimeId == null) task.taskTimeId = stcId;
}

function findDeclaresRel(
  ifcApi: WebIFC.IfcAPI,
  modelId: number,
  projectId?: number,
  workPlanId?: number,
  workScheduleId?: number,
): number | undefined {
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELDECLARES)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    const ctx = ref(rel?.RelatingContext);
    if (projectId != null && ctx !== projectId) continue;
    const related = refs(rel?.RelatedDefinitions);
    if (
      (workPlanId != null && related.includes(workPlanId)) ||
      (workScheduleId != null && related.includes(workScheduleId)) ||
      (workPlanId == null && workScheduleId == null && ctx === projectId)
    ) {
      return id;
    }
  }
  return undefined;
}

function findAggregatesRel(
  ifcApi: WebIFC.IfcAPI,
  modelId: number,
  workPlanId?: number,
  workScheduleId?: number,
): number | undefined {
  if (workPlanId == null || workScheduleId == null) return undefined;
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELAGGREGATES)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    if (ref(rel?.RelatingObject) !== workPlanId) continue;
    if (refs(rel?.RelatedObjects).includes(workScheduleId)) return id;
  }
  return undefined;
}

function extractDocuments(ifcApi: WebIFC.IfcAPI, modelId: number): import("./types").IfcAssociatedDocument[] {
  const out: import("./types").IfcAssociatedDocument[] = [];
  const seen = new Set<string>();

  const push = (raw: any) => {
    const name = str(raw?.Name) ?? str(raw?.Identification) ?? "";
    const identification = str(raw?.Identification);
    const location = str(raw?.Location) ?? str(raw?.ItemReference);
    const description = str(raw?.Description) ?? str(raw?.Purpose);
    const key = `${name}|${location ?? ""}|${identification ?? ""}`;
    if (seen.has(key)) return;
    const untitled = !name || /^untitled$/i.test(name) || name === "A01";
    if (untitled && !location) return;
    seen.add(key);
    out.push({
      name: name || location || "Documento IFC",
      identification,
      location,
      description,
    });
  };

  for (const type of [WebIFC.IFCDOCUMENTINFORMATION, WebIFC.IFCDOCUMENTREFERENCE]) {
    for (const id of idsOfType(ifcApi, modelId, type)) {
      try {
        push(safeLine(ifcApi, modelId, id));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/**
 * Hierarquia 5D nativa (IFC4):
 *   IfcCostSchedule  ->  IfcCostItem (IfcRelNests / IfcRelAssignsToControl)
 *   IfcCostItem.CostValues  ->  IfcCostValue.AppliedValue (IfcMonetaryMeasure)
 *   Ligação à tarefa: IfcRelAssignsToControl
 *     RelatingControl = IfcCostItem
 *     RelatedObjects  = IfcTask (ou IfcProduct)
 */
function linkCosts(
  ifcApi: WebIFC.IfcAPI,
  modelId: number,
  allTasks: Map<number, Task>,
): { costScheduleId?: number; currency: string } {
  const costScheduleIds = idsOfType(ifcApi, modelId, WebIFC.IFCCOSTSCHEDULE);
  const costScheduleId = costScheduleIds[0];

  const costValueMap = new Map<number, any>();
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCCOSTVALUE)) {
    costValueMap.set(id, safeLine(ifcApi, modelId, id));
  }

  type CostOwn = { amount: number; valueId?: number; breakdown: boolean };
  const costItemOwn = new Map<number, CostOwn>();
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCCOSTITEM)) {
    const raw = safeLine(ifcApi, modelId, id) as any;
    const valueIds = refs(raw?.CostValues);
    let amount = 0;
    let valueId: number | undefined;
    let starAmount: number | undefined;
    let starValueId: number | undefined;
    for (const vid of valueIds) {
      const cv = costValueMap.get(vid);
      const a = amountOfCostValue(cv, costValueMap, new Set());
      if (a == null) continue;
      const cat = str(cv?.Category);
      if (cat === "*") {
        starAmount = a;
        starValueId = vid;
        continue;
      }
      amount += a;
      if (valueId == null) valueId = vid;
    }
    if (starAmount != null) {
      costItemOwn.set(id, {
        amount: starAmount,
        valueId: starValueId,
        breakdown: valueIds.length > 1,
      });
    } else {
      costItemOwn.set(id, {
        amount,
        valueId: valueIds.length === 1 ? valueId : undefined,
        breakdown: valueIds.length > 1,
      });
    }
  }

  const costChildren = new Map<number, number[]>();
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELNESTS)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    const parentId = ref(rel?.RelatingObject);
    if (parentId == null || !costItemOwn.has(parentId)) continue;
    const kids = refs(rel?.RelatedObjects).filter((rid) => costItemOwn.has(rid));
    if (kids.length) costChildren.set(parentId, kids);
  }

  const amountOfItem = (id: number): number => {
    const own = costItemOwn.get(id);
    if (own && (own.amount !== 0 || own.valueId != null)) return own.amount;
    const kids = costChildren.get(id) ?? [];
    return kids.reduce((s, k) => s + amountOfItem(k), 0);
  };

  const assignToTask = (taskId: number, costItemId: number) => {
    const task = allTasks.get(taskId);
    if (!task || task.costItemId != null) return;
    const own = costItemOwn.get(costItemId);
    task.costItemId = costItemId;
    task.costValueId = own?.valueId;
    task.costIsBreakdown = own?.breakdown;
    const amount = amountOfItem(costItemId);
    if (amount !== 0 || own?.valueId != null || own?.breakdown) task.cost = amount;
  };

  const tasksByProductId = new Map<number, number[]>();
  for (const t of allTasks.values()) {
    for (const pid of t.productIds) {
      const list = tasksByProductId.get(pid);
      if (list) list.push(t.id);
      else tasksByProductId.set(pid, [t.id]);
    }
  }

  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELASSIGNSTOCONTROL)) {
    const rel = safeLine(ifcApi, modelId, id) as any;
    const control = ref(rel?.RelatingControl);
    if (control == null) continue;
    const related = refs(rel?.RelatedObjects);
    if (related.length === 0) continue;

    if (costItemOwn.has(control)) {
      for (const rid of related) {
        if (allTasks.has(rid)) {
          assignToTask(rid, control);
          continue;
        }
        const candidates = tasksByProductId.get(rid);
        if (!candidates?.length) continue;
        const leaves = candidates.filter((tid) => allTasks.get(tid)!.children.length === 0);
        const pick = (leaves.length ? leaves : candidates).find((tid) => allTasks.get(tid)!.costItemId == null);
        if (pick != null) assignToTask(pick, control);
      }
    }
  }

  let currency = "BRL";
  const monetaryUnitType = (WebIFC as typeof WebIFC & { IFCMONETARYUNIT?: number }).IFCMONETARYUNIT;
  if (typeof monetaryUnitType === "number") {
    for (const id of idsOfType(ifcApi, modelId, monetaryUnitType)) {
      const raw = safeLine(ifcApi, modelId, id) as any;
      const c = enumStr(raw?.Currency) ?? str(raw?.Currency);
      if (!c) continue;
      const code = c.replace(/^\./, "").replace(/\.$/, "").toUpperCase();
      if (code) {
        currency = code;
        break;
      }
    }
  }

  return { costScheduleId, currency };
}

// ---------------------------------------------------------------------------
// Helpers de leitura do web-ifc (web-ifc retorna objetos com { type, value }
// para tipos primitivos; refs de entidade vem como { type: 5, value: id })
// ---------------------------------------------------------------------------

function idsOfType(api: WebIFC.IfcAPI, modelId: number, type: number | undefined): number[] {
  if (type == null || !Number.isFinite(type)) return [];
  try {
    const v = api.GetLineIDsWithType(modelId, type);
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) out.push(v.get(i));
    return out;
  } catch {
    return [];
  }
}

/** GetLine pode rebentar se o STEP tiver entidades fora do FILE_SCHEMA (ex. IFC4 num IFC2X3). */
function safeLine(api: WebIFC.IfcAPI, modelId: number, id: number): any | null {
  try {
    return api.GetLine(modelId, id);
  } catch {
    return null;
  }
}

function str(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v.value === "string") return v.value;
  return undefined;
}

function bool(v: any): boolean | undefined {
  if (v == null) return undefined;
  const raw = typeof v.value === "boolean" ? v.value : v;
  if (typeof raw === "string") return raw.toUpperCase() === "T" || raw === "TRUE";
  if (typeof raw === "boolean") return raw;
  return undefined;
}

function enumStr(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v.value === "string") return v.value;
  return undefined;
}

function ref(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  if (typeof v.value === "number") return v.value;
  return undefined;
}

function arr(v: any): any[] {
  if (Array.isArray(v)) return v;
  return [];
}

function refs(v: any): number[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v.map(ref).filter((x): x is number => x != null);
  }
  if (typeof v.size === "function" && typeof v.get === "function") {
    const out: number[] = [];
    for (let i = 0; i < v.size(); i++) {
      const r = ref(v.get(i));
      if (r != null) out.push(r);
    }
    return out;
  }
  const one = ref(v);
  return one != null ? [one] : [];
}

function monetary(v: any): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v._representationValue === "number" && Number.isFinite(v._representationValue)) {
    return v._representationValue;
  }
  if (typeof v._internalValue === "string" || typeof v._internalValue === "number") {
    const n = Number(v._internalValue);
    if (Number.isFinite(n)) return n;
  }
  if (typeof v.value === "number" && Number.isFinite(v.value)) return v.value;
  if (v.value != null && v.value !== v) return monetary(v.value);
  return undefined;
}

function amountOfCostValue(
  cv: any,
  costValueMap: Map<number, any>,
  seen: Set<number>,
): number | undefined {
  if (cv == null) return undefined;
  const direct = monetary(cv.AppliedValue);
  if (direct != null) return direct;
  const expressId = typeof cv.expressID === "number" ? cv.expressID : undefined;
  if (expressId != null) {
    if (seen.has(expressId)) return undefined;
    seen.add(expressId);
  }
  const parts: number[] = [];
  for (const cid of refs(cv.Components)) {
    const child = costValueMap.get(cid);
    const n = amountOfCostValue(child, costValueMap, seen);
    if (n != null) parts.push(n);
  }
  if (parts.length === 0) return undefined;
  const op = enumStr(cv.ArithmeticOperator);
  if (op === "MULTIPLY") return parts.reduce((a, b) => a * b, 1);
  if (op === "SUBTRACT") return parts.slice(1).reduce((a, b) => a - b, parts[0]);
  if (op === "DIVIDE") {
    return parts.slice(1).reduce((a, b) => (b === 0 ? a : a / b), parts[0]);
  }
  return parts.reduce((a, b) => a + b, 0);
}

function parseIfcDate(v: any): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  // Formato ISO 8601 "YYYY-MM-DDTHH:MM:SS" (ou com timezone) - new Date resolve
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function intVal(v: any): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v.value === "number" && Number.isFinite(v.value)) return v.value;
  if (typeof v.value === "string") {
    const n = Number(v.value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function parseDateTimeSelect(api: WebIFC.IfcAPI, modelId: number, v: any): Date | undefined {
  const iso = parseIfcDate(v);
  if (iso) return iso;
  const id = ref(v);
  const line = id != null ? safeLine(api, modelId, id) : v && typeof v === "object" ? v : null;
  if (!line) return undefined;

  const nested = line.DateComponent;
  const nestedId = ref(nested);
  const cal =
    nestedId != null
      ? safeLine(api, modelId, nestedId)
      : nested && typeof nested === "object"
        ? nested
        : line;
  const year = intVal(cal?.YearComponent);
  const month = intVal(cal?.MonthComponent);
  const day = intVal(cal?.DayComponent);
  if (year == null || month == null || day == null) return undefined;

  let hour = 0;
  let minute = 0;
  let second = 0;
  const timeId = ref(line.TimeComponent);
  const timeObj = timeId != null ? safeLine(api, modelId, timeId) : line.TimeComponent;
  if (timeObj && typeof timeObj === "object") {
    hour = intVal(timeObj.HourComponent) ?? 0;
    minute = intVal(timeObj.MinuteComponent) ?? 0;
    second = intVal(timeObj.SecondComponent) ?? 0;
  }
  return new Date(year, month - 1, day, hour, minute, second);
}
