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
}
