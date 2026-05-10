import type { Task } from "../schedule/types";
import { getTaskState } from "../schedule/simulation";

const stateLabels: Record<string, string> = {
  pending: "Pendente",
  active: "Em execução",
  done: "Concluído",
};

function fmtDate(d?: Date): string {
  if (!d) return "—";
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export interface InspectorElements {
  empty: HTMLElement;
  body: HTMLElement;
  count: HTMLElement;
  name: HTMLElement;
  ident: HTMLElement;
  state: HTMLElement;
  start: HTMLElement;
  end: HTMLElement;
  products: HTMLElement;
}

export function updateInspector(
  els: InspectorElements,
  task: Task | null,
  currentDate: Date,
  productCount: number,
): void {
  if (!task) {
    els.empty.style.display = "block";
    els.body.classList.add("is-hidden");
    els.count.textContent = "0";
    return;
  }

  els.empty.style.display = "none";
  els.body.classList.remove("is-hidden");
  els.count.textContent = String(productCount);

  els.name.textContent = task.name;
  els.ident.textContent = task.identification ?? "—";

  const st = getTaskState(task, currentDate);
  const label = stateLabels[st] ?? st;
  els.state.innerHTML = `<span class="state-pill ${st}">${label}</span>`;

  els.start.textContent = fmtDate(task.start);
  els.end.textContent = fmtDate(task.end);
  els.products.textContent =
    productCount === 0 ? "Nenhum (agrupamento ou sem geometria)" : `${productCount} elemento(s)`;
}
