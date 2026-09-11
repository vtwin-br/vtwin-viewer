import * as THREE from "three";
import type { ScheduleHighlighter } from "./highlight";

export type BoxSelectMode = "replace" | "add" | "remove";

export interface BoxSelectOptions {
  viewport: HTMLElement;
  camera: { three: THREE.Camera; setUserInput: (on: boolean) => void };
  highlighter: () => ScheduleHighlighter | null;
  onPicked: (guids: string[], mode: BoxSelectMode) => void;
}

/**
 * Rubber-band no viewport. Ferramenta dedicada ou Shift+arrasto.
 * Pausa a órbita enquanto o retângulo está ativo.
 */
export class BoxSelectController {
  private readonly viewport: HTMLElement;
  private readonly camera: { three: THREE.Camera; setUserInput: (on: boolean) => void };
  private readonly highlighter: () => ScheduleHighlighter | null;
  private readonly onPicked: BoxSelectOptions["onPicked"];
  private overlay: HTMLDivElement;
  private toolOn = false;
  private dragging = false;
  private start = { x: 0, y: 0 };
  private end = { x: 0, y: 0 };
  private mode: BoxSelectMode = "replace";

  constructor(opts: BoxSelectOptions) {
    this.viewport = opts.viewport;
    this.camera = opts.camera;
    this.highlighter = opts.highlighter;
    this.onPicked = opts.onPicked;
    this.overlay = document.createElement("div");
    this.overlay.className = "box-select-rect";
    this.overlay.hidden = true;
    this.viewport.appendChild(this.overlay);

    this.viewport.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
  }

  setToolEnabled(on: boolean): void {
    this.toolOn = on;
    this.viewport.classList.toggle("is-box-select", on);
    if (!on && this.dragging) this.cancel();
  }

  isToolEnabled(): boolean {
    return this.toolOn;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  dispose(): void {
    this.viewport.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.overlay.remove();
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const useTool = this.toolOn || e.shiftKey;
    if (!useTool) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragging = true;
    this.mode = e.altKey ? "remove" : e.ctrlKey || e.metaKey || e.shiftKey ? "add" : "replace";
    if (this.toolOn && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) this.mode = "replace";
    const r = this.viewport.getBoundingClientRect();
    this.start = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.end = { ...this.start };
    this.overlay.hidden = false;
    this.paint();
    this.camera.setUserInput(false);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const r = this.viewport.getBoundingClientRect();
    this.end = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.paint();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    this.overlay.hidden = true;
    this.camera.setUserInput(true);
    const w = Math.abs(this.end.x - this.start.x);
    const h = Math.abs(this.end.y - this.start.y);
    if (w < 6 && h < 6) return;
    e.preventDefault();
    void this.pick();
  };

  private cancel(): void {
    this.dragging = false;
    this.overlay.hidden = true;
    this.camera.setUserInput(true);
  }

  private paint(): void {
    const x = Math.min(this.start.x, this.end.x);
    const y = Math.min(this.start.y, this.end.y);
    const w = Math.abs(this.end.x - this.start.x);
    const h = Math.abs(this.end.y - this.start.y);
    this.overlay.style.left = `${x}px`;
    this.overlay.style.top = `${y}px`;
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
  }

  private async pick(): Promise<void> {
    const hl = this.highlighter();
    if (!hl) return;
    const model = hl.getModel();
    await hl.ready();
    const ids = await model.getItemsIdsWithGeometry();
    if (!ids.length) return;
    const rubber = this.rubberScreen();
    const cam = this.camera.three;
    const hits: number[] = [];
    const chunk = 800;
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      let boxes: THREE.Box3[] = [];
      try {
        boxes = await model.getBoxes(slice);
      } catch {
        continue;
      }
      for (let k = 0; k < slice.length; k++) {
        const box = boxes[k];
        if (!box || box.isEmpty()) continue;
        if (boxIntersectsRubber(box, cam, this.viewport, rubber)) hits.push(slice[k]);
      }
    }
    if (!hits.length) {
      this.onPicked([], this.mode);
      return;
    }
    const guids = await hl.guidsFromLocalIds(hits);
    this.onPicked(guids, this.mode);
  }

  private rubberScreen(): { minX: number; minY: number; maxX: number; maxY: number } {
    const r = this.viewport.getBoundingClientRect();
    const x1 = Math.min(this.start.x, this.end.x) + r.left;
    const y1 = Math.min(this.start.y, this.end.y) + r.top;
    const x2 = Math.max(this.start.x, this.end.x) + r.left;
    const y2 = Math.max(this.start.y, this.end.y) + r.top;
    return { minX: x1, minY: y1, maxX: x2, maxY: y2 };
  }
}

function boxIntersectsRubber(
  box: THREE.Box3,
  camera: THREE.Camera,
  viewport: HTMLElement,
  rubber: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const corners = [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ];
  const rect = viewport.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const c of corners) {
    const ndc = c.project(camera);
    if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) continue;
    const sx = rect.left + ((ndc.x + 1) / 2) * rect.width;
    const sy = rect.top + ((1 - ndc.y) / 2) * rect.height;
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy);
    maxY = Math.max(maxY, sy);
    any = true;
  }
  if (!any) return false;
  return minX <= rubber.maxX && maxX >= rubber.minX && minY <= rubber.maxY && maxY >= rubber.minY;
}
