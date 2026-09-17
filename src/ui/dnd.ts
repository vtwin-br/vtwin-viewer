/** Tipos internos de arraste — não são ficheiros do SO. */

export const DND_GUIDS = "application/x-vtwin-guids";
export const DND_GROUP = "application/x-vtwin-group";
export const DND_LAYER = "application/x-vtwin-layer";

export function isFileDrag(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

export function hasType(e: DragEvent, type: string): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes(type);
}

export function setDragJson(dt: DataTransfer, type: string, data: unknown, effect: "copy" | "move" = "copy"): void {
  const json = JSON.stringify(data);
  dt.setData(type, json);
  dt.setData("text/plain", json);
  dt.effectAllowed = effect === "move" ? "move" : "copy";
}

export function getDragJson<T>(dt: DataTransfer | null, type: string): T | null {
  const raw = dt?.getData(type);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function markDrop(el: HTMLElement | null, on: boolean, cls = "is-drop-ready"): void {
  el?.classList.toggle(cls, on);
}

export function clearDrops(root: ParentNode, cls = "is-drop-ready"): void {
  root.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls));
}
