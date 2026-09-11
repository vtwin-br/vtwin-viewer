import { addDays, diffDays, parseFlexibleDate, parseIsoDurationDays } from "./dates";
import { finalizePlan, uid } from "./buildPlan";
import type { PlanPredecessor, PlanTask, PredType, ProjectPlan } from "./types";

const PRED_TYPE: PredType[] = ["FF", "FS", "SF", "SS"];

export function parseMspdi(xml: string, fileName: string): ProjectPlan {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("XML inválido.");
  }
  const project = [...doc.getElementsByTagName("*")].find((n) => n.localName === "Project");
  if (!project) {
    throw new Error("Este XML não é um projeto Microsoft Project (MSPDI).");
  }

  const minutesPerDay = Number(directText(project, "MinutesPerDay") || "480");
  const hoursPerDay = Number.isFinite(minutesPerDay) && minutesPerDay > 0 ? minutesPerDay / 60 : 8;
  const title =
    directText(project, "Title") ||
    directText(project, "Name") ||
    fileName.replace(/\.(xml|mpp)$/i, "") ||
    "Planejamento importado";

  const taskEls = [...project.getElementsByTagName("*")].filter(
    (n) => n.localName === "Task" && n.parentElement?.localName === "Tasks",
  );

  const tasks: PlanTask[] = [];
  const uidToId = new Map<string, string>();

  for (const el of taskEls) {
    if (directText(el, "IsNull") === "1") continue;
    const mspUid = directText(el, "UID");
    if (mspUid === "0" && taskEls.length > 1) {
      // Tarefa 0 é o resumo do projeto — o nome já foi para o título.
      continue;
    }
    const name = directText(el, "Name") || `Tarefa ${mspUid || tasks.length + 1}`;
    const outline = Math.max(1, Number(directText(el, "OutlineLevel") || "1"));
    const start = parseFlexibleDate(directText(el, "Start")) ?? parseFlexibleDate(directText(el, "ManualStart"));
    const end = parseFlexibleDate(directText(el, "Finish")) ?? parseFlexibleDate(directText(el, "ManualFinish"));
    const durationRaw = directText(el, "Duration");
    const duration = durationRaw ? parseIsoDurationDays(durationRaw, hoursPerDay) : undefined;
    const milestone = directText(el, "Milestone") === "1";
    const pct = Number(directText(el, "PercentComplete") || "0");
    const wbs = directText(el, "WBS") || directText(el, "OutlineNumber") || undefined;
    const id = uid();
    if (mspUid) uidToId.set(mspUid, id);

    const predecessors: PlanPredecessor[] = [];
    for (const link of [...el.getElementsByTagName("*")].filter((n) => n.localName === "PredecessorLink")) {
      const predUid = directText(link, "PredecessorUID");
      if (!predUid) continue;
      const typeIdx = Number(directText(link, "Type") || "1");
      predecessors.push({
        id: predUid,
        type: PRED_TYPE[typeIdx] ?? "FS",
      });
    }

    const task: PlanTask = {
      id,
      name,
      outlineLevel: outline,
      wbs,
      start,
      end,
      durationDays: duration,
      progress: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0,
      isMilestone: milestone,
      isSummary: directText(el, "Summary") === "1",
      collapsed: false,
      predecessors,
      linkedProductGuids: [],
    };
    if (!task.end && task.start && task.durationDays != null) {
      task.end = addDays(task.start, task.isMilestone ? 0 : task.durationDays);
    }
    if (task.start && task.end && task.durationDays == null) {
      task.durationDays = Math.max(0, diffDays(task.start, task.end));
    }
    tasks.push(task);
  }

  if (tasks.length === 0) throw new Error("O XML do Project não contém tarefas.");

  for (const t of tasks) {
    t.predecessors = t.predecessors.map((p) => ({
      ...p,
      id: uidToId.get(p.id) ?? p.id,
    }));
  }

  return finalizePlan({
    id: uid("plan"),
    name: title,
    tasks,
    attachments: [],
    sourceLabel: fileName,
    sourceKind: "import",
  });
}

function directText(el: Element, localName: string): string {
  for (const child of el.children) {
    if (child.localName === localName) return (child.textContent || "").trim();
  }
  return "";
}
