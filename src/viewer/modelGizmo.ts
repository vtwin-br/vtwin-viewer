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
 */
export class ModelGizmo {
  private readonly controls: TransformControls;
  private readonly helper: THREE.Object3D;
  private readonly camera: OrthoPerspectiveCamera;
  private target: THREE.Object3D | null = null;

  constructor(opts: ModelGizmoOptions) {
    this.camera = opts.camera;
    this.controls = new TransformControls(opts.camera.three, opts.domElement);
    this.controls.setMode("translate");
    this.controls.setSpace("world");
    this.controls.setSize(0.9);
    this.controls.showX = true;
    this.controls.showY = true;
    this.controls.showZ = true;
    this.helper = this.controls.getHelper();
    this.helper.visible = false;
    opts.scene.add(this.helper);

    this.controls.addEventListener("dragging-changed", (e) => {
      const dragging = Boolean((e as { value?: boolean }).value);
      this.camera.setUserInput(!dragging);
      opts.onDragging?.(dragging);
    });
    this.controls.addEventListener("objectChange", () => {
      this.controls.camera = this.camera.three;
      opts.onChange(this.read());
    });
    opts.domElement.addEventListener(
      "pointerdown",
      () => {
        if (this.helper.visible && this.controls.axis) this.camera.setUserInput(false);
      },
      true,
    );
    opts.domElement.addEventListener(
      "pointerup",
      () => {
        if (!this.controls.dragging) this.camera.setUserInput(true);
      },
      true,
    );
  }

  attach(object: THREE.Object3D | null): void {
    this.target = object;
    this.controls.camera = this.camera.three;
    if (object) this.controls.attach(object);
    else this.controls.detach();
  }

  setVisible(on: boolean): void {
    this.controls.camera = this.camera.three;
    this.helper.visible = on && this.target != null;
    this.controls.enabled = on && this.target != null;
    if (!on) this.camera.setUserInput(true);
  }

  isDragging(): boolean {
    return this.controls.dragging;
  }

  updateCamera(): void {
    this.controls.camera = this.camera.three;
  }

  setMode(mode: GizmoMode): void {
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
    this.controls.detach();
    this.helper.removeFromParent();
    this.controls.disconnect();
    this.camera.setUserInput(true);
  }
}
