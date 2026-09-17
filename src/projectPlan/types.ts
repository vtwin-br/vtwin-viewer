export type PredType = "FS" | "SS" | "FF" | "SF";

export interface PlanPredecessor {
  id: string;
  type: PredType;
  lagDays?: number;
}

export interface PlanTask {
  id: string;
  name: string;
  /** 1 = raiz, 2 = filho, etc. Lista plana como no MS Project. */
  outlineLevel: number;
  wbs?: string;
  start?: Date;
  end?: Date;
  durationDays?: number;
  /** 0–100 */
  progress: number;
  isMilestone: boolean;
  isSummary: boolean;
  collapsed: boolean;
  predecessors: PlanPredecessor[];
  notes?: string;
  /** Custo próprio 5D (IfcCostValue desta IfcTask), sem subtarefas. */
  cost?: number;
  /** ExpressID de IfcTask, quando a tarefa já está ligada ao modelo. */
  linkedIfcTaskId?: number;
  linkedProductGuids: string[];
  /** IfcGroup ligados a esta IfcTask. */
  linkedGroupIds?: number[];
  linkedGroupNames?: string[];
}

export type AttachmentKind = "schedule" | "document";

export interface PlanAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  addedAt: Date;
  /** Aviso se o arquivo foi anexado mas não virou tarefas (ex. .mpp binário). */
  note?: string;
}

export interface ProjectPlan {
  id: string;
  name: string;
  tasks: PlanTask[];
  attachments: PlanAttachment[];
  /** Origem da última importação (nome do arquivo). */
  sourceLabel?: string;
  /** ifc = nasceu do IfcWorkSchedule; import = CSV/XML; blank = criado na UI. */
  sourceKind?: "ifc" | "import" | "blank";
  minDate: Date;
  maxDate: Date;
}

export type ImportKind = "plan" | "attachment" | "unsupported-mpp" | "csv-preview";

export interface ImportResult {
  kind: ImportKind;
  plan?: ProjectPlan;
  attachment?: PlanAttachment;
  message?: string;
  csv?: import("./parseCsv").CsvInspection;
}
