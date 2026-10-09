import * as THREE from "three";
import type { OrthoPerspectiveCamera } from "@thatopen/components";
import type { GoogleEarthLayer } from "./earthTiles";
import { freezeOrbitInput, releaseFlightCamera } from "./setupWorld";

/** Voo nivelado, como um drone de inspeção: o rato é o gimbal, WASD não segue o pitch. */
const MOUSE_SENS = 0.0017;
const PITCH_LIMIT = 1.22;
const CRUISE_MIN = 2;
const CRUISE_MAX = 48;
const CRUISE_DEFAULT = 10;
const BOOST = 2.7;
const VERTICAL_SCALE = 0.7;
const ACCEL = 2.35;

export interface DroneOptions {
  camera: OrthoPerspectiveCamera;
  domElement: HTMLElement;
  overlay: HTMLElement;
  hint: HTMLElement;
  alt: HTMLElement;
  speed: HTMLElement;
  button: HTMLButtonElement;
  earth: GoogleEarthLayer;
  onEnabledChange?: (on: boolean) => void;
  onCameraMove?: () => void;
  canEnable?: () => boolean;
}

/**
 * Voo livre ao estilo de um drone (WASD / setas, Q/E altitude, rato no gimbal).
 * Sem gravidade: a câmara paira e acelera com inércia curta.
 */
export class DroneController {
  private opts: DroneOptions;
  private _enabled = false;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private cruise = CRUISE_DEFAULT;
  private prevFov = 50;
  private prevNear = 0.1;
  private lastT = 0;

  private readonly pos = new THREE.Vector3();
  private readonly spawn = new THREE.Vector3();
  private spawnYaw = 0;
  private spawnPitch = 0;
  private readonly velocity = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");

  constructor(opts: DroneOptions) {
    this.opts = opts;
    opts.domElement.tabIndex = 0;
    this.bind();
    this.syncButton();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.opts.domElement;
  }

  async toggle(): Promise<void> {
    if (this._enabled) this.disable();
    else await this.enable();
  }

  async enable(): Promise<void> {
    if (this._enabled) return;
    if (this.opts.canEnable && !this.opts.canEnable()) return;

    const cam = this.opts.camera;
    if (cam.projection.current !== "Perspective") {
      await cam.projection.set("Perspective");
    }

    this.prevFov = cam.threePersp.fov;
    this.prevNear = cam.threePersp.near;
    cam.threePersp.fov = 68;
    cam.threePersp.near = 0.15;
    cam.threePersp.updateProjectionMatrix();

    cam.setUserInput(false);
    cam.controls.enabled = false;

    this.capturePose();
    this.spawn.copy(this.pos);
    this.spawnYaw = this.yaw;
    this.spawnPitch = this.pitch;
    this.velocity.set(0, 0, 0);

    this._enabled = true;
    this.lastT = performance.now();
    this.opts.earth.setWalkQuality(true);
    this.opts.overlay.hidden = false;
    this.opts.overlay.classList.add("is-on");
    this.syncButton();
    this.syncHint();
    this.paintReadout(0);
    this.opts.onEnabledChange?.(true);
    freezeOrbitInput(cam);
    this.applyCamera();
    void this.opts.domElement.requestPointerLock();
  }

  disable(): void {
    if (!this._enabled) return;
    this._enabled = false;
    if (this.pointerLocked) document.exitPointerLock();

    const cam = this.opts.camera;
    cam.threePersp.fov = this.prevFov;
    cam.threePersp.near = this.prevNear;
    cam.threePersp.updateProjectionMatrix();
    releaseFlightCamera(cam);

    this.opts.earth.setWalkQuality(false);
    this.opts.overlay.hidden = true;
    this.opts.overlay.classList.remove("is-on", "is-locked");
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.syncButton();
    this.opts.onEnabledChange?.(false);
  }

  update(): void {
    if (!this._enabled) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000) || 0.016;
    this.lastT = now;
    this.updateMove(dt);
    this.applyCamera();
    this.syncHint();
  }

  respawn(): void {
    if (!this._enabled) return;
    this.pos.copy(this.spawn);
    this.yaw = this.spawnYaw;
    this.pitch = this.spawnPitch;
    this.velocity.set(0, 0, 0);
    this.applyCamera();
    this.paintReadout(0);
  }

  wantsExclusiveKeys(): boolean {
    return this._enabled;
  }

  private bind(): void {
    const dom = this.opts.domElement;

    window.addEventListener("keydown", (e) => {
      if (!this._enabled) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      this.keys.add(e.code);
      if (this.isFlightKey(e.code)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });

    document.addEventListener("mousemove", (e) => {
      if (!this._enabled || !this.pointerLocked) return;
      this.yaw -= e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    });

    document.addEventListener("pointerlockchange", () => {
      this.opts.overlay.classList.toggle("is-locked", this.pointerLocked);
      this.syncHint();
    });

    dom.addEventListener(
      "wheel",
      (e) => {
        if (!this._enabled || e.deltaY === 0) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.cruise = THREE.MathUtils.clamp(this.cruise * factor, CRUISE_MIN, CRUISE_MAX);
        this.syncHint();
      },
      { capture: true, passive: false },
    );

    dom.addEventListener("click", () => {
      if (!this._enabled || this.pointerLocked) return;
      void dom.requestPointerLock();
    });

    this.opts.button.addEventListener("click", () => {
      void this.toggle();
    });
  }

  private isFlightKey(code: string): boolean {
    return (
      code === "KeyW" ||
      code === "KeyA" ||
      code === "KeyS" ||
      code === "KeyD" ||
      code === "KeyQ" ||
      code === "KeyE" ||
      code === "KeyC" ||
      code === "ArrowUp" ||
      code === "ArrowDown" ||
      code === "ArrowLeft" ||
      code === "ArrowRight" ||
      code === "Space" ||
      code === "ShiftLeft" ||
      code === "ShiftRight" ||
      code === "Escape"
    );
  }

  private capturePose(): void {
    const cam = this.opts.camera.three;
    cam.updateMatrixWorld();
    this.euler.setFromQuaternion(cam.quaternion, "YXZ");
    this.yaw = this.euler.y;
    this.pitch = THREE.MathUtils.clamp(this.euler.x, -PITCH_LIMIT, PITCH_LIMIT);
    this.pos.copy(cam.position);
  }

  private updateMove(dt: number): void {
    let ix = 0;
    let iz = 0;
    let iy = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) iz += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) iz -= 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) ix -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) ix += 1;
    if (this.keys.has("KeyE") || this.keys.has("Space")) iy += 1;
    if (this.keys.has("KeyQ") || this.keys.has("KeyC")) iy -= 1;

    const boosted = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const speed = boosted ? this.cruise * BOOST : this.cruise;

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.wish.set(0, iy * speed * VERTICAL_SCALE, 0);
    if (ix || iz) {
      this.wish.addScaledVector(this.forward, iz);
      this.wish.addScaledVector(this.right, ix);
      const horiz = Math.hypot(this.wish.x, this.wish.z);
      if (horiz > 1e-6) {
        this.wish.x = (this.wish.x / horiz) * speed;
        this.wish.z = (this.wish.z / horiz) * speed;
      }
    }

    const blend = 1 - Math.exp(-dt * ACCEL);
    this.velocity.lerp(this.wish, blend);
    if (this.velocity.lengthSq() < 0.0004) this.velocity.set(0, 0, 0);
    this.pos.addScaledVector(this.velocity, dt);
  }

  private applyCamera(): void {
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.look.set(0, 0, -1).applyEuler(this.euler);

    const eyeX = this.pos.x;
    const eyeY = this.pos.y;
    const eyeZ = this.pos.z;
    const tx = eyeX + this.look.x;
    const ty = eyeY + this.look.y;
    const tz = eyeZ + this.look.z;
    const cam = this.opts.camera.three;
    cam.up.set(0, 1, 0);
    cam.position.set(eyeX, eyeY, eyeZ);
    cam.quaternion.setFromEuler(this.euler);
    cam.updateMatrixWorld();
    void this.opts.camera.controls.setLookAt(eyeX, eyeY, eyeZ, tx, ty, tz, false);
    cam.up.set(0, 1, 0);
    cam.quaternion.setFromEuler(this.euler);
    this.paintReadout(this.velocity.length());
    this.opts.onCameraMove?.();
  }

  private paintReadout(speed: number): void {
    const alt = this.pos.y - this.spawn.y;
    const sign = alt >= 0 ? "+" : "−";
    this.opts.alt.textContent = `${sign}${Math.abs(alt).toFixed(1)} m`;
    this.opts.speed.textContent = `${speed.toFixed(1)} m/s`;
  }

  private syncButton(): void {
    const btn = this.opts.button;
    btn.classList.toggle("is-active", this._enabled);
    btn.setAttribute("aria-pressed", this._enabled ? "true" : "false");
    btn.title = this._enabled ? "Sair do drone (H)" : "Voar como drone (H)";
  }

  private syncHint(): void {
    if (!this._enabled) return;
    const pace = `${Math.round(this.cruise)} m/s`;
    this.opts.hint.textContent = this.pointerLocked
      ? `WASD voar · E sobe · Q desce · Shift rápido · scroll ${pace} · F descolagem · Esc rato · H sai`
      : "Clique na vista para pilotar · H sai";
  }
}
