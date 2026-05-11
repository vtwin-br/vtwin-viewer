import type { AnchorLLA } from "../viewer/earthTiles";

export interface EarthPanelState {
  anchor: AnchorLLA;
  hideRadius: number;
}

export interface EarthPanelOptions {
  initial: EarthPanelState;
  /** Chamado em cada alteracao do utilizador. */
  onChange: (state: EarthPanelState) => void;
  /** Chamado quando o utilizador fecha o painel (botao X). */
  onClose: () => void;
}

/**
 * Painel flutuante para reposicionar o IFC sobre a malha do Google Earth.
 * Conceito: o IFC fica fixo na origem da cena (preserva precisao numerica) e
 * o que se move eh a *ancora geografica* — equivalente, e mais semantico para
 * exportar amanha como `IfcMapConversion`.
 */
export class EarthPanel {
  private root: HTMLElement;
  private opts: EarthPanelOptions;
  private state: EarthPanelState;
  private suppressEvents = false;

  // refs
  private elPaste: HTMLInputElement;
  private elLat: HTMLInputElement;
  private elLon: HTMLInputElement;
  private elAltRange: HTMLInputElement;
  private elAltNum: HTMLInputElement;
  private elHeadingRange: HTMLInputElement;
  private elHeadingNum: HTMLInputElement;
  private elHideRange: HTMLInputElement;
  private elHideNum: HTMLInputElement;
  private elClose: HTMLButtonElement;
  private elCopy: HTMLButtonElement;
  private elOpenMaps: HTMLAnchorElement;

  constructor(root: HTMLElement, opts: EarthPanelOptions) {
    this.root = root;
    this.opts = opts;
    this.state = {
      anchor: { ...opts.initial.anchor },
      hideRadius: opts.initial.hideRadius,
    };

    const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
    this.elPaste = $("ep-paste");
    this.elLat = $("ep-lat");
    this.elLon = $("ep-lon");
    this.elAltRange = $("ep-alt-range");
    this.elAltNum = $("ep-alt-num");
    this.elHeadingRange = $("ep-heading-range");
    this.elHeadingNum = $("ep-heading-num");
    this.elHideRange = $("ep-hide-range");
    this.elHideNum = $("ep-hide-num");
    this.elClose = $("earth-panel-close");
    this.elCopy = $("ep-copy");
    this.elOpenMaps = $("ep-open-maps");

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

  /** Reescreve o estado (util quando vem de fora, ex.: parser do IFC). */
  setState(state: EarthPanelState): void {
    this.state = { anchor: { ...state.anchor }, hideRadius: state.hideRadius };
    this.syncToInputs();
  }

  // ---------------------------------------------------------------------

  private bind(): void {
    this.elClose.addEventListener("click", () => this.opts.onClose());

    // Lat/Lon — texto livre
    this.elLat.addEventListener("change", () => this.commitLatLon(this.elLat.valueAsNumber, undefined));
    this.elLon.addEventListener("change", () => this.commitLatLon(undefined, this.elLon.valueAsNumber));

    // Altitude
    const onAlt = (v: number) => this.commit({ ...this.state, anchor: { ...this.state.anchor, altitude: v } });
    this.elAltRange.addEventListener("input", () => {
      this.elAltNum.value = this.elAltRange.value;
      onAlt(this.elAltRange.valueAsNumber);
    });
    this.elAltNum.addEventListener("change", () => {
      const v = clampNum(this.elAltNum.valueAsNumber, -500, 9000, this.state.anchor.altitude);
      this.elAltRange.value = String(clampNum(v, +this.elAltRange.min, +this.elAltRange.max, v));
      this.elAltNum.value = String(v);
      onAlt(v);
    });

    // Heading (UI em graus, estado em radianos)
    const onHeadingDeg = (deg: number) => {
      const rad = (deg * Math.PI) / 180;
      this.commit({ ...this.state, anchor: { ...this.state.anchor, heading: rad } });
    };
    this.elHeadingRange.addEventListener("input", () => {
      this.elHeadingNum.value = this.elHeadingRange.value;
      onHeadingDeg(this.elHeadingRange.valueAsNumber);
    });
    this.elHeadingNum.addEventListener("change", () => {
      const v = wrapDeg(this.elHeadingNum.valueAsNumber);
      this.elHeadingNum.value = String(v);
      this.elHeadingRange.value = String(v);
      onHeadingDeg(v);
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
        const alt = parseFloat(btn.dataset.alt ?? "");
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        this.commit({
          ...this.state,
          anchor: {
            ...this.state.anchor,
            lat,
            lon,
            altitude: Number.isFinite(alt) ? alt : this.state.anchor.altitude,
          },
        });
      });
    });

    // Nudge fino: movimento de 1 m em N/S/E/W e 0,5 m em U/D
    this.root.querySelectorAll<HTMLButtonElement>(".ep-nudge-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.nudge(btn.dataset.dir ?? ""));
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

  private syncToInputs(): void {
    this.suppressEvents = true;
    try {
      const { anchor, hideRadius } = this.state;
      this.elLat.value = anchor.lat.toFixed(6);
      this.elLon.value = anchor.lon.toFixed(6);
      const alt = roundTo(anchor.altitude, 1);
      this.elAltNum.value = String(alt);
      this.elAltRange.value = String(clampNum(alt, +this.elAltRange.min, +this.elAltRange.max, alt));
      const headingDeg = wrapDeg(((anchor.heading ?? 0) * 180) / Math.PI);
      this.elHeadingNum.value = String(roundTo(headingDeg, 1));
      this.elHeadingRange.value = String(roundTo(headingDeg, 1));
      this.elHideNum.value = String(roundTo(hideRadius, 0));
      this.elHideRange.value = String(Math.min(roundTo(hideRadius, 0), +this.elHideRange.max));
      this.elOpenMaps.href = `https://www.google.com/maps/@${anchor.lat},${anchor.lon},19z`;
    } finally {
      this.suppressEvents = false;
    }
  }

  private nudge(dir: string): void {
    const a = { ...this.state.anchor };
    // 1 grau de latitude ~ 111320 m. 1 grau de longitude varia com o cosseno.
    const M_PER_DEG_LAT = 111320;
    const m_per_deg_lon = M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
    const stepM = 1; // 1 m horizontal
    const altStep = 0.5; // 0,5 m vertical
    switch (dir) {
      case "N":
        a.lat += stepM / M_PER_DEG_LAT;
        break;
      case "S":
        a.lat -= stepM / M_PER_DEG_LAT;
        break;
      case "E":
        a.lon += stepM / m_per_deg_lon;
        break;
      case "W":
        a.lon -= stepM / m_per_deg_lon;
        break;
      case "U":
        a.altitude += altStep;
        break;
      case "D":
        a.altitude -= altStep;
        break;
      default:
        return;
    }
    a.lat = clampNum(a.lat, -90, 90, a.lat);
    a.lon = wrapLon(a.lon);
    this.commit({ ...this.state, anchor: a });
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

function wrapDeg(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return ((v % 360) + 360) % 360;
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
