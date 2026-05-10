import * as WebIFC from "web-ifc";
import type { ScheduleData, Task } from "./types";

/**
 * Le o IFC com web-ifc (instancia dedicada) e extrai a estrutura de cronograma:
 *
 *  - IfcWorkSchedule (raiz)
 *  - IfcTask  +  IfcRelNests  ->  hierarquia
 *  - IfcTaskTime  ->  ScheduleStart / ScheduleFinish
 *  - IfcRelAssignsToProcess  ->  task -> produtos 3D
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
  };
}

// ---------------------------------------------------------------------------
// Helpers de leitura do web-ifc (web-ifc retorna objetos com { type, value }
// para tipos primitivos; refs de entidade vem como { type: 5, value: id })
// ---------------------------------------------------------------------------

function idsOfType(api: WebIFC.IfcAPI, modelId: number, type: number): number[] {
  const v = api.GetLineIDsWithType(modelId, type);
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  return out;
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

function parseIfcDate(v: any): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  // Formato ISO 8601 "YYYY-MM-DDTHH:MM:SS" (ou com timezone) - new Date resolve
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}
