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
  | "site-plan"
  | "coordination"
  | "editor";

export type WorkspaceShell =
  | "schedule"
  | "plan"
  | "logistics"
  | "site"
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
  | "limit"
  | "coordination"
  | "editor"
  | "collapse"
  | "expand";

export interface AppTool {
  id: string;
  label: string;
  description: string;
  /** Linha curta no menu. */
  hint?: string;
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
  /** Fora do menu principal. O workspace continua a existir. */
  nav?: boolean;
  /** Grupo sempre aberto: o trabalho de planejamento não se esconde. */
  pinned?: boolean;
}

export const APP_MODULES: AppModule[] = [
  {
    id: "planning",
    label: "Planejamento",
    description: "Logística do canteiro, simulação 4D e cronograma",
    icon: "planning",
    pinned: true,
    tools: [
      {
        id: "schedule-4d",
        label: "4D",
        hint: "Reproduzir a obra",
        description: "Simulação do cronograma no modelo",
        workspace: "schedule-4d",
        icon: "schedule4d",
      },
      {
        id: "project-plan",
        label: "Gantt",
        hint: "Sequência das tarefas",
        description: "Editor do cronograma (IfcTask)",
        workspace: "project-plan",
        icon: "projectPlan",
      },
      {
        id: "site-plan",
        label: "Logística",
        hint: "Equipamentos e quantidades",
        description: "Guindaste, caminho, terreno e anotação no plano de obra",
        workspace: "site-plan",
        icon: "logistics",
      },
    ],
  },
  {
    id: "site-limit",
    label: "Limite",
    description: "Limite de intervenção e platô no IFC",
    icon: "limit",
    nav: false,
    tools: [
      {
        id: "logistics",
        label: "Limite",
        description: "Limite de intervenção e platô no IFC",
        workspace: "logistics",
        icon: "limit",
      },
    ],
  },
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Indicadores calculados sobre o IFC e interação 3D",
    icon: "dashboard",
    nav: false,
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
    nav: false,
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
    nav: false,
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
    id: "coordination",
    label: "Coordenação",
    description: "Interferências IfcRelInterferesElements",
    icon: "coordination",
    nav: false,
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
    nav: false,
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

/** O que o menu principal mostra. */
export function navModules(): AppModule[] {
  return APP_MODULES.filter((mod) => mod.nav !== false);
}

export function isNavWorkspace(id: WorkspaceId): boolean {
  return navModules().some((mod) => mod.tools.some((tool) => tool.workspace === id));
}

export const DEFAULT_WORKSPACE: WorkspaceId = "site-plan";

export const ALL_WORKSPACES: WorkspaceId[] = APP_MODULES.flatMap((m) => m.tools.map((t) => t.workspace));

export function isWorkspaceId(v: string | null | undefined): v is WorkspaceId {
  return typeof v === "string" && (ALL_WORKSPACES as string[]).includes(v);
}

export function workspaceShell(id: WorkspaceId): WorkspaceShell {
  if (id === "schedule-4d") return "schedule";
  if (id === "project-plan") return "plan";
  if (id === "logistics") return "logistics";
  if (id === "site-plan") return "site";
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
  return shell === "schedule" || shell === "logistics" || shell === "site";
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
