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

export type WorkspaceShell =
  | "schedule"
  | "plan"
  | "logistics"
  | "dashboard"
  | "viewer"
  | "docs"
  | "editor"
  | "coordination"
  | "placeholder";

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
    description: "Indicadores calculados sobre o IFC e interação 3D",
    icon: "dashboard",
    tools: [
      {
        id: "dashboard",
        label: "Dashboard",
        description: "Indicadores calculados sobre o cronograma, o custo e as ligações 3D",
        workspace: "dashboard",
        icon: "dashboard",
      },
    ],
  },
  {
    id: "viewer",
    label: "Visualizador",
    description: "Vista 3D do viewport já aberto",
    icon: "viewer",
    tools: [
      {
        id: "viewer",
        label: "Visualizador",
        description: "Vista 3D do modelo IFC já aberto",
        workspace: "viewer",
        icon: "viewer",
      },
    ],
  },
  {
    id: "docs",
    label: "Documentação",
    description: "Documentos, folhas 2D e tabelas IFC",
    icon: "docs",
    tools: [
      {
        id: "docs",
        label: "Documentação",
        description: "IfcDocumentReference, folhas e IfcTable no mesmo IFC",
        workspace: "docs",
        icon: "docs",
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
    description: "Interferências IfcRelInterferesElements",
    icon: "coordination",
    tools: [
      {
        id: "coordination",
        label: "Coordenação",
        description: "Interferências gravadas como IfcRelInterferesElements",
        workspace: "coordination",
        icon: "coordination",
      },
    ],
  },
  {
    id: "editor",
    label: "Editor",
    description: "Propriedades, classificação e estrutura espacial",
    icon: "editor",
    tools: [
      {
        id: "editor",
        label: "Editor",
        description: "Propriedades, classificação, árvore espacial e search sets",
        workspace: "editor",
        icon: "editor",
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
  if (
    id === "dashboard" ||
    id === "viewer" ||
    id === "docs" ||
    id === "editor" ||
    id === "coordination"
  ) {
    return id;
  }
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
