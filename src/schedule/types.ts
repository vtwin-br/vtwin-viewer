import type { IfcGeoref } from "../ifc/georef";

export type TaskState = "pending" | "active" | "done";

export interface Task {
  /** ExpressID do IfcTask no IFC. */
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
  /** Subtarefas (via IfcRelNests). */
  children: Task[];
  /** ExpressIDs de IfcProduct associados (via IfcRelAssignsToProcess). */
  productIds: number[];
  /** GlobalIds dos produtos associados. */
  productGuids: string[];
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
}

export interface ScheduleData {
  /** Nome da IfcWorkSchedule (ou WorkPlan). */
  name: string;
  /** Tarefas raiz. */
  roots: Task[];
  /** Mapa de id (expressID do IfcTask) -> Task. */
  byId: Map<number, Task>;
  /** Mapa task.id -> GUIDs dos produtos associados (recursivamente, incluindo filhos). */
  productGuidsByTask: Map<number, string[]>;
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
