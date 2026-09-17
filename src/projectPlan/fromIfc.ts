import { diffDays } from "./dates";
import { finalizePlan, uid } from "./buildPlan";
import type { PlanTask, ProjectPlan } from "./types";
import type { ScheduleData, Task } from "../schedule/types";
import type { OutlineRowInput } from "../ifc/scheduleWrite";

/** Converte o IfcWorkSchedule nativo numa lista plana tipo Project, já ligada aos produtos 3D. */
export function scheduleToPlan(schedule: ScheduleData, ifcFileName?: string): ProjectPlan {
  const tasks: PlanTask[] = [];
  const walk = (nodes: Task[], level: number) => {
    for (const t of nodes) {
      const duration =
        t.start && t.end ? Math.max(0, diffDays(t.start, t.end)) : t.isMilestone ? 0 : undefined;
      tasks.push({
        id: t.isFederationRoot ? `ifc-file-${t.sourceModelId ?? t.id}` : `ifc-${t.id}`,
        name: t.name,
        outlineLevel: level,
        wbs: t.identification,
        start: t.start,
        end: t.end,
        durationDays: duration,
        progress: 0,
        isMilestone: !!t.isMilestone,
        isSummary: t.children.length > 0,
        collapsed: false,
        predecessors: (t.predecessors ?? []).map((p) => ({
          id: `ifc-${p.taskId}`,
          type: p.type,
          lagDays: p.lagDays,
        })),
        cost: t.cost,
        linkedIfcTaskId: t.id,
        linkedProductGuids: [...(schedule.productGuidsByTask.get(t.id) ?? t.productGuids)],
        linkedGroupIds: [...(t.groupIds ?? [])],
        linkedGroupNames: (t.groupIds ?? [])
          .map((id) => schedule.groups.find((g) => g.id === id)?.name)
          .filter((n): n is string => !!n),
      });
      walk(t.children, level + 1);
    }
  };
  walk(schedule.roots, 1);

  const attachments = schedule.documents.map((d) => ({
    id: uid("att"),
    name: d.name,
    mime: "application/octet-stream",
    size: 0,
    kind: "document" as const,
    addedAt: new Date(),
    note: d.location
      ? `IfcDocumentReference · ${d.location}`
      : "Associado ao IFC (IfcRelAssociatesDocument)",
  }));

  const name = schedule.name || schedule.workPlanName || "Cronograma IFC";
  return finalizePlan({
    id: uid("plan"),
    name,
    tasks,
    attachments,
    sourceLabel: ifcFileName,
    sourceKind: "ifc",
  });
}

/** Lista plana do Gantt → linhas para gravar como IfcTask nativas. */
export function planToOutlineRows(plan: ProjectPlan): OutlineRowInput[] {
  const indexById = new Map(plan.tasks.map((t, i) => [t.id, i]));
  return plan.tasks.map((t) => ({
    name: t.name,
    identification: t.wbs,
    start: t.start,
    end: t.end,
    outlineLevel: t.outlineLevel,
    isMilestone: t.isMilestone,
    cost: t.cost,
    predecessorIndexes: t.predecessors.flatMap((p) => {
      let index = indexById.get(p.id);
      if (index == null && /^\d+$/.test(p.id)) {
        const n = Number(p.id);
        if (n >= 1 && n <= plan.tasks.length) index = n - 1;
      }
      if (index == null || index < 0) return [];
      return [{ index, type: p.type, lagDays: p.lagDays }];
    }),
  }));
}
