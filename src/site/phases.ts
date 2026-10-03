import type { ScheduleData, Task } from "../schedule/types";
import { libraryItem } from "./library";
import type { SiteAsset } from "./types";

export interface PhaseQuantityLine {
  key: string;
  name: string;
  count: number;
  length: number;
  volume: number;
}

/** Fases nativas que um planejador percorre. Linhas de planejamento não entram. */
export function sitePhases(schedule: ScheduleData | null): Task[] {
  if (!schedule) return [];
  const roots = schedule.roots.filter((task) => !task.isFederationRoot && !task.isPlanning);
  const level = roots.flatMap((root) => (root.children.length ? root.children : [root]));
  const dated = level.filter((task) => task.start && task.end && !task.isFederationRoot && !task.isPlanning);
  const source = dated.length ? dated : level.filter((task) => !task.isFederationRoot);
  return [...source].sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0)).slice(0, 10);
}

/** Contagens, comprimentos e volumes dos elementos de canteiro ligados à fase e às subtarefas. */
export function phaseQuantities(schedule: ScheduleData, assets: SiteAsset[], phase: Task): PhaseQuantityLine[] {
  const taskIds = new Set<number>();
  const walk = (task: Task) => {
    taskIds.add(task.id);
    for (const child of task.children) walk(child);
  };
  walk(phase);
  const guids = new Set<string>();
  for (const id of taskIds) {
    const task = schedule.byId.get(id);
    for (const guid of schedule.productGuidsByTask.get(id) ?? task?.productGuids ?? []) guids.add(guid);
  }
  const lines = new Map<string, PhaseQuantityLine>();
  for (const asset of assets) {
    if (!guids.has(asset.globalId)) continue;
    const item = libraryItem(asset.libraryKey);
    const name = item?.name || asset.name || asset.libraryKey;
    const line = lines.get(asset.libraryKey) ?? { key: asset.libraryKey, name, count: 0, length: 0, volume: 0 };
    line.count += asset.count;
    line.length += asset.length;
    line.volume += asset.volume;
    lines.set(asset.libraryKey, line);
  }
  return [...lines.values()];
}

export function formatQuantity(line: PhaseQuantityLine): string {
  const parts: string[] = [];
  if (line.count > 0) parts.push(`${trimMeasure(line.count)} un`);
  if (line.length > 0) parts.push(`${trimMeasure(line.length)} m`);
  if (line.volume > 0) parts.push(`${trimMeasure(line.volume)} m³`);
  return parts.join(" · ") || "—";
}

function trimMeasure(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
