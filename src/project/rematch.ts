import type { ScheduleData, Task } from "../schedule/types";
import { recomputeProductGuidsByTask } from "../schedule/range";

export interface GuidRematchReport {
  matched: number;
  orphans: string[];
  keptTasks: number;
}

export interface RematchOptions {
  /** Mantém GUIDs que não existem neste STEP (ligações 3D noutro ficheiro). */
  keepOrphans?: boolean;
}

/**
 * Recasa productIds pelo GlobalId no índice do IFC novo.
 * GUIDs que já não existem ficam de fora (órfãos), salvo `keepOrphans`.
 */
export function rematchProductGuids(
  schedule: ScheduleData,
  guidToId: Map<string, number>,
  opts?: RematchOptions,
): GuidRematchReport {
  const orphans = new Set<string>();
  let matched = 0;
  const keepOrphans = !!opts?.keepOrphans;

  const visit = (task: Task) => {
    applyList(task, guidToId, orphans, keepOrphans, (n) => {
      matched += n;
    });
    for (const child of task.children) visit(child);
  };
  for (const root of schedule.roots) visit(root);
  for (const group of schedule.groups ?? []) {
    applyList(group, guidToId, orphans, keepOrphans, (n) => {
      matched += n;
    });
  }

  recomputeProductGuidsByTask(schedule);
  return { matched, orphans: [...orphans], keptTasks: schedule.byId.size };
}

function applyList(
  owner: { productIds: number[]; productGuids: string[] },
  guidToId: Map<string, number>,
  orphans: Set<string>,
  keepOrphans: boolean,
  onMatched: (n: number) => void,
): void {
  const ids: number[] = [];
  const guids: string[] = [];
  const seen = new Set<string>();
  let n = 0;
  const len = Math.max(owner.productGuids.length, owner.productIds.length);
  for (let i = 0; i < len; i++) {
    const guid = owner.productGuids[i];
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    const id = guidToId.get(guid);
    if (id == null) {
      orphans.add(guid);
      if (keepOrphans) {
        guids.push(guid);
        ids.push(0);
      }
      continue;
    }
    ids.push(id);
    guids.push(guid);
    n += 1;
  }
  owner.productIds = ids;
  owner.productGuids = guids;
  onMatched(n);
}

export function listOrphanSummary(report: GuidRematchReport, fileName: string): string {
  if (!report.orphans.length) {
    return `«${fileName}»: ${report.matched} elemento(s) recasados pelo GUID.`;
  }
  const sample = report.orphans.slice(0, 8).join(", ");
  const more = report.orphans.length > 8 ? ` (+${report.orphans.length - 8})` : "";
  return (
    `«${fileName}»: ${report.matched} elemento(s) recasados; ` +
    `${report.orphans.length} GUID(s) já não existem neste IFC: ${sample}${more}.`
  );
}
