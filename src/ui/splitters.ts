const KEY = {
  schedule: "vista4d.scheduleW",
  inspector: "vista4d.inspectorW",
} as const;

const DEFAULTS = {
  schedule: 328,
  inspector: 300,
};

interface SplitConfig {
  key: string;
  cssVar: string;
  min: number;
  max: number;
  /** "end" = handle on the right of the panel (cronograma). "start" = handle on the left (inspector). */
  edge: "start" | "end";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readStored(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* ignore quota / private mode */
  }
}

function applyVar(cssVar: string, px: number): void {
  document.documentElement.style.setProperty(cssVar, `${Math.round(px)}px`);
}

function currentVar(cssVar: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bind(el: HTMLElement, cfg: SplitConfig): void {
  const grid = document.querySelector(".body-grid");

  const startDrag = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = currentVar(cfg.cssVar, cfg.edge === "end" ? DEFAULTS.schedule : DEFAULTS.inspector);
    el.classList.add("is-active");
    grid?.classList.add("is-resizing");
    el.setPointerCapture(ev.pointerId);

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const next = cfg.edge === "end" ? startW + dx : startW - dx;
      applyVar(cfg.cssVar, clamp(next, cfg.min, cfg.max));
    };
    const onUp = (e: PointerEvent) => {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove("is-active");
      grid?.classList.remove("is-resizing");
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      writeStored(cfg.key, currentVar(cfg.cssVar, startW));
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  el.addEventListener("pointerdown", startDrag);
  el.addEventListener("dblclick", () => {
    const def = cfg.edge === "end" ? DEFAULTS.schedule : DEFAULTS.inspector;
    applyVar(cfg.cssVar, def);
    writeStored(cfg.key, def);
  });
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 32 : 8;
    let delta = 0;
    if (e.key === "ArrowLeft") delta = cfg.edge === "end" ? -step : step;
    else if (e.key === "ArrowRight") delta = cfg.edge === "end" ? step : -step;
    else return;
    e.preventDefault();
    const next = clamp(currentVar(cfg.cssVar, DEFAULTS.schedule) + delta, cfg.min, cfg.max);
    applyVar(cfg.cssVar, next);
    writeStored(cfg.key, next);
  });
}

/** Restaura larguras gravadas e liga os puxadores dos painéis laterais. */
export function initPanelSplitters(): void {
  applyVar("--schedule-w", clamp(readStored(KEY.schedule, DEFAULTS.schedule), 220, 640));
  applyVar("--inspector-w", clamp(readStored(KEY.inspector, DEFAULTS.inspector), 240, 520));

  const schedule = document.getElementById("split-schedule");
  const inspector = document.getElementById("split-inspector");
  if (schedule) {
    bind(schedule, {
      key: KEY.schedule,
      cssVar: "--schedule-w",
      min: 220,
      max: 640,
      edge: "end",
    });
  }
  if (inspector) {
    bind(inspector, {
      key: KEY.inspector,
      cssVar: "--inspector-w",
      min: 240,
      max: 520,
      edge: "start",
    });
  }
}
