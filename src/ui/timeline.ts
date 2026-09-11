import type { ScheduleData } from "../schedule/types";

export interface TimelineOptions {
  container: HTMLElement;
  schedule: ScheduleData;
  /** Chamado quando a data atual muda (sincrono - dispare repaint debounced no caller). */
  onDateChange: (date: Date) => void;
  onPlayingChange?: (playing: boolean) => void;
}

const SPEEDS: Array<{ label: string; daysPerSec: number; title: string }> = [
  { label: "0,5", daysPerSec: 0.5, title: "0,5 dia por segundo" },
  { label: "1", daysPerSec: 1, title: "1 dia por segundo" },
  { label: "3", daysPerSec: 3, title: "3 dias por segundo" },
  { label: "7", daysPerSec: 7, title: "7 dias por segundo" },
  { label: "15", daysPerSec: 15, title: "15 dias por segundo" },
  { label: "30", daysPerSec: 30, title: "30 dias por segundo" },
];

const ICON_START = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="6" width="2.2" height="12" rx="0.5"/><path d="M19 6.1v11.8L9 12 19 6.1z"/></svg>`;
const ICON_PREV = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.6 6.1v11.8L2.2 12 11.6 6.1z"/><path d="M21.8 6.1v11.8L12.4 12 21.8 6.1z"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.4 5.8v12.4L19 12 8.4 5.8z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="6" width="3.4" height="12" rx="0.8"/><rect x="13.6" y="6" width="3.4" height="12" rx="0.8"/></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.2 6.1v11.8L11.6 12 2.2 6.1z"/><path d="M12.4 6.1v11.8L21.8 12 12.4 6.1z"/></svg>`;
const ICON_END = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 6.1v11.8L15 12 5 6.1z"/><rect x="16.8" y="6" width="2.2" height="12" rx="0.5"/></svg>`;
const ICON_MORE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></svg>`;

export class TimelineUI {
  private opts: TimelineOptions;
  private startMs: number;
  private endMs: number;
  private totalDays: number;
  /** dia atual a partir do inicio (float). */
  private currentDay: number;
  private speedDpS: number = 7;
  private isPlaying = false;
  private rafId: number | null = null;
  private lastTs = 0;

  private slider!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private nowLabel!: HTMLSpanElement;
  private dayCounter!: HTMLSpanElement;
  private rangeStartLabel!: HTMLSpanElement;
  private rangeEndLabel!: HTMLSpanElement;
  private speedBtns: HTMLButtonElement[] = [];

  constructor(opts: TimelineOptions) {
    this.opts = opts;
    this.startMs = opts.schedule.minDate.getTime();
    this.endMs = opts.schedule.maxDate.getTime();
    this.totalDays = Math.max(1, Math.round((this.endMs - this.startMs) / 86400000));
    this.currentDay = 0;
    this.build();
    this.emit();
  }

  /** Liga um cronograma novo (IFC importado) e volta ao primeiro dia. */
  bindSchedule(schedule: ScheduleData): void {
    this.pause();
    this.opts.schedule = schedule;
    this.startMs = schedule.minDate.getTime();
    this.endMs = schedule.maxDate.getTime();
    this.totalDays = Math.max(1, Math.round((this.endMs - this.startMs) / 86400000));
    this.slider.max = String(this.totalDays);
    this.rangeStartLabel.textContent = fmtDate(schedule.minDate);
    this.rangeEndLabel.textContent = fmtDate(schedule.maxDate);
    this.seek(0);
  }

  setIdle(idle: boolean): void {
    if (idle) this.pause();
    this.opts.container.classList.toggle("is-idle", idle);
    this.opts.container.setAttribute("aria-disabled", idle ? "true" : "false");
    this.slider.disabled = idle;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  /** Primeiro dia da timeline, parado — mostra o modelo completo. */
  get atStart(): boolean {
    return this.currentDay <= 0;
  }

  togglePlay(): void {
    if (this.opts.container.classList.contains("is-idle")) return;
    this.isPlaying ? this.pause() : this.play();
  }

  nudgeDays(n: number): void {
    if (this.opts.container.classList.contains("is-idle")) return;
    this.seek(this.currentDay + n);
  }

  jumpToStart(): void {
    if (this.opts.container.classList.contains("is-idle")) return;
    this.seek(0);
  }

  jumpToEnd(): void {
    if (this.opts.container.classList.contains("is-idle")) return;
    this.seek(this.totalDays);
  }

  /** Atualiza o intervalo do slider quando o cronograma é editado. */
  setRange(minDate: Date, maxDate: Date): void {
    const current = new Date(this.startMs + this.currentDay * 86400000);
    this.startMs = minDate.getTime();
    this.endMs = maxDate.getTime();
    this.totalDays = Math.max(1, Math.round((this.endMs - this.startMs) / 86400000));
    this.slider.max = String(this.totalDays);
    this.rangeStartLabel.textContent = fmtDate(minDate);
    this.rangeEndLabel.textContent = fmtDate(maxDate);
    const day = (current.getTime() - this.startMs) / 86400000;
    this.seek(day);
  }

  private build() {
    const root = this.opts.container;
    root.innerHTML = "";
    this.speedBtns = [];

    const date = document.createElement("div");
    date.className = "t-date";
    this.nowLabel = document.createElement("span");
    this.nowLabel.className = "t-now";
    this.dayCounter = document.createElement("span");
    this.dayCounter.className = "t-counter";
    date.append(this.nowLabel, this.dayCounter);

    const controls = document.createElement("div");
    controls.className = "timeline-controls";
    const btnStart = makeBtn(ICON_START, "Início da obra", () => this.jumpToStart());
    const btnPrev = makeBtn(ICON_PREV, "Recuar 7 dias", () => this.nudgeDays(-7));
    this.playBtn = makeBtn(ICON_PLAY, "Reproduzir", () => this.togglePlay(), "primary");
    this.playBtn.setAttribute("aria-pressed", "false");
    const btnNext = makeBtn(ICON_NEXT, "Avançar 7 dias", () => this.nudgeDays(7));
    const btnEnd = makeBtn(ICON_END, "Fim da obra", () => this.jumpToEnd());
    controls.append(btnStart, btnPrev, this.playBtn, btnNext, btnEnd);

    const sliderWrap = document.createElement("div");
    sliderWrap.className = "t-slider-wrap";
    this.slider = document.createElement("input");
    this.slider.type = "range";
    this.slider.className = "t-slider";
    this.slider.min = "0";
    this.slider.max = String(this.totalDays);
    this.slider.step = "1";
    this.slider.value = "0";
    this.slider.setAttribute("aria-label", "Data da simulação");
    this.slider.addEventListener("input", () => {
      this.seek(Number(this.slider.value));
    });
    const labels = document.createElement("div");
    labels.className = "t-range-labels";
    this.rangeStartLabel = document.createElement("span");
    this.rangeStartLabel.textContent = fmtDate(new Date(this.startMs));
    this.rangeEndLabel = document.createElement("span");
    this.rangeEndLabel.textContent = fmtDate(new Date(this.endMs));
    labels.append(this.rangeStartLabel, this.rangeEndLabel);
    sliderWrap.append(this.slider, labels);

    const speedWrap = document.createElement("div");
    speedWrap.className = "t-speed";
    const speedLabel = document.createElement("span");
    speedLabel.className = "t-speed-label";
    speedLabel.textContent = "Dias / s";
    const seg = document.createElement("div");
    seg.className = "t-speed-seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Velocidade da simulação em dias por segundo");
    for (const s of SPEEDS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "t-speed-btn" + (s.daysPerSec === this.speedDpS ? " is-active" : "");
      btn.textContent = s.label;
      btn.title = s.title;
      btn.setAttribute("aria-label", s.title);
      btn.setAttribute("aria-pressed", s.daysPerSec === this.speedDpS ? "true" : "false");
      btn.addEventListener("click", () => this.setSpeed(s.daysPerSec));
      this.speedBtns.push(btn);
      seg.appendChild(btn);
    }
    speedWrap.append(speedLabel, seg);

    const more = document.createElement("div");
    more.className = "t-more";
    const moreBtn = makeBtn(ICON_MORE, "Velocidade da simulação", () => {
      more.classList.toggle("is-open");
    });
    moreBtn.classList.add("t-more-btn");
    moreBtn.setAttribute("aria-haspopup", "true");
    more.append(moreBtn, speedWrap);

    const top = document.createElement("div");
    top.className = "t-top";
    top.append(date, controls);

    const bottom = document.createElement("div");
    bottom.className = "t-bottom";
    bottom.append(sliderWrap, more);

    root.append(top, bottom);
    document.addEventListener("pointerdown", (e) => {
      if (!more.contains(e.target as Node)) more.classList.remove("is-open");
    });
  }

  private setSpeed(daysPerSec: number) {
    this.speedDpS = daysPerSec;
    for (let i = 0; i < SPEEDS.length; i++) {
      const on = SPEEDS[i].daysPerSec === daysPerSec;
      this.speedBtns[i]?.classList.toggle("is-active", on);
      this.speedBtns[i]?.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  play() {
    if (this.isPlaying) return;
    if (this.currentDay >= this.totalDays) this.currentDay = 0;
    this.isPlaying = true;
    this.opts.onPlayingChange?.(true);
    this.playBtn.innerHTML = ICON_PAUSE;
    this.playBtn.title = "Pausar";
    this.playBtn.setAttribute("aria-label", "Pausar");
    this.playBtn.setAttribute("aria-pressed", "true");
    this.lastTs = performance.now();
    const step = (now: number) => {
      if (!this.isPlaying) return;
      const dt = (now - this.lastTs) / 1000;
      this.lastTs = now;
      this.currentDay += dt * this.speedDpS;
      if (this.currentDay >= this.totalDays) {
        this.currentDay = this.totalDays;
        this.pause();
      }
      this.slider.value = String(this.currentDay);
      this.emit();
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  pause() {
    this.isPlaying = false;
    this.opts.onPlayingChange?.(false);
    this.playBtn.innerHTML = ICON_PLAY;
    this.playBtn.title = "Reproduzir";
    this.playBtn.setAttribute("aria-label", "Reproduzir");
    this.playBtn.setAttribute("aria-pressed", "false");
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  seek(day: number) {
    this.currentDay = Math.max(0, Math.min(this.totalDays, day));
    this.slider.value = String(this.currentDay);
    this.emit();
  }

  private emit() {
    const date = new Date(this.startMs + this.currentDay * 86400000);
    this.nowLabel.textContent = fmtDateLong(date);
    const dayInt = Math.round(this.currentDay);
    this.dayCounter.innerHTML = `Dia <strong>${dayInt}</strong><span class="t-counter-sep">/</span><strong>${this.totalDays}</strong>`;
    const p = (this.currentDay / this.totalDays) * 100;
    this.slider.style.setProperty("--p", `${p}%`);
    this.opts.onDateChange(date);
  }
}

function makeBtn(
  icon: string,
  title: string,
  onClick: () => void,
  variant?: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "t-btn" + (variant ? ` ${variant}` : "");
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = icon;
  btn.addEventListener("click", onClick);
  return btn;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtDateLong(d: Date): string {
  const raw = d.toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return raw.replace(/\.$/, "").replace(",", "");
}
