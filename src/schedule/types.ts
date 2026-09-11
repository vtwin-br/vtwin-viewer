import type { IfcGeoref } from "../ifc/georef";

export type TaskState = "pending" | "active" | "done";

export interface Task {
  /** ExpressID do IfcTask no IFC, ou id federado na vista com vários modelos. */
  id: number;
  /** GlobalId do IfcTask. */
  globalId: string;
  /** Nome (Name) do IfcTask. */
  name: string;
  /** Identificacao curta (Identification) do IfcTask. */
  identification?: string;
  /** Inicio agendado (IfcTaskTime.ScheduleStart). */
  start?: Date;
  /** Fim agendado (IfcTaskTime.ScheduleFinish). */
  end?: Date;
  /** ExpressID do IfcTaskTime ligado a esta tarefa (se existir). */
  taskTimeId?: number;
  /** Marco (IfcTask.IsMilestone). */
  isMilestone?: boolean;
  /** Tipo de predecessor (PredefinedType). */
  predefinedType?: string;
  /** ExpressID da IfcTask pai (IfcRelNests). Ausente nas raízes do IfcWorkSchedule. */
  parentId?: number;
  /** IfcRelNests em que esta tarefa é RelatingObject (filhos). */
  nestsRelId?: number;
  /** Subtarefas (via IfcRelNests). */
  children: Task[];
  /** ExpressIDs de IfcProduct associados (via IfcRelAssignsToProduct / ToProcess). */
  productIds: number[];
  /** GlobalIds dos produtos associados. */
  productGuids: string[];
  /** ExpressIDs de IfcGroup (conjuntos 4D) ligados a esta tarefa. */
  groupIds: number[];
  /**
   * Custo próprio 5D (IfcCostValue.AppliedValue do IfcCostItem ligado à tarefa).
   * Não inclui subtarefas — use treeCost() para o acumulado da hierarquia.
   */
  cost?: number;
  /** ExpressID do IfcCostItem ligado a esta tarefa. */
  costItemId?: number;
  /** ExpressID do IfcCostValue usado na edição (AppliedValue). */
  costValueId?: number;
  /** True se o IfcCostItem tem várias IfcCostValue (edição grava um total Category '*'). */
  costIsBreakdown?: boolean;
  /** Predecessores (IfcRelSequence). */
  predecessors: Array<{ taskId: number; type: "FS" | "SS" | "FF" | "SF" }>;
  /** Modelo de origem na vista federada (vários IFC). */
  sourceModelId?: string;
  /** Nome do ficheiro IFC de origem (vista federada). */
  sourceFileName?: string;
  /** Pasta visual do ficheiro — não é uma IfcTask. */
  isFederationRoot?: boolean;
}

/** ObjectType gravado nos IfcGroup criados por esta app (selection sets 4D). */
export const VISTA4D_SET_TYPE = "VISTA4D_SET";

/** Conjunto nomeado de elementos 3D — IfcGroup + IfcRelAssignsToGroup. */
export interface SelectionGroup {
  /** ExpressID do IfcGroup. */
  id: number;
  globalId: string;
  name: string;
  objectType: string;
  productIds: number[];
  productGuids: string[];
  /** IfcTask ligadas via IfcRelAssignsToProcess. */
  taskIds: number[];
  /** ExpressID de IfcRelAssignsToGroup, se já existir no ficheiro. */
  assignRelId?: number;
  sourceModelId?: string;
  sourceFileName?: string;
}

/** Documento externo ou interno associado via IfcRelAssociatesDocument. */
export interface IfcAssociatedDocument {
  name: string;
  identification?: string;
  location?: string;
  description?: string;
}

export interface ScheduleData {
  /** ExpressID do IfcProject. */
  projectId?: number;
  /** ExpressID da IfcWorkPlan, se existir. */
  workPlanId?: number;
  /** ExpressID da IfcWorkSchedule, se existir. */
  workScheduleId?: number;
  /** IfcRelDeclares do projeto que inclui o plano/cronograma. */
  declaresRelId?: number;
  /** IfcRelAggregates IfcWorkPlan → IfcWorkSchedule. */
  aggregatesRelId?: number;
  /** IfcRelAssignsToControl IfcWorkSchedule → tarefas raiz. */
  scheduleControlRelId?: number;
  /** Nome da IfcWorkSchedule. */
  name: string;
  /** Nome da IfcWorkPlan, se existir. */
  workPlanName?: string;
  /** IfcDocumentReference / IfcDocumentInformation ligados ao projeto ou ao cronograma. */
  documents: IfcAssociatedDocument[];
  /** Tarefas raiz. */
  roots: Task[];
  /** Mapa de id (expressID do IfcTask) -> Task. */
  byId: Map<number, Task>;
  /** Mapa task.id -> GUIDs dos produtos associados (recursivamente, incluindo filhos e conjuntos). */
  productGuidsByTask: Map<number, string[]>;
  /** Conjuntos 4D nativos (IfcGroup). */
  groups: SelectionGroup[];
  /** Range global do cronograma. */
  minDate: Date;
  maxDate: Date;
  /** Total de tasks-folha com tempo definido. */
  leafTaskCount: number;
  /** ExpressID da IfcCostSchedule (raiz 5D), se existir. */
  costScheduleId?: number;
  /** Código ISO da moeda (IfcMonetaryUnit), ex. BRL. */
  currency: string;
  /** Origem / orientação / CRS da hierarquia IfcProject → IfcSite. */
  georef?: IfcGeoref;
}
