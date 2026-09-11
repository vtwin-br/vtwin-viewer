/**
 * Catálogo de módulos da Vista 4D.
 *
 * A aplicação é um shell: cada entrada de 1.º nível é um domínio
 * (ex. Planejamento e Orçamento) e cada entrada de 2.º nível é uma
 * ferramenta com o seu workspace. Ferramentas novas entram aqui —
 * o menu lateral é gerado a partir desta lista.
 */

export type WorkspaceId = "schedule-4d" | "project-plan";

export interface AppTool {
  id: string;
  label: string;
  description: string;
  workspace: WorkspaceId;
  /** Identificador do ícone em `src/ui/moduleNav.ts`. */
  icon: "schedule4d" | "projectPlan";
}

export interface AppModule {
  id: string;
  label: string;
  description: string;
  icon: "planning";
  tools: AppTool[];
}

export const APP_MODULES: AppModule[] = [
  {
    id: "planning",
    label: "Planejamento e Orçamento",
    description: "Cronograma, Gantt e ligação 4D com o modelo IFC",
    icon: "planning",
    tools: [
      {
        id: "schedule-4d",
        label: "Cronograma 4D",
        description: "Tarefas nativas do IFC",
        workspace: "schedule-4d",
        icon: "schedule4d",
      },
      {
        id: "project-plan",
        label: "Planejamento de projeto",
        description: "Gantt IFC + modelo 3D",
        workspace: "project-plan",
        icon: "projectPlan",
      },
    ],
  },
];

export const DEFAULT_WORKSPACE: WorkspaceId = "schedule-4d";

export function findTool(toolId: string): AppTool | undefined {
  for (const mod of APP_MODULES) {
    const tool = mod.tools.find((t) => t.id === toolId);
    if (tool) return tool;
  }
  return undefined;
}
