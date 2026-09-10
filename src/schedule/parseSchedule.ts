import * as WebIFC from "web-ifc";
import { extractGeoref } from "../ifc/georef";
import type { ScheduleData, Task } from "./types";

/**
 * Le o IFC com web-ifc (instancia dedicada) e extrai a estrutura de cronograma:
 *
 *  - IfcWorkSchedule (raiz 4D)
 *  - IfcTask  +  IfcRelNests  ->  hierarquia
 *  - IfcTaskTime  ->  ScheduleStart / ScheduleFinish
 *  - IfcRelAssignsToProcess  ->  task -> produtos 3D
 *  - IfcCostSchedule / IfcCostItem / IfcCostValue  ->  5D
 *  - IfcRelAssignsToControl  ->  IfcCostItem <-> IfcTask (ou produto)
 *
 * Espelha a forma como o Bonsai (BlenderBIM) escreve cronogramas em IFC4.
 */
export async function parseSchedule(
  buffer: Uint8Array,
  wasmPath: string,
): Promise<ScheduleData> {
  const ifcApi = new WebIFC.IfcAPI();
  ifcApi.SetWasmPath(wasmPath, true);
  await ifcApi.Init();

  const modelId = ifcApi.OpenModel(buffer);

  try {
    return extract(ifcApi, modelId);
  } finally {
    ifcApi.CloseModel(modelId);
  }
}

function extract(ifcApi: WebIFC.IfcAPI, modelId: number): ScheduleData {
  // ---------- 1) IfcWorkSchedule (escolhe a primeira) ----------
  const scheduleIds = idsOfType(ifcApi, modelId, WebIFC.IFCWORKSCHEDULE);
  const workScheduleId = scheduleIds[0];
  const workSchedule = workScheduleId
    ? (ifcApi.GetLine(modelId, workScheduleId) as any)
    : null;
  const scheduleName: string =
    str(workSchedule?.Name) ?? str(workSchedule?.LongName) ?? "Cronograma";

  // ---------- 2) Mapa de IfcTaskTime por expressID ----------
  const taskTimeMap = new Map<number, any>();
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCTASKTIME)) {
    taskTimeMap.set(id, ifcApi.GetLine(modelId, id));
  }

  // ---------- 3) Todas as IfcTask (cria objetos base) ----------
  const allTasks = new Map<number, Task>();
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCTASK)) {
    const raw = ifcApi.GetLine(modelId, id) as any;
    const taskTimeRef = ref(raw?.TaskTime);
    const taskTime = taskTimeRef ? taskTimeMap.get(taskTimeRef) : null;

    const start = parseIfcDate(taskTime?.ScheduleStart);
    const end = parseIfcDate(taskTime?.ScheduleFinish);

    allTasks.set(id, {
      id,
      globalId: str(raw?.GlobalId) ?? "",
      name: str(raw?.Name) ?? "(sem nome)",
      identification: str(raw?.Identification) ?? undefined,
      start,
      end,
      taskTimeId: taskTimeRef,
      isMilestone: bool(raw?.IsMilestone),
      predefinedType: enumStr(raw?.PredefinedType),
      children: [],
      productIds: [],
      productGuids: [],
    });
  }

  // ---------- 4) Hierarquia via IfcRelNests ----------
  // RelatingObject -> [RelatedObjects]; pais sao IfcTask (ou IfcWorkSchedule p/ raizes).
  const childIds = new Set<number>();
  const scheduleChildIds = new Set<number>(); // filhos diretos da IfcWorkSchedule
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELNESTS)) {
    const rel = ifcApi.GetLine(modelId, id) as any;
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
    for (const rid of related) {
      const child = allTasks.get(rid);
      if (!child) continue;
      parent.children.push(child);
      childIds.add(rid);
    }
  }

  // Tambem alguns exporters usam IfcRelAggregates para a raiz - vamos ignorar por enquanto.

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
      obj = ifcApi.GetLine(modelId, productExpressId);
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
    const rel = ifcApi.GetLine(modelId, id) as any;
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

  // (b) IfcRelAssignsToProcess (forma padrao, caso o IFC tambem tenha)
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCRELASSIGNSTOPROCESS)) {
    const rel = ifcApi.GetLine(modelId, id) as any;
    const taskId = ref(rel?.RelatingProcess);
    if (taskId == null) continue;
    const objIds = arr(rel?.RelatedObjects)
      .map(ref)
      .filter((x): x is number => x != null);
    for (const oid of objIds) linkProductToTask(taskId, oid);
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
      .filter((t): t is Task => !!t);
  } else {
    roots = [...allTasks.values()].filter((t) => !childIds.has(t.id));
  }

  // ---------- 7) Datas e produtos agregados (recursivos) ----------
  const productGuidsByTask = new Map<number, string[]>();
  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  let leafTaskCount = 0;

  const aggregateGuids = (t: Task): string[] => {
    const set = new Set<string>(t.productGuids);
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

  return {
    name: scheduleName,
    roots,
    byId: allTasks,
    productGuidsByTask,
    minDate: new Date(minTime),
    maxDate: new Date(maxTime),
    leafTaskCount,
    costScheduleId,
    currency,
    georef: extractGeoref(ifcApi, modelId),
  };
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
    costValueMap.set(id, ifcApi.GetLine(modelId, id));
  }

  type CostOwn = { amount: number; valueId?: number; breakdown: boolean };
  const costItemOwn = new Map<number, CostOwn>();
  for (const id of idsOfType(ifcApi, modelId, WebIFC.IFCCOSTITEM)) {
    const raw = ifcApi.GetLine(modelId, id) as any;
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
    const rel = ifcApi.GetLine(modelId, id) as any;
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
    const rel = ifcApi.GetLine(modelId, id) as any;
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
      const raw = ifcApi.GetLine(modelId, id) as any;
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
