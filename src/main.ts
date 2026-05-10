import "./styles.css";
import { createViewer, loadIfc, refitViewerCamera } from "./viewer/setupWorld";
import { ScheduleHighlighter } from "./viewer/highlight";
import { parseSchedule } from "./schedule/parseSchedule";
import { computeStateBuckets } from "./schedule/simulation";
import { TaskTreeUI } from "./ui/taskTree";
import { TimelineUI } from "./ui/timeline";
import { updateInspector } from "./ui/inspector";
import type { ScheduleData, Task } from "./schedule/types";

const IFC_URL = "/4D.ifc";
const WASM_URL = "/wasm/";

async function main() {
  const overlay = document.getElementById("loader-overlay")!;
  const overlayText = document.getElementById("loader-text")!;
  const fileNameEl = document.getElementById("file-name")!;
  const scheduleNameEl = document.getElementById("schedule-name")!;
  const currentDateEl = document.getElementById("current-date")!;
  const treeEl = document.getElementById("task-tree")!;
  const timelineEl = document.getElementById("timeline")!;
  const viewportEl = document.getElementById("viewport")!;
  const taskSearch = document.getElementById("task-search") as HTMLInputElement | null;
  const btnShare = document.getElementById("btn-share");
  const btnShareLabel = document.getElementById("btn-share-label");
  const btnFit = document.getElementById("btn-fit");

  const inspectorEls = {
    empty: document.getElementById("inspector-empty")!,
    body: document.getElementById("inspector-body")!,
    count: document.getElementById("inspector-count")!,
    name: document.getElementById("prop-name")!,
    ident: document.getElementById("prop-ident")!,
    state: document.getElementById("prop-state")!,
    start: document.getElementById("prop-start")!,
    end: document.getElementById("prop-end")!,
    products: document.getElementById("prop-products")!,
  };

  fileNameEl.textContent = "4D.ifc";

  let selectedTask: Task | null = null;
  let lastDate = new Date();
  let scheduleRef: ScheduleData | null = null;

  const setStatus = (txt: string) => {
    overlayText.textContent = txt;
  };

  const refreshInspector = () => {
    if (!scheduleRef) return;
    const n =
      selectedTask == null
        ? 0
        : (scheduleRef.productGuidsByTask.get(selectedTask.id)?.length ?? selectedTask.productGuids.length);
    updateInspector(inspectorEls, selectedTask, lastDate, n);
  };

  btnShare?.addEventListener("click", async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      if (btnShareLabel) {
        const prev = btnShareLabel.textContent;
        btnShareLabel.textContent = "Link copiado!";
        setTimeout(() => {
          btnShareLabel.textContent = prev ?? "Compartilhar";
        }, 2000);
      }
    } catch {
      window.prompt("Copie o link:", url);
    }
  });

  try {
    setStatus("Inicializando o visualizador…");
    const viewer = await createViewer(viewportEl);

    setStatus("Baixando o arquivo IFC…");
    const resp = await fetch(IFC_URL);
    if (!resp.ok) throw new Error(`Falha ao baixar ${IFC_URL}: ${resp.status}`);
    const buffer = new Uint8Array(await resp.arrayBuffer());

    setStatus("Convertendo IFC e lendo o cronograma…");
    const [{ model }, schedule] = await Promise.all([
      loadIfc(viewer, buffer, "main", (p) =>
        setStatus(`Convertendo IFC… ${(p * 100).toFixed(0)}%`),
      ),
      parseSchedule(buffer, WASM_URL),
    ]);

    scheduleRef = schedule;
    scheduleNameEl.textContent = schedule.name;

    const allGuids = collectAllGuids(schedule);
    setStatus(`Mapeando ${allGuids.size} elementos para a simulação…`);

    const highlighter = new ScheduleHighlighter(model, viewer.fragments, allGuids);
    await highlighter.ready();

    let dirty = true;
    let applying = false;

    const tree = new TaskTreeUI({
      container: treeEl,
      schedule,
      onSelect: (task) => {
        selectedTask = task;
        if (!task) {
          highlighter.clearSelection();
          refreshInspector();
          return;
        }
        const guids = schedule.productGuidsByTask.get(task.id) ?? task.productGuids;
        highlighter.selectByGuids(guids);
        refreshInspector();
      },
    });

    taskSearch?.addEventListener("input", () => {
      tree.setFilter(taskSearch.value);
    });

    btnFit?.addEventListener("click", () => {
      void refitViewerCamera(viewer, "main");
    });

    new TimelineUI({
      container: timelineEl,
      schedule,
      onDateChange: (date) => {
        lastDate = date;
        dirty = true;
        currentDateEl.textContent = formatDateLabel(date);
        tree.update(date);
        refreshInspector();
      },
    });

    const tick = async () => {
      if (dirty && !applying) {
        dirty = false;
        applying = true;
        try {
          const buckets = computeStateBuckets(schedule, lastDate);
          await highlighter.apply(buckets);
        } catch (err) {
          console.error("Erro ao aplicar estado 4D:", err);
        } finally {
          applying = false;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    lastDate = schedule.minDate;
    tree.update(lastDate);
    currentDateEl.textContent = formatDateLabel(lastDate);
    refreshInspector();

    overlay.classList.add("hidden");
  } catch (err) {
    console.error(err);
    overlayText.textContent = `Erro: ${(err as Error).message}`;
    overlay.style.background = "rgba(254, 226, 226, 0.95)";
    overlayText.style.color = "#991b1b";
  }
}

function collectAllGuids(schedule: ScheduleData): Set<string> {
  const out = new Set<string>();
  for (const guids of schedule.productGuidsByTask.values()) {
    for (const g of guids) out.add(g);
  }
  return out;
}

function formatDateLabel(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

main();
