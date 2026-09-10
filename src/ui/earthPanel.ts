import type { AnchorLLA } from "../viewer/earthTiles";
import { emptyExtraTransform, type ModelExtraTransform } from "../ifc/georef";
import type { GizmoMode } from "../viewer/modelGizmo";

export interface EarthPanelState {
  anchor: AnchorLLA;
  hideRadius: number;
  transform: ModelExtraTransform;
}

export interface EarthPanelOptions {
  initial: EarthPanelState;
  onChange: (state: EarthPanelState) => void;
  onTransformChange: (t: ModelExtraTransform) => void;
  onModeChange: (mode: GizmoMode) => void;
  onSnapTerrain: () => void;
  /** Só oculta o painel; a camada Earth continua ligada. */
  onDismiss: () => void;
}

/**
 * Painel para âncora geográfica (IfcSite / Maps) e gizmo do modelo (IfcSite.ObjectPlacement).
 */
export class EarthPanel {
  private root: HTMLElement;
  private opts: EarthPanelOptions;
  private state: EarthPanelState;
  private suppressEvents = false;

  private elSource: HTMLElement;
  private elPaste: HTMLInputElement;
  private elLat: HTMLInputElement;
  private elLon: HTMLInputElement;
  private elTerrain: HTMLElement;
  private elSnap: HTMLButtonElement;
  private elX: HTMLInputElement;
  private elY: HTMLInputElement;
  private elZ: HTMLInputElement;
  private elYawRange: HTMLInputElement;
  private elYawNum: HTMLInputElement;
  private elHideRange: HTMLInputElement;
  private elHideNum: HTMLInputElement;
  private elClose: HTMLButtonElement;
  private elCopy: HTMLButtonElement;
  private elOpenMaps: HTMLAnchorElement;
  private elModeMove: HTMLButtonElement;
  private elModeRotate: HTMLButtonElement;
  private elReset: HTMLButtonElement;

  constructor(root: HTMLElement, opts: EarthPanelOptions) {
    this.root = root;
    this.opts = opts;
    this.state = {
      anchor: { ...opts.initial.anchor },
      hideRadius: opts.initial.hideRadius,
      transform: { ...opts.initial.transform },
    };

    const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
    this.elSource = $("ep-source");
    this.elPaste = $("ep-paste");
    this.elLat = $("ep-lat");
    this.elLon = $("ep-lon");
    this.elTerrain = $("ep-terrain");
    this.elSnap = $("ep-snap");
    this.elX = $("ep-x");
    this.elY = $("ep-y");
    this.elZ = $("ep-z");
    this.elYawRange = $("ep-yaw-range");
    this.elYawNum = $("ep-yaw-num");
    this.elHideRange = $("ep-hide-range");
    this.elHideNum = $("ep-hide-num");
    this.elClose = $("earth-panel-close");
    this.elCopy = $("ep-copy");
    this.elOpenMaps = $("ep-open-maps");
    this.elModeMove = $("ep-mode-move");
    this.elModeRotate = $("ep-mode-rotate");
    this.elReset = $("ep-reset-xform");

    this.bind();
    this.syncToInputs();
  }

  show(): void {
    this.root.classList.remove("is-hidden");
  }

  hide(): void {
    this.root.classList.add("is-hidden");
  }

  isVisible(): boolean {
    return !this.root.classList.contains("is-hidden");
  }

  setState(state: EarthPanelState): void {
    this.state = {
      anchor: { ...state.anchor },
      hideRadius: state.hideRadius,
      transform: { ...state.transform },
    };
    this.syncToInputs();
  }

  setSource(text: string): void {
    this.elSource.textContent = text;
  }

  setTransform(t: ModelExtraTransform): void {
    this.state.transform = { ...t };
    this.syncTransformInputs();
  }

  setTerrainHeight(meters: number | null, status?: string): void {
    if (meters == null) {
      this.elTerrain.textContent = status ?? "a amostrar…";
      return;
    }
    this.elTerrain.textContent = `${roundTo(meters, 1).toLocaleString("pt-BR")} m no elipsoide`;
    this.state.anchor.altitude = meters;
  }

  setMode(mode: GizmoMode): void {
    this.elModeMove.classList.toggle("is-active", mode === "translate");
    this.elModeRotate.classList.toggle("is-active", mode === "rotate");
  }

  // ---------------------------------------------------------------------

  private bind(): void {
    this.elClose.addEventListener("click", () => {
      this.hide();
      this.opts.onDismiss();
    });

    // Lat/Lon — texto livre
    this.elLat.addEventListener("change", () => this.commitLatLon(this.elLat.valueAsNumber, undefined));
    this.elLon.addEventListener("change", () => this.commitLatLon(undefined, this.elLon.valueAsNumber));
    this.elSnap.addEventListener("click", () => this.opts.onSnapTerrain());

    // Transformação do modelo (gizmo)
    const onAxis = (key: "x" | "y" | "z", el: HTMLInputElement) => {
      const v = Number.isFinite(el.valueAsNumber) ? el.valueAsNumber : this.state.transform[key];
      this.commitTransform({ ...this.state.transform, [key]: v });
    };
    this.elX.addEventListener("change", () => onAxis("x", this.elX));
    this.elY.addEventListener("change", () => onAxis("y", this.elY));
    this.elZ.addEventListener("change", () => onAxis("z", this.elZ));
    const onYawDeg = (deg: number) => {
      this.commitTransform({ ...this.state.transform, yaw: (wrapSignedDeg(deg) * Math.PI) / 180 });
    };
    this.elYawRange.addEventListener("input", () => {
      this.elYawNum.value = this.elYawRange.value;
      onYawDeg(this.elYawRange.valueAsNumber);
    });
    this.elYawNum.addEventListener("change", () => {
      const v = wrapSignedDeg(this.elYawNum.valueAsNumber);
      this.elYawNum.value = String(v);
      this.elYawRange.value = String(v);
      onYawDeg(v);
    });
    this.elModeMove.addEventListener("click", () => {
      this.setMode("translate");
      this.opts.onModeChange("translate");
    });
    this.elModeRotate.addEventListener("click", () => {
      this.setMode("rotate");
      this.opts.onModeChange("rotate");
    });
    this.elReset.addEventListener("click", () => {
      this.commitTransform(emptyExtraTransform());
    });

    // Hide radius
    const onHide = (v: number) => this.commit({ ...this.state, hideRadius: v });
    this.elHideRange.addEventListener("input", () => {
      this.elHideNum.value = this.elHideRange.value;
      onHide(this.elHideRange.valueAsNumber);
    });
    this.elHideNum.addEventListener("change", () => {
      const v = clampNum(this.elHideNum.valueAsNumber, 0, 500, this.state.hideRadius);
      this.elHideNum.value = String(v);
      this.elHideRange.value = String(Math.min(v, +this.elHideRange.max));
      onHide(v);
    });

    // Paste do Google Maps
    this.elPaste.addEventListener("input", () => {
      const parsed = parseLatLon(this.elPaste.value);
      if (!parsed) return;
      this.commitLatLon(parsed.lat, parsed.lon);
      this.elPaste.value = "";
    });

    // Presets
    this.root.querySelectorAll<HTMLButtonElement>(".ep-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const lat = parseFloat(btn.dataset.lat ?? "");
        const lon = parseFloat(btn.dataset.lon ?? "");
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        this.commit({
          ...this.state,
          anchor: {
            ...this.state.anchor,
            lat,
            lon,
          },
        });
      });
    });

    // Copiar coordenadas
    this.elCopy.addEventListener("click", async () => {
      const { lat, lon, altitude } = this.state.anchor;
      const txt = `${lat.toFixed(6)}, ${lon.toFixed(6)} (alt ${altitude.toFixed(1)} m)`;
      try {
        await navigator.clipboard.writeText(txt);
      } catch {
        window.prompt("Coordenadas:", txt);
      }
      this.elCopy.classList.add("is-flash");
      const prev = this.elCopy.textContent;
      this.elCopy.textContent = "Copiado!";
      setTimeout(() => {
        this.elCopy.classList.remove("is-flash");
        this.elCopy.textContent = prev ?? "Copiar coordenadas";
      }, 1400);
    });
  }

  private commitLatLon(lat: number | undefined, lon: number | undefined): void {
    const next: AnchorLLA = { ...this.state.anchor };
    if (Number.isFinite(lat as number)) next.lat = clampNum(lat!, -90, 90, next.lat);
    if (Number.isFinite(lon as number)) next.lon = wrapLon(lon!);
    this.commit({ ...this.state, anchor: next });
  }

  private commit(state: EarthPanelState): void {
    this.state = state;
    this.syncToInputs();
    if (!this.suppressEvents) this.opts.onChange(this.state);
  }

  private commitTransform(t: ModelExtraTransform): void {
    this.state.transform = { ...t };
    this.syncTransformInputs();
    if (!this.suppressEvents) this.opts.onTransformChange(this.state.transform);
  }

  private syncToInputs(): void {
    this.suppressEvents = true;
    try {
      const { anchor, hideRadius } = this.state;
      this.elLat.value = anchor.lat.toFixed(6);
      this.elLon.value = anchor.lon.toFixed(6);
      this.setTerrainHeight(Number.isFinite(anchor.altitude) ? anchor.altitude : null);
      this.elHideNum.value = String(roundTo(hideRadius, 0));
      this.elHideRange.value = String(Math.min(roundTo(hideRadius, 0), +this.elHideRange.max));
      this.elOpenMaps.href = `https://www.google.com/maps/@${anchor.lat},${anchor.lon},19z`;
      this.syncTransformInputs();
    } finally {
      this.suppressEvents = false;
    }
  }

  private syncTransformInputs(): void {
    const t = this.state.transform;
    this.elX.value = String(roundTo(t.x, 3));
    this.elY.value = String(roundTo(t.y, 3));
    this.elZ.value = String(roundTo(t.z, 3));
    const yawDeg = wrapSignedDeg((t.yaw * 180) / Math.PI);
    this.elYawNum.value = String(roundTo(yawDeg, 1));
    this.elYawRange.value = String(roundTo(yawDeg, 1));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clampNum(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function wrapLon(v: number): number {
  if (!Number.isFinite(v)) return 0;
  let x = ((v + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

function wrapSignedDeg(v: number): number {
  if (!Number.isFinite(v)) return 0;
  let x = ((((v + 180) % 360) + 360) % 360) - 180;
  if (x === -180) x = 180;
  return x;
}

function roundTo(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return 0;
  const k = Math.pow(10, decimals);
  return Math.round(v * k) / k;
}

/**
 * Aceita varios formatos:
 *   - "-23.5614,-46.6559"
 *   - "-23.5614, -46.6559"
 *   - "https://www.google.com/maps/@-23.5614,-46.6559,17z"
 *   - "https://maps.google.com/?q=-23.5614,-46.6559"
 *   - "-23°33'41.0\"S 46°39'21.2\"W"  (DMS basico)
 */
function parseLatLon(text: string): { lat: number; lon: number } | null {
  if (!text) return null;
  const t = text.trim();

  // 1) URL Google Maps com @lat,lon,zoom
  const at = t.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) {
    const lat = parseFloat(at[1]);
    const lon = parseFloat(at[2]);
    if (isLatLon(lat, lon)) return { lat, lon };
  }

  // 2) ?q=lat,lon
  const q = t.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (q) {
    const lat = parseFloat(q[1]);
    const lon = parseFloat(q[2]);
    if (isLatLon(lat, lon)) return { lat, lon };
  }

  // 3) Par decimal solto
  const pair = t.match(/(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)/);
  if (pair) {
    const lat = parseFloat(pair[1]);
    const lon = parseFloat(pair[2]);
    if (isLatLon(lat, lon)) return { lat, lon };
  }

  return null;
}

function isLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}
