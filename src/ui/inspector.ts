import type { Task } from "../schedule/types";
import { getTaskState } from "../schedule/simulation";
import { formatMoney, ownCost, treeCost } from "../schedule/cost";
import type { TaskPatch } from "../ifc/ifcSession";

const stateLabels: Record<string, string> = {
  pending: "Pendente",
  active: "Em execução",
  done: "Concluído",
};

export interface InspectorElements {
  empty: HTMLElement;
  body: HTMLElement;
  count: HTMLElement;
  state: HTMLElement;
  name: HTMLInputElement;
  ident: HTMLInputElement;
  start: HTMLInputElement;
  end: HTMLInputElement;
  cost: HTMLInputElement;
  duration: HTMLElement;
  products: HTMLElement;
  dateError: HTMLElement;
  form: HTMLFormElement;
  costRollRow: HTMLElement;
  costRoll: HTMLElement;
}

export interface InspectorOptions {
  els: InspectorElements;
  onEdit: (task: Task, patch: TaskPatch) => void;
}

export class InspectorUI {
  private opts: InspectorOptions;
  private task: Task | null = null;
  private currentDate = new Date();
  private productCount = 0;
  private syncing = false;
  currency = "BRL";

  constructor(opts: InspectorOptions) {
    this.opts = opts;
    const { form, name, ident, start, end, cost } = opts.els;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.commitIdentity();
    });
    name.addEventListener("change", () => this.commitIdentity());
    ident.addEventListener("change", () => this.commitIdentity());
    start.addEventListener("change", () => this.commitDates());
    end.addEventListener("change", () => this.commitDates());
    start.addEventListener("input", () => this.commitDates());
    end.addEventListener("input", () => this.commitDates());
    cost.addEventListener("change", () => this.commitCost());
  }

  update(task: Task | null, currentDate: Date, productCount: number): void {
    this.task = task;
    this.currentDate = currentDate;
    this.productCount = productCount;
    this.render();
  }

  private render(): void {
    const { els } = this.opts;
    const task = this.task;

    if (!task) {
      els.empty.style.display = "";
      els.body.classList.add("is-hidden");
      els.count.textContent = "0";
      return;
    }

    els.empty.style.display = "none";
    els.body.classList.remove("is-hidden");
    els.count.textContent = String(this.productCount);

    const st = getTaskState(task, this.currentDate);
    els.state.className = `insp-status is-${st}`;
    els.state.textContent = stateLabels[st] ?? st;

    this.syncing = true;
    els.name.value = task.name;
    els.ident.value = task.identification ?? "";
    els.start.value = task.start ? toDateInput(task.start) : "";
    els.end.value = task.end ? toDateInput(task.end) : "";
    els.cost.value = task.cost == null ? "" : String(task.cost);
    this.syncing = false;

    els.duration.textContent = fmtDuration(task.start, task.end);
    const roll = treeCost(task);
    const own = ownCost(task);
    if (task.children.length > 0 && Math.abs(roll - own) > 0.005) {
      els.costRollRow.classList.remove("is-hidden");
      els.costRoll.textContent = formatMoney(roll, this.currency);
    } else {
      els.costRollRow.classList.add("is-hidden");
    }
    els.products.textContent =
      this.productCount === 0
        ? "Nenhum associado"
        : this.productCount === 1
          ? "1 elemento"
          : `${this.productCount} elementos`;
    this.setDateError(null);
  }

  private commitIdentity(): void {
    if (this.syncing || !this.task) return;
    const { name, ident } = this.opts.els;
    const patch: TaskPatch = {
      name: name.value,
      identification: ident.value,
    };
    this.opts.onEdit(this.task, patch);
  }

  private commitDates(): void {
    if (this.syncing || !this.task) return;
    const { start, end } = this.opts.els;
    if (!start.value || !end.value) {
      this.setDateError("Preencha início e término.");
      return;
    }
    const nextStart = combineDateInput(start.value, this.task.start, 9, 0);
    const nextEnd = combineDateInput(end.value, this.task.end, 17, 0);
    if (nextEnd.getTime() < nextStart.getTime()) {
      this.setDateError("A data de término precisa ser igual ou posterior ao início.");
      return;
    }
    this.setDateError(null);
    this.opts.onEdit(this.task, { start: nextStart, end: nextEnd });
  }

  private commitCost(): void {
    if (this.syncing || !this.task) return;
    const raw = this.opts.els.cost.value.trim().replace(",", ".");
    if (!raw) {
      if (this.task.cost == null) return;
      this.opts.onEdit(this.task, { cost: 0 });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    this.opts.onEdit(this.task, { cost: n });
  }

  private setDateError(msg: string | null): void {
    const { dateError } = this.opts.els;
    if (!msg) {
      dateError.classList.add("is-hidden");
      dateError.textContent = "";
      return;
    }
    dateError.classList.remove("is-hidden");
    dateError.textContent = msg;
  }
}

function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function combineDateInput(
  dateStr: string,
  previous: Date | undefined,
  fallbackH: number,
  fallbackM: number,
): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const h = previous?.getHours() ?? fallbackH;
  const min = previous?.getMinutes() ?? fallbackM;
  const s = previous?.getSeconds() ?? 0;
  return new Date(y, m - 1, d, h, min, s);
}

function fmtDuration(start?: Date, end?: Date): string {
  if (!start || !end) return "—";
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  return days === 1 ? "1 dia" : `${days} dias`;
}
