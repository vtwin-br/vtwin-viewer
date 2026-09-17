import { isWorkspaceId, workspaceShell, DEFAULT_WORKSPACE } from "../app/catalog";

const KEY = {
  schedule: "vista4d.scheduleW",
  inspector: "vista4d.inspectorW",
  timeline: "vista4d.timelineH",
  planGantt: "vista4d.planGanttW",
  planSets: "vista4d.planSetsW",
  earthW: "vista4d.earthW",
  earthH: "vista4d.earthH",
} as const;

const DEFAULTS = {
  schedule: 328,
  inspector: 300,
  timeline: 88,
  planGantt: 560,
  planSets: 280,
  earthW: 320,
  earthH: 560,
};

interface SplitConfig {
  key: string;
  cssVar: string;
  min: number;
  max: number;
  fallback: number;
  axis: "x" | "y";
  /** x: "end" grows to the right. y: "end" grows downward. */
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
    const start = cfg.axis === "x" ? ev.clientX : ev.clientY;
    const startSize = currentVar(cfg.cssVar, cfg.fallback);
    el.classList.add("is-active");
    grid?.classList.add("is-resizing");
    grid?.classList.toggle("is-resizing-y", cfg.axis === "y");
    el.setPointerCapture(ev.pointerId);

    const onMove = (e: PointerEvent) => {
      const pos = cfg.axis === "x" ? e.clientX : e.clientY;
      const delta = pos - start;
      const next = cfg.edge === "end" ? startSize + delta : startSize - delta;
      applyVar(cfg.cssVar, clamp(next, cfg.min, cfg.max));
    };
    const onUp = (e: PointerEvent) => {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove("is-active");
      grid?.classList.remove("is-resizing", "is-resizing-y");
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      writeStored(cfg.key, currentVar(cfg.cssVar, startSize));
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  el.addEventListener("pointerdown", startDrag);
  el.addEventListener("dblclick", () => {
    applyVar(cfg.cssVar, cfg.fallback);
    writeStored(cfg.key, cfg.fallback);
  });
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 32 : 8;
    const grow = cfg.axis === "x" ? "ArrowRight" : "ArrowDown";
    const shrink = cfg.axis === "x" ? "ArrowLeft" : "ArrowUp";
    let delta = 0;
    if (e.key === shrink) delta = cfg.edge === "end" ? -step : step;
    else if (e.key === grow) delta = cfg.edge === "end" ? step : -step;
    else return;
    e.preventDefault();
    const next = clamp(currentVar(cfg.cssVar, cfg.fallback) + delta, cfg.min, cfg.max);
    applyVar(cfg.cssVar, next);
    writeStored(cfg.key, next);
  });
}

function attach(id: string, cfg: SplitConfig): void {
  const el = document.getElementById(id);
  if (!el) return;
  applyVar(cfg.cssVar, clamp(readStored(cfg.key, cfg.fallback), cfg.min, cfg.max));
  bind(el, cfg);
}

/** Restaura larguras gravadas e liga os puxadores dos painéis. */
export function initPanelSplitters(): void {
  attach("split-schedule", {
    key: KEY.schedule,
    cssVar: "--schedule-w",
    min: 220,
    max: 640,
    fallback: DEFAULTS.schedule,
    axis: "x",
    edge: "end",
  });
  attach("split-inspector", {
    key: KEY.inspector,
    cssVar: "--inspector-w",
    min: 240,
    max: 560,
    fallback: DEFAULTS.inspector,
    axis: "x",
    edge: "start",
  });
  attach("split-timeline", {
    key: KEY.timeline,
    cssVar: "--timeline-h",
    min: 64,
    max: 220,
    fallback: DEFAULTS.timeline,
    axis: "y",
    edge: "start",
  });
  attach("split-gantt-view", {
    key: KEY.planGantt,
    cssVar: "--plan-gantt-w",
    min: 280,
    max: 900,
    fallback: DEFAULTS.planGantt,
    axis: "x",
    edge: "end",
  });
  attach("split-view-sets", {
    key: KEY.planSets,
    cssVar: "--plan-sets-w",
    min: 200,
    max: 520,
    fallback: DEFAULTS.planSets,
    axis: "x",
    edge: "start",
  });
  attach("split-earth", {
    key: KEY.earthW,
    cssVar: "--earth-panel-w",
    min: 260,
    max: 560,
    fallback: DEFAULTS.earthW,
    axis: "x",
    edge: "start",
  });
  attach("split-earth-h", {
    key: KEY.earthH,
    cssVar: "--earth-panel-h",
    min: 220,
    max: 900,
    fallback: DEFAULTS.earthH,
    axis: "y",
    edge: "end",
  });

  constrainPanelWidths();
  window.addEventListener("resize", () => constrainPanelWidths());
}

/** Impede que os painéis laterais comprimam a área central abaixo de ~480px. */
export function constrainPanelWidths(): void {
  const grid = document.querySelector(".body-grid") as HTMLElement | null;
  if (!grid) return;
  const layout = document.documentElement.dataset.layout;
  if (layout === "compact" || layout === "narrow") return;

  constrainPlanColumns(grid);

  const wsAttr = grid.getAttribute("data-workspace");
  const shellKind = workspaceShell(isWorkspaceId(wsAttr) ? wsAttr : DEFAULT_WORKSPACE);
  if (shellKind === "placeholder") return;

  if (grid.classList.contains("schedule-collapsed") && grid.classList.contains("inspector-collapsed")) return;

  const avail = grid.clientWidth;
  const minCenter = 480;
  const scheduleOpen = (shellKind === "schedule" || shellKind === "logistics") && !grid.classList.contains("schedule-collapsed");
  const inspectorOpen = !grid.classList.contains("inspector-collapsed");
  let s = scheduleOpen ? currentVar("--schedule-w", DEFAULTS.schedule) : 0;
  let i = inspectorOpen ? currentVar("--inspector-w", DEFAULTS.inspector) : 0;
  const overflow = s + i + minCenter - avail;
  if (overflow <= 0) return;
  if (inspectorOpen) {
    const nextI = clamp(i - overflow, 240, 560);
    applyVar("--inspector-w", nextI);
    i = nextI;
  }
  const still = s + i + minCenter - avail;
  if (still > 0 && scheduleOpen) {
    applyVar("--schedule-w", clamp(s - still, 220, 640));
  }
}

function constrainPlanColumns(grid: HTMLElement): void {
  const ws = grid.getAttribute("data-workspace");
  if (workspaceShell(isWorkspaceId(ws) ? ws : DEFAULT_WORKSPACE) !== "plan" || !grid.classList.contains("model-open")) return;
  const center = grid.querySelector(".center-column") as HTMLElement | null;
  if (!center) return;
  const avail = center.clientWidth;
  const minView = 240;
  const ganttOpen = !grid.classList.contains("gantt-collapsed");
  const setsOpen = !grid.classList.contains("sets-collapsed");
  let g = ganttOpen ? currentVar("--plan-gantt-w", DEFAULTS.planGantt) : 0;
  let s = setsOpen ? currentVar("--plan-sets-w", DEFAULTS.planSets) : 0;
  const overflow = g + s + minView + 12 - avail;
  if (overflow <= 0) return;
  if (setsOpen) {
    const next = clamp(s - overflow, 200, 520);
    applyVar("--plan-sets-w", next);
    s = next;
  }
  const still = g + s + minView + 12 - avail;
  if (still > 0 && ganttOpen) {
    applyVar("--plan-gantt-w", clamp(g - still, 280, 900));
  }
}
