import * as THREE from "three";
import type { OrthoPerspectiveCamera } from "@thatopen/components";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { ModelExtraTransform } from "../ifc/georef";

export type GizmoMode = "translate" | "rotate";

export interface ModelGizmoOptions {
  scene: THREE.Object3D;
  camera: OrthoPerspectiveCamera;
  domElement: HTMLElement;
  onChange: (t: ModelExtraTransform) => void;
  onDragging?: (dragging: boolean) => void;
}

/**
 * Gizmo clássico (setas XYZ + arco de rotação) sobre o modelo IFC.
 * Só intercepta o rato quando o ponteiro acerta num eixo — o resto da vista
 * continua a orbitar. A órbita é pausada só durante o arrasto.
 */
export class ModelGizmo {
  private readonly controls: TransformControls;
  private readonly helper: THREE.Object3D;
  private readonly camera: OrthoPerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly onChange: (t: ModelExtraTransform) => void;
  private readonly onDragging?: (dragging: boolean) => void;
  private target: THREE.Object3D | null = null;
  private mode: GizmoMode | null = null;
  private allowed = false;
  private cameraFrozenByUs = false;
  private capturedId: number | null = null;

  constructor(opts: ModelGizmoOptions) {
    this.camera = opts.camera;
    this.dom = opts.domElement;
    this.onChange = opts.onChange;
    this.onDragging = opts.onDragging;
    this.controls = new TransformControls(opts.camera.three, opts.domElement);
    this.controls.disconnect();
    this.controls.setMode("translate");
    this.controls.setSpace("world");
    this.controls.setSize(0.9);
    this.controls.showX = true;
    this.controls.showY = true;
    this.controls.showZ = true;
    this.controls.enabled = false;
    this.helper = this.controls.getHelper();
    this.helper.visible = false;
    opts.scene.add(this.helper);

    this.controls.addEventListener("objectChange", () => {
      this.controls.camera = this.camera.three;
      this.onChange(this.read());
    });
    this.controls.addEventListener("mouseDown", () => this.freezeCamera());
    this.controls.addEventListener("mouseUp", () => this.thawCamera());

    this.dom.addEventListener("pointermove", this.onPointerHover);
    this.dom.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerDrag);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  attach(object: THREE.Object3D | null): void {
    this.target = object;
    this.controls.camera = this.camera.three;
    if (object) this.controls.attach(object);
    else this.controls.detach();
    this.applyVisibility();
  }

  /** Vista 3D com 1ª pessoa desligada — o gizmo só aparece se houver modo. */
  setAllowed(on: boolean): void {
    this.allowed = on;
    if (!on) this.mode = null;
    this.applyVisibility();
  }

  /** Compat: liga/desliga a permissão. O gizmo continua oculto sem modo ativo. */
  setVisible(on: boolean): void {
    this.setAllowed(on);
  }

  getMode(): GizmoMode | null {
    return this.mode;
  }

  isDragging(): boolean {
    return Boolean(this.controls.dragging);
  }

  updateCamera(): void {
    this.controls.camera = this.camera.three;
  }

  setMode(mode: GizmoMode | null): void {
    this.mode = mode;
    if (mode) {
      this.controls.setMode(mode);
      if (mode === "rotate") {
        this.controls.showX = false;
        this.controls.showY = true;
        this.controls.showZ = false;
      } else {
        this.controls.showX = true;
        this.controls.showY = true;
        this.controls.showZ = true;
      }
    }
    this.applyVisibility();
  }

  apply(t: ModelExtraTransform): void {
    if (!this.target) return;
    this.target.position.set(t.x, t.y, t.z);
    this.target.rotation.set(0, t.yaw, 0);
  }

  reset(): void {
    this.apply({ x: 0, y: 0, z: 0, yaw: 0 });
  }

  read(): ModelExtraTransform {
    if (!this.target) return { x: 0, y: 0, z: 0, yaw: 0 };
    return {
      x: this.target.position.x,
      y: this.target.position.y,
      z: this.target.position.z,
      yaw: this.target.rotation.y,
    };
  }

  fitSize(object: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    this.controls.setSize(Math.max(0.55, Math.min(1.4, maxDim / 18)));
  }

  dispose(): void {
    this.dom.removeEventListener("pointermove", this.onPointerHover);
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerDrag);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.releasePointer();
    this.thawCamera();
    this.controls.detach();
    this.helper.removeFromParent();
    this.controls.dispose();
  }

  private applyVisibility(): void {
    const on = this.allowed && this.mode != null && this.target != null;
    this.controls.camera = this.camera.three;
    this.helper.visible = on;
    this.controls.enabled = on;
    this.dom.style.touchAction = on ? "none" : "";
    if (!on) {
      this.controls.axis = null;
      (this.controls as TransformControls & { dragging: boolean }).dragging = false;
      this.releasePointer();
      this.thawCamera();
    }
  }

  private poke(
    method: "pointerHover" | "pointerDown" | "pointerMove" | "pointerUp",
    event: PointerEvent,
    moving = false,
  ): void {
    this.controls[method](this.toPointer(event, moving) as unknown as PointerEvent);
  }

  private onPointerHover = (e: PointerEvent): void => {
    if (!this.controls.enabled || this.controls.dragging) return;
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    this.poke("pointerHover", e);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.controls.enabled || e.button !== 0) return;
    this.poke("pointerHover", e);
    if (!this.controls.axis) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      this.dom.setPointerCapture(e.pointerId);
      this.capturedId = e.pointerId;
    } catch {
      this.capturedId = null;
    }
    this.poke("pointerDown", e);
    this.freezeCamera();
  };

  private onPointerDrag = (e: PointerEvent): void => {
    if (!this.controls.dragging) return;
    this.poke("pointerMove", e, true);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.controls.dragging && this.capturedId == null) return;
    this.poke("pointerUp", e);
    this.releasePointer();
    this.thawCamera();
  };

  private freezeCamera(): void {
    if (this.cameraFrozenByUs) return;
    this.cameraFrozenByUs = true;
    this.camera.setUserInput(false);
    this.camera.controls.enabled = false;
    this.onDragging?.(true);
  }

  private thawCamera(): void {
    if (!this.cameraFrozenByUs) return;
    this.cameraFrozenByUs = false;
    this.camera.setUserInput(true);
    this.camera.controls.enabled = true;
    this.onDragging?.(false);
  }

  private releasePointer(): void {
    if (this.capturedId == null) return;
    try {
      this.dom.releasePointerCapture(this.capturedId);
    } catch {
      /* já libertado */
    }
    this.capturedId = null;
  }

  private toPointer(event: PointerEvent, moving = false): { x: number; y: number; button: number } {
    const rect = this.dom.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
      button: moving ? -1 : event.button,
    };
  }
}
