import type { ScheduleData } from "../schedule/types";

export interface TimelineOptions {
  container: HTMLElement;
  schedule: ScheduleData;
  /** Chamado quando a data atual muda (sincrono - dispare repaint debounced no caller). */
  onDateChange: (date: Date) => void;
}

const SPEEDS: Array<{ label: string; daysPerSec: number }> = [
  { label: "0.5d/s", daysPerSec: 0.5 },
  { label: "1d/s", daysPerSec: 1 },
  { label: "3d/s", daysPerSec: 3 },
  { label: "7d/s", daysPerSec: 7 },
  { label: "15d/s", daysPerSec: 15 },
  { label: "30d/s", daysPerSec: 30 },
];

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

  // refs
  private slider!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private dateLabel!: HTMLSpanElement;
  private dayCounter!: HTMLSpanElement;

  constructor(opts: TimelineOptions) {
    this.opts = opts;
    this.startMs = opts.schedule.minDate.getTime();
    this.endMs = opts.schedule.maxDate.getTime();
    this.totalDays = Math.max(1, Math.round((this.endMs - this.startMs) / 86400000));
    this.currentDay = 0;
    this.build();
    this.emit();
  }

  private build() {
    const root = this.opts.container;
    root.innerHTML = "";

    // Linha de cima: range labels
    const labels = document.createElement("div");
    labels.className = "t-range-labels";
    const lStart = document.createElement("span");
    lStart.textContent = fmtDate(new Date(this.startMs));
    const lEnd = document.createElement("span");
    lEnd.textContent = fmtDate(new Date(this.endMs));
    labels.appendChild(lStart);
    labels.appendChild(lEnd);

    // Linha do meio: controles + slider
    const top = document.createElement("div");
    top.className = "timeline-row";

    const controls = document.createElement("div");
    controls.className = "timeline-controls";

    const btnStart = makeBtn("⏮", "Voltar ao inicio", () => this.seek(0));
    const btnPrev = makeBtn("⏪", "-7 dias", () => this.seek(this.currentDay - 7));
    this.playBtn = makeBtn("▶", "Play / Pause", () => this.togglePlay(), "primary");
    const btnNext = makeBtn("⏩", "+7 dias", () => this.seek(this.currentDay + 7));
    const btnEnd = makeBtn("⏭", "Ir para o fim", () => this.seek(this.totalDays));
    controls.append(btnStart, btnPrev, this.playBtn, btnNext, btnEnd);

    this.slider = document.createElement("input");
    this.slider.type = "range";
    this.slider.className = "t-slider";
    this.slider.min = "0";
    this.slider.max = String(this.totalDays);
    this.slider.step = "1";
    this.slider.value = "0";
    this.slider.addEventListener("input", () => {
      this.seek(Number(this.slider.value));
    });

    top.append(controls, this.slider);

    // Linha de baixo: data + velocidade + contador
    const bottom = document.createElement("div");
    bottom.className = "timeline-row bottom";

    const speedWrap = document.createElement("div");
    speedWrap.className = "t-speed";
    const speedLabel = document.createElement("span");
    speedLabel.textContent = "Velocidade";
    const speedSel = document.createElement("select");
    for (const s of SPEEDS) {
      const opt = document.createElement("option");
      opt.value = String(s.daysPerSec);
      opt.textContent = s.label;
      if (s.daysPerSec === this.speedDpS) opt.selected = true;
      speedSel.appendChild(opt);
    }
    speedSel.addEventListener("change", () => {
      this.speedDpS = Number(speedSel.value);
    });
    speedWrap.append(speedLabel, speedSel);

    this.dayCounter = document.createElement("span");
    this.dayCounter.className = "t-counter";

    this.dateLabel = document.createElement("span");
    this.dateLabel.className = "t-counter";
    this.dateLabel.style.marginLeft = "auto";

    bottom.append(speedWrap, this.dayCounter, this.dateLabel);

    root.append(labels, top, bottom);
  }

  private togglePlay() {
    this.isPlaying ? this.pause() : this.play();
  }

  play() {
    if (this.isPlaying) return;
    if (this.currentDay >= this.totalDays) this.currentDay = 0;
    this.isPlaying = true;
    this.playBtn.textContent = "⏸";
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
    this.playBtn.textContent = "▶";
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
    this.dateLabel.innerHTML = `<strong>${fmtDateLong(date)}</strong>`;
    const dayInt = Math.round(this.currentDay);
    this.dayCounter.innerHTML = `Dia <strong>${dayInt}</strong> de <strong>${this.totalDays}</strong>`;
    this.opts.onDateChange(date);
  }
}

function makeBtn(
  text: string,
  title: string,
  onClick: () => void,
  variant?: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "t-btn" + (variant ? ` ${variant}` : "");
  btn.title = title;
  btn.textContent = text;
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
  return d.toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
