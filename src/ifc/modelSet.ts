import type { FragmentsModel } from "@thatopen/fragments";
import type { ScheduleData, Task } from "../schedule/types";
import { emptySchedule, recomputeProductGuidsByTask, recomputeScheduleRange } from "../schedule/range";
import type { IfcSession } from "./ifcSession";

/** ExpressIDs nativos cabem abaixo disto; o slot distingue o ficheiro na vista federada. */
export const IFC_ID_STRIDE = 1_000_000_000;

export const MODEL_LAYER_COLORS = ["#2266e3", "#0e8a68", "#c47a0a", "#7c3aed", "#c13515", "#0e7490"];

export function encodeIfcRef(slot: number, nativeId: number): number {
  return slot * IFC_ID_STRIDE + nativeId;
}

export function decodeIfcRef(id: number): { slot: number; nativeId: number } {
  const slot = Math.floor(id / IFC_ID_STRIDE);
  return { slot, nativeId: id - slot * IFC_ID_STRIDE };
}

export interface LoadedIfc {
  id: string;
  slot: number;
  fileName: string;
  displayName: string;
  session: IfcSession;
  model: FragmentsModel;
  visible: boolean;
  color: string;
  hash?: string;
}

export interface NativeRef {
  model: LoadedIfc;
  nativeId: number;
  session: IfcSession;
}

/**
 * Vários ficheiros IFC na mesma vista. Cada um mantém o seu IfcSession / STEP.
 * A UI trabalha sobre o cronograma federado só dos modelos visíveis.
 */
export class IfcModelSet {
  private readonly items: LoadedIfc[] = [];
  private nextSlot = 1;
  private seq = 1;
  activeId: string | null = null;

  get all(): LoadedIfc[] {
    return this.items;
  }

  get visible(): LoadedIfc[] {
    return this.items.filter((m) => m.visible);
  }

  get size(): number {
    return this.items.length;
  }

  get active(): LoadedIfc | null {
    if (this.activeId) {
      const hit = this.items.find((m) => m.id === this.activeId);
      if (hit) return hit;
    }
    return this.visible[0] ?? this.items[0] ?? null;
  }

  get(id: string): LoadedIfc | undefined {
    return this.items.find((m) => m.id === id);
  }

  getBySlot(slot: number): LoadedIfc | undefined {
    return this.items.find((m) => m.slot === slot);
  }

  add(input: {
    id?: string;
    fileName: string;
    session: IfcSession;
    model: FragmentsModel;
    hash?: string;
  }): LoadedIfc {
    const slot = this.nextSlot++;
    const id = input.id ?? `ifc-${this.seq++}`;
    const entry: LoadedIfc = {
      id,
      slot,
      fileName: input.fileName,
      displayName: uniqueDisplayName(
        input.fileName,
        this.items.map((m) => m.displayName),
      ),
      session: input.session,
      model: input.model,
      visible: true,
      color: MODEL_LAYER_COLORS[(slot - 1) % MODEL_LAYER_COLORS.length]!,
      hash: input.hash,
    };
    this.items.push(entry);
    this.activeId = id;
    return entry;
  }

  remove(id: string): LoadedIfc | undefined {
    const i = this.items.findIndex((m) => m.id === id);
    if (i < 0) return undefined;
    const [removed] = this.items.splice(i, 1);
    if (this.activeId === id) this.activeId = this.visible[0]?.id ?? this.items[0]?.id ?? null;
    return removed;
  }

  setVisible(id: string, visible: boolean): LoadedIfc | undefined {
    const m = this.get(id);
    if (!m) return undefined;
    m.visible = visible;
    m.model.object.visible = visible;
    if (!visible && this.activeId === id) {
      this.activeId = this.visible[0]?.id ?? this.items[0]?.id ?? null;
    }
    if (visible) this.activeId = id;
    return m;
  }

  setActive(id: string): void {
    if (this.get(id)) this.activeId = id;
  }

  hasHash(hash: string): boolean {
    return this.items.some((m) => m.hash === hash);
  }

  anyDirty(): boolean {
    return this.items.some((m) => m.session.dirty);
  }

  label(): string {
    if (this.items.length === 0) return "Importar IFC…";
    if (this.items.length === 1) return this.items[0]!.displayName;
    return `${this.items.length} modelos`;
  }

  resolveTask(federatedId: number): NativeRef | null {
    const { slot, nativeId } = decodeIfcRef(federatedId);
    const model = this.getBySlot(slot);
    if (!model) return null;
    return { model, nativeId, session: model.session };
  }

  resolveGroup(federatedId: number): NativeRef | null {
    return this.resolveTask(federatedId);
  }

  mergedSchedule(): ScheduleData {
    const vis = this.visible;
    if (!vis.length) return emptySchedule();
    const wrap = vis.length > 1;
    const out = emptySchedule();
    out.documents = [];
    const currencies = new Set<string>();

    for (const entry of vis) {
      const src = entry.session.schedule;
      currencies.add(src.currency || "BRL");
      const remappedRoots = src.roots.map((t) => remapTask(t, entry.slot, entry.id, entry.displayName));
      const fileRoot: Task | null = wrap
        ? {
            id: encodeIfcRef(entry.slot, 0),
            globalId: `vista4d:file:${entry.id}`,
            name: entry.displayName.replace(/\.ifc$/i, ""),
            children: remappedRoots,
            productIds: [],
            productGuids: [],
            groupIds: [],
            predecessors: [],
            sourceModelId: entry.id,
            sourceFileName: entry.displayName,
            isFederationRoot: true,
          }
        : null;
      if (fileRoot) {
        for (const r of remappedRoots) r.parentId = fileRoot.id;
        out.roots.push(fileRoot);
      } else {
        out.roots.push(...remappedRoots);
      }

      for (const g of src.groups ?? []) {
        out.groups.push({
          ...g,
          id: encodeIfcRef(entry.slot, g.id),
          taskIds: g.taskIds.map((tid) => encodeIfcRef(entry.slot, tid)),
          sourceModelId: entry.id,
          sourceFileName: entry.displayName,
        });
      }
      for (const d of src.documents ?? []) out.documents.push(d);
    }

    out.byId = new Map();
    const index = (t: Task) => {
      out.byId.set(t.id, t);
      for (const c of t.children) index(c);
    };
    for (const r of out.roots) index(r);

    recomputeProductGuidsByTask(out);
    recomputeScheduleRange(out);

    out.currency = currencies.size === 1 ? [...currencies][0]! : vis[0]!.session.schedule.currency || "BRL";
    if (vis.length === 1) {
      const s = vis[0]!.session.schedule;
      out.name = s.name;
      out.workPlanName = s.workPlanName;
      out.projectId = s.projectId;
      out.workPlanId = s.workPlanId;
      out.workScheduleId = s.workScheduleId;
      out.costScheduleId = s.costScheduleId;
      out.georef = s.georef;
    } else {
      out.name = `${vis.length} modelos`;
      out.workPlanName = vis.map((m) => m.displayName.replace(/\.ifc$/i, "")).join(" · ");
    }
    return out;
  }
}

function remapTask(task: Task, slot: number, modelId: string, fileName: string): Task {
  return {
    ...task,
    id: encodeIfcRef(slot, task.id),
    parentId: task.parentId != null ? encodeIfcRef(slot, task.parentId) : undefined,
    children: task.children.map((c) => remapTask(c, slot, modelId, fileName)),
    predecessors: (task.predecessors ?? []).map((p) => ({
      ...p,
      taskId: encodeIfcRef(slot, p.taskId),
    })),
    groupIds: (task.groupIds ?? []).map((g) => encodeIfcRef(slot, g)),
    sourceModelId: modelId,
    sourceFileName: fileName,
    isFederationRoot: false,
  };
}

function uniqueDisplayName(fileName: string, taken: string[]): string {
  if (!taken.includes(fileName)) return fileName;
  const stem = fileName.replace(/\.ifc$/i, "");
  const ext = fileName.slice(stem.length);
  let n = 2;
  let next = `${stem} (${n})${ext}`;
  while (taken.includes(next)) {
    n += 1;
    next = `${stem} (${n})${ext}`;
  }
  return next;
}

export function scheduleTitle(schedule: ScheduleData): string {
  if (schedule.workPlanName && schedule.workPlanName !== schedule.name) {
    return `${schedule.name} · ${schedule.workPlanName}`;
  }
  return schedule.name;
}
