/**
 * Overlay de FPS / ms só em desenvolvimento.
 */
export interface VistaPerformanceSample {
  name: string;
  durationMs: number;
  at: number;
  detail?: Record<string, number | string | boolean>;
}

export interface VistaPerformanceReport {
  samples: VistaPerformanceSample[];
  longTaskCount: number;
  longTaskMs: number;
  heapUsed?: number;
  heapLimit?: number;
}

const MAX_SAMPLES = 200;
const samples: VistaPerformanceSample[] = [];
let longTaskCount = 0;
let longTaskMs = 0;

declare global {
  interface Window {
    /** Snapshot reproduzível para copiar dos DevTools após carregar um modelo. */
    __VISTA4D_PERF__?: () => VistaPerformanceReport;
  }
}

export function attachPerfStats(
  world: {
    renderer?: {
      onBeforeUpdate: { add: (fn: () => void) => void };
      onAfterUpdate: { add: (fn: () => void) => void };
    } | null;
  },
  host: HTMLElement = document.body,
): void {
  if (!import.meta.env.DEV) return;
  const el = document.createElement("div");
  el.className = "perf-stats";
  el.title = "Performance (dev)";
  host.appendChild(el);

  let frames = 0;
  let last = performance.now();
  let ms = 0;
  let t0 = 0;
  observeLongTasks();
  window.__VISTA4D_PERF__ = performanceReport;

  world.renderer?.onBeforeUpdate.add(() => {
    t0 = performance.now();
  });
  world.renderer?.onAfterUpdate.add(() => {
    ms = performance.now() - t0;
    frames += 1;
    const now = performance.now();
    if (now - last < 500) return;
    const fps = Math.round((frames * 1000) / (now - last));
    const memory = browserMemory();
    const heap = memory ? ` · ${formatBytes(memory.usedJSHeapSize)}` : "";
    const long = longTaskCount ? ` · LT ${longTaskCount}` : "";
    el.textContent = `${fps} fps · ${ms.toFixed(1)} ms${heap}${long}`;
    el.title =
      "Performance (dev). Execute __VISTA4D_PERF__() no console para ver as fases, heap e long tasks.";
    frames = 0;
    last = now;
  });
}

export function markLoad(name: string, startMark: string): void {
  try {
    performance.mark(name);
    const measure = performance.measure(name, startMark, name);
    recordMetric(name, measure.duration);
  } catch {
    /* ignore */
  }
}

export function recordMetric(
  name: string,
  durationMs: number,
  detail?: Record<string, number | string | boolean>,
): void {
  samples.push({ name, durationMs, at: Date.now(), detail });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export async function measureAsync<T>(
  name: string,
  run: () => Promise<T>,
  detail?: () => Record<string, number | string | boolean>,
): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    recordMetric(name, performance.now() - start, detail?.());
  }
}

export function performanceReport(): VistaPerformanceReport {
  const memory = browserMemory();
  return {
    samples: samples.map((sample) => ({
      ...sample,
      detail: sample.detail ? { ...sample.detail } : undefined,
    })),
    longTaskCount,
    longTaskMs,
    heapUsed: memory?.usedJSHeapSize,
    heapLimit: memory?.jsHeapSizeLimit,
  };
}

function observeLongTasks(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskMs += entry.duration;
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    /* Long Tasks API não existe em todos os browsers. */
  }
}

function browserMemory():
  | { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
  | undefined {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  };
  return perf.memory;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}
