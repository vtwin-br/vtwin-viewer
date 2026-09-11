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
  private readOnly = false;
  currency = "BRL";

  constructor(opts: InspectorOptions) {
    this.opts = opts;
    const { form, name, ident, start, end, cost } = opts.els;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!this.readOnly) this.commitIdentity();
    });
    name.addEventListener("change", () => this.commitIdentity());
    ident.addEventListener("change", () => this.commitIdentity());
    start.addEventListener("change", () => this.commitDates());
    end.addEventListener("change", () => this.commitDates());
    start.addEventListener("input", () => this.commitDates());
    end.addEventListener("input", () => this.commitDates());
    cost.addEventListener("change", () => this.commitCost());
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    const { name, ident, start, end, cost, form } = this.opts.els;
    for (const el of [name, ident, start, end, cost]) {
      el.readOnly = readOnly;
      el.tabIndex = readOnly ? -1 : 0;
      if (el.type === "date" || el.type === "number") el.disabled = readOnly;
      if (readOnly) {
        if (el.placeholder && el.dataset.editPh == null) el.dataset.editPh = el.placeholder;
        el.placeholder = "";
      } else if (el.dataset.editPh != null) {
        el.placeholder = el.dataset.editPh;
      }
    }
    form.setAttribute("aria-readonly", readOnly ? "true" : "false");
    form.closest("#inspector")?.classList.toggle("is-readonly", readOnly);
    const emptyCopy = document.getElementById("inspector-empty-copy");
    if (emptyCopy) {
      emptyCopy.textContent = readOnly
        ? "Selecione uma tarefa no cronograma ou um elemento 3D para ver as propriedades."
        : "Selecione uma tarefa no cronograma ou um elemento 3D para ver e editar as propriedades.";
    }
    const hint = document.getElementById("insp-hint");
    if (hint) {
      hint.textContent = readOnly
        ? "O Cronograma 4D é o resultado da simulação. A edição de dados fica no Planejamento de projeto."
        : "O custo 5D grava em IfcCostItem → IfcCostValue.AppliedValue. Exporte o IFC para persistir.";
    }
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

      if (!task || task.isFederationRoot) {
        if (task?.isFederationRoot) {
          els.empty.style.display = "none";
          els.body.classList.remove("is-hidden");
          els.count.textContent = "0";
          els.name.value = task.name;
          els.ident.value = task.sourceFileName ?? "";
          els.state.textContent = "Modelo IFC";
          els.products.textContent = "Pasta do ficheiro na vista federada";
          this.setReadOnly(true);
          return;
        }
      els.empty.style.display = "";
      els.body.classList.add("is-hidden");
      els.count.textContent = "0";
      return;
    }

    els.empty.style.display = "none";
    els.body.classList.remove("is-hidden");
    els.count.textContent = String(this.productCount);
    this.setReadOnly(false);

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
    if (this.readOnly || this.syncing || !this.task) return;
    const { name, ident } = this.opts.els;
    const patch: TaskPatch = {
      name: name.value,
      identification: ident.value,
    };
    this.opts.onEdit(this.task, patch);
  }

  private commitDates(): void {
    if (this.readOnly || this.syncing || !this.task) return;
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
    if (this.readOnly || this.syncing || !this.task) return;
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
