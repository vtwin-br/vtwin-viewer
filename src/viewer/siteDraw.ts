import * as THREE from "three";
import type { OrthoPerspectiveCamera } from "@thatopen/components";
import type { GoogleEarthLayer } from "./earthTiles";
import { SITE_LIMIT_MAX_POINTS } from "../logistics/types";

export interface SiteDrawOptions {
  viewport: HTMLElement;
  camera: OrthoPerspectiveCamera;
  earth: GoogleEarthLayer;
  onDraft: (points: THREE.Vector3[]) => void;
  onComplete: (points: THREE.Vector3[]) => void;
  onCancel: () => void;
}

/**
 * Clique no terreno (Google ou plano Y) para os vértices do limite.
 * Enter / duplo clique fecha; Esc cancela; Backspace desfaz.
 */
export class SiteDrawController {
  private opts: SiteDrawOptions;
  private enabled = false;
  private points: THREE.Vector3[] = [];
  private armed = false;
  private start = { x: 0, y: 0 };
  private hover = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  private planeY = 0;

  constructor(opts: SiteDrawOptions) {
    this.opts = opts;
    opts.viewport.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("keydown", this.onKey);
    opts.viewport.addEventListener("dblclick", this.onDbl);
  }

  get active(): boolean {
    return this.enabled;
  }

  setPlaneY(y: number): void {
    this.planeY = y;
    this.plane.constant = -y;
  }

  startDraw(): void {
    this.enabled = true;
    this.points = [];
    this.opts.viewport.classList.add("is-site-draw");
    this.opts.onDraft([]);
  }

  cancel(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.points = [];
    this.opts.viewport.classList.remove("is-site-draw");
    this.opts.onCancel();
  }

  finish(): boolean {
    if (!this.enabled || this.points.length < 3) return false;
    const pts = this.points.map((p) => p.clone());
    this.enabled = false;
    this.points = [];
    this.opts.viewport.classList.remove("is-site-draw");
    this.opts.onComplete(pts);
    return true;
  }

  dispose(): void {
    this.opts.viewport.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("keydown", this.onKey);
    this.opts.viewport.removeEventListener("dblclick", this.onDbl);
    this.opts.viewport.classList.remove("is-site-draw");
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return;
    this.armed = true;
    this.start.x = e.clientX;
    this.start.y = e.clientY;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    const hit = this.pick(e);
    if (!hit) return;
    this.hover.copy(hit);
    if (this.points.length) this.opts.onDraft([...this.points, this.hover.clone()]);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.enabled || !this.armed) return;
    this.armed = false;
    if (Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) > 7) return;
    const hit = this.pick(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.points.length >= SITE_LIMIT_MAX_POINTS) {
      this.finish();
      return;
    }
    this.points.push(hit.clone());
    this.opts.onDraft([...this.points]);
  };

  private onDbl = (e: MouseEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.finish();
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.code === "Escape") {
      e.preventDefault();
      this.cancel();
    } else if (e.code === "Enter") {
      e.preventDefault();
      this.finish();
    } else if (e.code === "Backspace") {
      e.preventDefault();
      this.points.pop();
      this.opts.onDraft([...this.points]);
    }
  };

  private pick(e: PointerEvent | MouseEvent): THREE.Vector3 | null {
    const rect = this.opts.viewport.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const cam = this.opts.camera.three;
    this.raycaster.setFromCamera(this.ndc, cam);
    const earthHit = this.opts.earth.enabled
      ? this.opts.earth.raycast(this.raycaster.ray.origin, this.raycaster.ray.direction, 20000)
      : null;
    if (earthHit) return earthHit.point.clone();
    this.plane.constant = -this.planeY;
    if (this.raycaster.ray.intersectPlane(this.plane, this.hit)) return this.hit.clone();
    return null;
  }
}
