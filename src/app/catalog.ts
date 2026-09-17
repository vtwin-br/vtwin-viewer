/**
 * Catálogo de módulos da Vista 4D.
 *
 * A aplicação é um shell: cada entrada de 1.º nível é um domínio
 * e cada entrada de 2.º nível é uma ferramenta com o seu workspace.
 * Ferramentas novas entram aqui — o menu lateral é gerado a partir desta lista.
 *
 * `placeholder: true` = módulo no menu, ainda sem UI de trabalho.
 */

export type WorkspaceId =
  | "dashboard"
  | "viewer"
  | "docs"
  | "schedule-4d"
  | "project-plan"
  | "logistics"
  | "coordination"
  | "editor";

export type WorkspaceShell = "schedule" | "plan" | "logistics" | "placeholder";

export type NavIconId =
  | "dashboard"
  | "viewer"
  | "docs"
  | "planning"
  | "schedule4d"
  | "projectPlan"
  | "logistics"
  | "coordination"
  | "editor"
  | "collapse"
  | "expand";

export interface AppTool {
  id: string;
  label: string;
  description: string;
  workspace: WorkspaceId;
  icon: NavIconId;
  /** Sem ecrã de trabalho — só o sítio no menu. */
  placeholder?: boolean;
}

export interface AppModule {
  id: string;
  label: string;
  description: string;
  icon: NavIconId;
  tools: AppTool[];
}

export const APP_MODULES: AppModule[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Indicadores e interação com o modelo 3D",
    icon: "dashboard",
    tools: [
      {
        id: "dashboard",
        label: "Dashboard",
        description: "Indicadores e interação com o modelo 3D",
        workspace: "dashboard",
        icon: "dashboard",
        placeholder: true,
      },
    ],
  },
  {
    id: "viewer",
    label: "Visualizador",
    description: "Vista 3D do modelo IFC",
    icon: "viewer",
    tools: [
      {
        id: "viewer",
        label: "Visualizador",
        description: "Vista 3D do modelo IFC",
        workspace: "viewer",
        icon: "viewer",
        placeholder: true,
      },
    ],
  },
  {
    id: "docs",
    label: "Documentação",
    description: "Documentos, folhas 2D e tabelas no esquema IFC",
    icon: "docs",
    tools: [
      {
        id: "docs",
        label: "Documentação",
        description: "Documentos, folhas 2D e tabelas no esquema IFC",
        workspace: "docs",
        icon: "docs",
        placeholder: true,
      },
    ],
  },
  {
    id: "planning",
    label: "Planejamento",
    description: "Relatório 4D, editor Gantt e logística",
    icon: "planning",
    tools: [
      {
        id: "schedule-4d",
        label: "4D",
        description: "Relatório e simulação do cronograma",
        workspace: "schedule-4d",
        icon: "schedule4d",
      },
      {
        id: "project-plan",
        label: "Gantt",
        description: "Editor do cronograma (IfcTask)",
        workspace: "project-plan",
        icon: "projectPlan",
      },
      {
        id: "logistics",
        label: "Logística",
        description: "Canteiro, limite de intervenção e platô no IFC",
        workspace: "logistics",
        icon: "logistics",
      },
    ],
  },
  {
    id: "coordination",
    label: "Coordenação",
    description: "BCF, clash e coordenação de modelos",
    icon: "coordination",
    tools: [
      {
        id: "coordination",
        label: "Coordenação",
        description: "BCF, clash e coordenação de modelos",
        workspace: "coordination",
        icon: "coordination",
        placeholder: true,
      },
    ],
  },
  {
    id: "editor",
    label: "Editor",
    description: "Modelagem e edição geométrica IFC",
    icon: "editor",
    tools: [
      {
        id: "editor",
        label: "Editor",
        description: "Modelagem e edição geométrica IFC",
        workspace: "editor",
        icon: "editor",
        placeholder: true,
      },
    ],
  },
];

export const DEFAULT_WORKSPACE: WorkspaceId = "schedule-4d";

export const ALL_WORKSPACES: WorkspaceId[] = APP_MODULES.flatMap((m) => m.tools.map((t) => t.workspace));

export function isWorkspaceId(v: string | null | undefined): v is WorkspaceId {
  return typeof v === "string" && (ALL_WORKSPACES as string[]).includes(v);
}

export function workspaceShell(id: WorkspaceId): WorkspaceShell {
  if (id === "schedule-4d") return "schedule";
  if (id === "project-plan") return "plan";
  if (id === "logistics") return "logistics";
  return "placeholder";
}

export function workspaceHasEarth(id: WorkspaceId): boolean {
  const shell = workspaceShell(id);
  return shell === "schedule" || shell === "logistics";
}

export function findTool(toolId: string): AppTool | undefined {
  for (const mod of APP_MODULES) {
    const tool = mod.tools.find((t) => t.id === toolId);
    if (tool) return tool;
  }
  return undefined;
}

export function findToolByWorkspace(id: WorkspaceId): AppTool | undefined {
  for (const mod of APP_MODULES) {
    const tool = mod.tools.find((t) => t.workspace === id);
    if (tool) return tool;
  }
  return undefined;
}

export function findModuleByWorkspace(id: WorkspaceId): AppModule | undefined {
  return APP_MODULES.find((m) => m.tools.some((t) => t.workspace === id));
}
