import * as THREE from "three";
import type { OrthoPerspectiveCamera } from "@thatopen/components";
import type * as FRAGS from "@thatopen/fragments";
import type { GoogleEarthLayer } from "./earthTiles";
import { WalkCollider } from "./walkCollision";

/** Altura da pessoa (m) e câmara à cota dos olhos (~10 cm abaixo do topo). */
const BODY_HEIGHT = 1.8;
const EYE_HEIGHT = 1.7;
const RADIUS = 0.28;
const STEP_OFFSET = 0.38;
const GRAVITY = 9.81;
const WALK_SPEED = 1.45;
const RUN_SPEED = 3.6;
const JUMP_SPEED = 3.4;
const MOUSE_SENS = 0.0022;
const PITCH_LIMIT = 1.45;

export interface FirstPersonOptions {
  camera: OrthoPerspectiveCamera;
  domElement: HTMLElement;
  overlay: HTMLElement;
  hint: HTMLElement;
  button: HTMLButtonElement;
  earth: GoogleEarthLayer;
  onEnabledChange?: (on: boolean) => void;
  onCameraMove?: () => void;
}

/**
 * Caminhada em 1ª pessoa (WASD / setas + rato), escala real, gravidade
 * e colisão com o IFC (portas atravessáveis) e com a malha do Google Earth.
 */
export class FirstPersonController {
  readonly collider = new WalkCollider();
  private opts: FirstPersonOptions;
  private _enabled = false;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private feet = new THREE.Vector3();
  private vy = 0;
  private grounded = false;
  private lastT = 0;
  private prevFov = 50;
  private prevNear = 0.1;
  private spawn = new THREE.Vector3();
  private building = false;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private readonly slideDir = new THREE.Vector3();
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");

  constructor(opts: FirstPersonOptions) {
    this.opts = opts;
    this.collider.setEarth(opts.earth);
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

  async setModel(model: FRAGS.FragmentsModel | null): Promise<void> {
    if (!model) {
      if (this._enabled) this.disable();
      this.collider.detach();
      this.opts.button.disabled = true;
      return;
    }
    this.opts.button.disabled = true;
    this.opts.button.title = "A preparar colisão do modelo…";
    this.building = true;
    await this.collider.attach(model);
    this.building = false;
    this.opts.button.disabled = false;
    this.syncButton();
  }

  async toggle(): Promise<void> {
    if (this._enabled) this.disable();
    else await this.enable();
  }

  async enable(): Promise<void> {
    if (this._enabled) return;
    if (this.building) return;
    if (!this.collider.ready) return;

    const cam = this.opts.camera;
    if (cam.projection.current !== "Perspective") {
      await cam.projection.set("Perspective");
    }

    this.prevFov = cam.threePersp.fov;
    this.prevNear = cam.threePersp.near;
    cam.threePersp.fov = 75;
    cam.threePersp.near = 0.08;
    cam.threePersp.updateProjectionMatrix();

    cam.setUserInput(false);
    cam.controls.enabled = false;

    this.capturePoseFromCamera();
    this.snapToGround(true);
    this.spawn.copy(this.feet);

    this._enabled = true;
    this.lastT = performance.now();
    this.opts.earth.setWalkQuality(true);
    this.opts.overlay.hidden = false;
    this.opts.overlay.classList.add("is-on");
    this.syncButton();
    this.syncHint();
    this.opts.onEnabledChange?.(true);
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
    cam.controls.enabled = true;
    cam.setUserInput(true);

    this.opts.earth.setWalkQuality(false);
    this.opts.overlay.hidden = true;
    this.opts.overlay.classList.remove("is-on", "is-locked");
    this.keys.clear();
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
    this.feet.copy(this.spawn);
    this.vy = 0;
    this.snapToGround(true);
    this.applyCamera();
  }

  wantsExclusiveKeys(): boolean {
    return this._enabled;
  }

  private bind(): void {
    const dom = this.opts.domElement;

    window.addEventListener("keydown", (e) => {
      if (!this._enabled) return;
      this.keys.add(e.code);
      if (
        e.code === "KeyW" ||
        e.code === "KeyA" ||
        e.code === "KeyS" ||
        e.code === "KeyD" ||
        e.code === "ArrowUp" ||
        e.code === "ArrowDown" ||
        e.code === "ArrowLeft" ||
        e.code === "ArrowRight" ||
        e.code === "Space" ||
        e.code === "ShiftLeft" ||
        e.code === "ShiftRight"
      ) {
        e.preventDefault();
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

    dom.addEventListener("click", () => {
      if (!this._enabled || this.pointerLocked) return;
      void dom.requestPointerLock();
    });

    this.opts.button.addEventListener("click", () => {
      void this.toggle();
    });
  }

  private capturePoseFromCamera(): void {
    const cam = this.opts.camera.three;
    cam.updateMatrixWorld();
    this.euler.setFromQuaternion(cam.quaternion, "YXZ");
    this.yaw = this.euler.y;
    this.pitch = this.euler.x;
    this.feet.copy(cam.position);
    this.feet.y -= EYE_HEIGHT;
    this.vy = 0;
    this.grounded = false;
  }

  private snapToGround(force: boolean): void {
    this.probe.copy(this.feet);
    this.probe.y += 12;
    const hit = this.collider.raycast(this.probe, this.down, 80);
    if (!hit) {
      if (force) this.feet.y = Math.max(this.feet.y, 0);
      return;
    }
    this.feet.x = this.probe.x;
    this.feet.z = this.probe.z;
    this.feet.y = hit.point.y;
    this.vy = 0;
    this.grounded = true;
  }

  private updateMove(dt: number): void {
    const running = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const speed = running ? RUN_SPEED : WALK_SPEED;

    let ix = 0;
    let iz = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) iz += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) iz -= 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) ix -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) ix += 1;

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.wish.set(0, 0, 0);
    if (ix || iz) {
      this.wish.addScaledVector(this.forward, iz);
      this.wish.addScaledVector(this.right, ix);
      if (this.wish.lengthSq() > 0) this.wish.normalize().multiplyScalar(speed * dt);
    }

    const next = this.slide(this.feet, this.wish);

    if (this.grounded && (this.keys.has("Space") || this.keys.has("NumpadEnter"))) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
    }

    this.vy -= GRAVITY * dt;
    next.y += this.vy * dt;

    const headHit = this.collider.raycast(
      this.probe.set(next.x, next.y + EYE_HEIGHT, next.z),
      this.up,
      BODY_HEIGHT - EYE_HEIGHT + 0.12,
    );
    if (headHit && this.vy > 0) {
      this.vy = 0;
    }

    const from = this.probe.set(next.x, next.y + STEP_OFFSET + RADIUS, next.z);
    const ground = this.collider.raycast(from, this.down, STEP_OFFSET + RADIUS + 4.5);
    if (ground) {
      const groundY = ground.point.y;
      if (next.y <= groundY + 0.02 || (this.grounded && next.y - groundY < STEP_OFFSET + 0.05)) {
        next.y = groundY;
        this.vy = 0;
        this.grounded = true;
      } else {
        this.grounded = false;
      }
    } else {
      this.grounded = false;
    }

    if (next.y < this.spawn.y - 80) {
      this.feet.copy(this.spawn);
      this.vy = 0;
      this.grounded = true;
      return;
    }

    this.feet.copy(next);
  }

  private slide(from: THREE.Vector3, delta: THREE.Vector3): THREE.Vector3 {
    const out = from.clone();
    if (delta.lengthSq() < 1e-10) return out;
    const blocked = (dx: number, dz: number): boolean => {
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-8) return false;
      const dir = this.slideDir.set(dx, 0, dz).normalize();
      const pad = RADIUS + dist + 0.04;
      for (const h of [0.42, 1.05, 1.55]) {
        const hit = this.collider.raycast(this.probe.set(out.x, out.y + h, out.z), dir, pad);
        if (hit && hit.distance < RADIUS + dist) return true;
      }
      return false;
    };
    if (!blocked(delta.x, delta.z)) {
      out.x += delta.x;
      out.z += delta.z;
      return out;
    }
    if (!blocked(delta.x, 0)) out.x += delta.x;
    if (!blocked(0, delta.z)) out.z += delta.z;
    return out;
  }

  private applyCamera(): void {
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.look.set(0, 0, -1).applyEuler(this.euler);
    const eyeX = this.feet.x;
    const eyeY = this.feet.y + EYE_HEIGHT;
    const eyeZ = this.feet.z;
    const tx = eyeX + this.look.x;
    const ty = eyeY + this.look.y;
    const tz = eyeZ + this.look.z;
    const cam = this.opts.camera.three;
    cam.position.set(eyeX, eyeY, eyeZ);
    cam.quaternion.setFromEuler(this.euler);
    cam.updateMatrixWorld();
    void this.opts.camera.controls.setLookAt(eyeX, eyeY, eyeZ, tx, ty, tz, false);
    this.opts.onCameraMove?.();
  }

  private syncButton(): void {
    const btn = this.opts.button;
    btn.classList.toggle("is-active", this._enabled);
    btn.setAttribute("aria-pressed", this._enabled ? "true" : "false");
    btn.title = this._enabled
      ? "Sair da 1ª pessoa (V)"
      : this.building
        ? "A preparar colisão do modelo…"
        : "Andar em 1ª pessoa (V)";
  }

  private syncHint(): void {
    if (!this._enabled) return;
    this.opts.hint.textContent = this.pointerLocked
      ? "WASD / setas andar · Shift correr · Espaço saltar · Esc solta o rato · V sai"
      : "Clique no modelo para olhar em volta · V sai";
  }
}
