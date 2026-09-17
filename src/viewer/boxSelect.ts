import * as THREE from "three";
import type { ScheduleHighlighter } from "./highlight";

export type BoxSelectMode = "replace" | "add" | "remove";
/** Como no CAD: esquerda→direita = só o que está contido; direita→esquerda = o que a caixa toca. */
export type BoxSelectKind = "window" | "crossing";

export interface BoxSelectOptions {
  viewport: HTMLElement;
  camera: { three: THREE.Camera; setUserInput: (on: boolean) => void };
  highlighter: () => ScheduleHighlighter | null;
  onPicked: (guids: string[], mode: BoxSelectMode) => void;
}

const _corner = new THREE.Vector3();

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
  /** Clique armado (ferramenta ou Shift). Só vira arrasto depois de 6 px. */
  private armed = false;
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
    this.overlay.className = "box-select-rect is-window";
    this.overlay.hidden = true;
    this.viewport.appendChild(this.overlay);

    this.viewport.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
  }

  setToolEnabled(on: boolean): void {
    this.toolOn = on;
    this.viewport.classList.toggle("is-box-select", on);
    if (!on && (this.dragging || this.armed)) this.cancel();
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

  private kind(): BoxSelectKind {
    return this.end.x < this.start.x ? "crossing" : "window";
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const useTool = this.toolOn || e.shiftKey;
    if (!useTool) return;
    e.preventDefault();
    e.stopPropagation();
    this.armed = true;
    this.dragging = false;
    this.mode = e.altKey ? "remove" : e.ctrlKey || e.metaKey || e.shiftKey ? "add" : "replace";
    if (this.toolOn && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) this.mode = "replace";
    const r = this.viewport.getBoundingClientRect();
    this.start = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.end = { ...this.start };
    this.overlay.hidden = true;
    this.camera.setUserInput(false);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.armed && !this.dragging) return;
    const r = this.viewport.getBoundingClientRect();
    this.end = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (!this.dragging) {
      const w = Math.abs(this.end.x - this.start.x);
      const h = Math.abs(this.end.y - this.start.y);
      if (w < 6 && h < 6) return;
      this.dragging = true;
      this.overlay.hidden = false;
    }
    this.paint();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.armed && !this.dragging) return;
    const ran = this.dragging;
    this.armed = false;
    this.dragging = false;
    this.overlay.hidden = true;
    this.camera.setUserInput(true);
    const w = Math.abs(this.end.x - this.start.x);
    const h = Math.abs(this.end.y - this.start.y);
    if (!ran || (w < 6 && h < 6)) return;
    e.preventDefault();
    void this.pick();
  };

  private cancel(): void {
    this.armed = false;
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
    const crossing = this.kind() === "crossing";
    this.overlay.classList.toggle("is-crossing", crossing);
    this.overlay.classList.toggle("is-window", !crossing);
  }

  private async pick(): Promise<void> {
    const hl = this.highlighter();
    if (!hl) return;
    await hl.ready();
    const models = hl.visibleModels();
    if (!models.length) return;
    const rubber = this.rubberScreen();
    const cam = this.camera.three;
    const contained = this.kind() === "window";
    const guids: string[] = [];
    for (const { id, model } of models) {
      let ids: number[] = [];
      try {
        ids = hl.geomIdsOf(id) ?? (await model.getItemsIdsWithGeometry());
      } catch {
        continue;
      }
      if (!ids.length) continue;
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
          if (boxHitsRubber(box, cam, this.viewport, rubber, contained)) hits.push(slice[k]!);
        }
      }
      if (hits.length) guids.push(...(await hl.guidsFromLocalIds(hits, id)));
    }
    this.onPicked([...new Set(guids)], this.mode);
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

function boxHitsRubber(
  box: THREE.Box3,
  camera: THREE.Camera,
  viewport: HTMLElement,
  rubber: { minX: number; minY: number; maxX: number; maxY: number },
  mustContain: boolean,
): boolean {
  const rect = viewport.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let inFront = 0;
  const xs = [box.min.x, box.max.x];
  const ys = [box.min.y, box.max.y];
  const zs = [box.min.z, box.max.z];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        _corner.set(x, y, z).project(camera);
        if (!Number.isFinite(_corner.x) || !Number.isFinite(_corner.y)) continue;
        if (_corner.z < -1 || _corner.z > 1) continue;
        const sx = rect.left + ((_corner.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - _corner.y) / 2) * rect.height;
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
        inFront += 1;
      }
    }
  }
  if (inFront === 0) return false;
  if (mustContain) {
    if (inFront < 8) return false;
    return minX >= rubber.minX && maxX <= rubber.maxX && minY >= rubber.minY && maxY <= rubber.maxY;
  }
  return minX <= rubber.maxX && maxX >= rubber.minX && minY <= rubber.maxY && maxY >= rubber.minY;
}
