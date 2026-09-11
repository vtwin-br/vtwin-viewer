import "./styles.css";
import { createViewer, loadIfc, unloadIfc, refitViewerCamera } from "./viewer/setupWorld";
import { ScheduleHighlighter } from "./viewer/highlight";
import { parseSchedule } from "./schedule/parseSchedule";
import { computeStateBuckets } from "./schedule/simulation";
import { emptySchedule } from "./schedule/range";
import { TaskTreeUI } from "./ui/taskTree";
import { TimelineUI } from "./ui/timeline";
import { InspectorUI } from "./ui/inspector";
import { SimHud } from "./ui/simHud";
import { GoogleEarthLayer, type AnchorLLA } from "./viewer/earthTiles";
import { EarthPanel } from "./ui/earthPanel";
import { ModelGizmo } from "./viewer/modelGizmo";
import { emptyExtraTransform, extraIsIdentity, georefSourceLabel, hasStoredSiteElevation } from "./ifc/georef";
import { initPanelSplitters, constrainPanelWidths } from "./ui/splitters";
import { initModuleNav } from "./ui/moduleNav";
import { initAppShell } from "./ui/appShell";
import { ProjectWorkspace } from "./ui/projectWorkspace";
import { IfcSession, type TaskPatch } from "./ifc/ifcSession";
import { computeCostProgress, formatMoney } from "./schedule/cost";
import type { ScheduleData, Task } from "./schedule/types";
import { FirstPersonController } from "./viewer/firstPerson";
import { BoxSelectController } from "./viewer/boxSelect";
import { IfcSpatialTree } from "./ui/ifcTree";
import { SelectionSetsList } from "./ui/selectionSets";

const WASM_URL = "/wasm/";
const MODEL_ID = "main";

async function main() {
  const overlay = document.getElementById("loader-overlay")!;
  const overlayText = document.getElementById("loader-text")!;
  const overlayHint = document.getElementById("loader-hint");
  const importOverlay = document.getElementById("import-overlay");
  const fileNameEl = document.getElementById("file-name")!;
  const scheduleNameEl = document.getElementById("schedule-name")!;
  const currentDateEl = document.getElementById("current-date")!;
  const treeEl = document.getElementById("task-tree")!;
  const timelineEl = document.getElementById("timeline")!;
  const viewportEl = document.getElementById("viewport")!;
  const viewportShell = document.getElementById("viewport-wrapper")!;
  const taskSearch = document.getElementById("task-search") as HTMLInputElement | null;
  const fileInput = document.getElementById("ifc-file-input") as HTMLInputElement | null;
  const btnShare = document.getElementById("btn-share");
  const btnShareLabel = document.getElementById("btn-share-label");
  const btnExport = document.getElementById("btn-export") as HTMLButtonElement | null;
  const btnExportLabel = document.getElementById("btn-export-label");
  const btnImport = document.getElementById("btn-import");
  const btnOpenIfc = document.getElementById("btn-open-ifc");
  const btnImportPick = document.getElementById("btn-import-pick");
  const btnFit = document.getElementById("btn-fit");
  const btnWalk = document.getElementById("btn-walk") as HTMLButtonElement | null;
  const walkOverlay = document.getElementById("walk-overlay");
  const walkHint = document.getElementById("walk-hint");
  const btnEarth = document.getElementById("btn-earth") as HTMLButtonElement | null;
  const btnEarthSettings = document.getElementById("btn-earth-settings") as HTMLButtonElement | null;
  const btnHudCost = document.getElementById("btn-hud-cost") as HTMLButtonElement | null;

  const inspectorEls = {
    empty: document.getElementById("inspector-empty")!,
    body: document.getElementById("inspector-body")!,
    count: document.getElementById("inspector-count")!,
    state: document.getElementById("prop-state")!,
    name: document.getElementById("prop-name") as HTMLInputElement,
    ident: document.getElementById("prop-ident") as HTMLInputElement,
    start: document.getElementById("prop-start") as HTMLInputElement,
    end: document.getElementById("prop-end") as HTMLInputElement,
    cost: document.getElementById("prop-cost") as HTMLInputElement,
    duration: document.getElementById("prop-duration")!,
    products: document.getElementById("prop-products")!,
    dateError: document.getElementById("prop-date-error")!,
    form: document.getElementById("inspector-form") as HTMLFormElement,
    costRollRow: document.getElementById("prop-cost-roll-row")!,
    costRoll: document.getElementById("prop-cost-roll")!,
  };

  let ifcSession: IfcSession | null = null;
  let selectedTask: Task | null = null;
  let lastDate = new Date();
  let scheduleRef: ScheduleData | null = null;
  let highlighter: ScheduleHighlighter | null = null;
  let simHud: SimHud | null = null;
  let loading = false;
  let dirty = true;
  let applying = false;

  let applyTaskEdit: (task: Task, patch: TaskPatch) => void = () => {};

  const inspector = new InspectorUI({
    els: inspectorEls,
    onEdit: (task, patch) => applyTaskEdit(task, patch),
  });

  const grid = document.querySelector(".body-grid") as HTMLElement | null;
  initPanelSplitters();
  const toggleSchedule = document.getElementById("toggle-schedule");
  const scheduleCountEl = document.getElementById("schedule-count");
  const costHudEl = document.getElementById("cost-5d");
  const simKicker = document.querySelector(".sim-kicker");
  const projectRoot = document.getElementById("project-workspace");

  let refreshNavInspector = () => {};
  let shell: ReturnType<typeof initAppShell> | null = null;

  const setPanelOpen = (panel: "schedule" | "inspector", open: boolean) => {
    if (!grid) return;
    grid.classList.toggle(`${panel}-collapsed`, !open);
    if (panel === "schedule") {
      toggleSchedule?.classList.toggle("is-active", open);
      toggleSchedule?.setAttribute("aria-pressed", open ? "true" : "false");
    }
    refreshNavInspector();
    shell?.refresh();
    constrainPanelWidths();
  };

  const projectWs = projectRoot
    ? new ProjectWorkspace(projectRoot, {
        getIfcSchedule: () => scheduleRef,
        getIfcFileName: () => ifcSession?.fileName ?? null,
        onRequestIfcImport: () => fileInput?.click(),
        onPlanChange: () => {
          /* o nome do Gantt fica na toolbar da tela — o header mostra o IFC */
        },
        onSelectTask: (task) => highlightPlanTask(task),
        onToggleModel: () => togglePlanModel(),
      })
    : null;

  let pauseTimeline = () => {};
  let highlightPlanTask: (task: { linkedIfcTaskId?: number } | null) => void = () => {};
  let togglePlanModel = () => {};
  let setPlanModelOpen = (_open: boolean) => {};

  const nav = initModuleNav({
    inspectorOpen: () => !grid?.classList.contains("inspector-collapsed"),
    onToggleInspector: () => {
      setPanelOpen("inspector", !!grid?.classList.contains("inspector-collapsed"));
    },
    onRevealSchedule: () => setPanelOpen("schedule", true),
    onWorkspaceChange: (id) => {
      if (id === "project-plan") {
        pauseTimeline();
        setPanelOpen("inspector", false);
        void highlighter?.revealAll();
        if (!projectWs?.getPlan() && scheduleRef?.roots.length) {
          projectWs?.bindFromIfc(scheduleRef, ifcSession?.fileName);
        }
        if (simKicker) simKicker.textContent = "Planejamento";
        currentDateEl.textContent = ifcSession?.fileName ?? "Sem modelo IFC";
      } else {
        setPlanModelOpen(false);
        dirty = true;
        if (simKicker) simKicker.textContent = "Simulação";
        currentDateEl.textContent = formatDateLabel(lastDate);
      }
      projectWs?.setActive(id === "project-plan");
    },
  });
  refreshNavInspector = () => nav.refreshInspectorToggle();
  projectWs?.setActive(nav.getWorkspace() === "project-plan");
  if (nav.getWorkspace() === "project-plan") {
    setPanelOpen("inspector", false);
    if (simKicker) simKicker.textContent = "Planejamento";
    currentDateEl.textContent = "Sem modelo IFC";
  }

  const navEl = document.getElementById("module-nav");
  if (grid && navEl) {
    shell = initAppShell({
      grid,
      nav: navEl,
      inspectorOpen: () => !grid.classList.contains("inspector-collapsed"),
      scheduleOpen: () => !grid.classList.contains("schedule-collapsed"),
      setInspectorOpen: (open) => setPanelOpen("inspector", open),
      setScheduleOpen: (open) => setPanelOpen("schedule", open),
      setNavCollapsed: (collapsed) => nav.setCollapsed(collapsed),
      isNavCollapsed: () => nav.isCollapsed(),
      constrainPanels: constrainPanelWidths,
    });
  }

  document.getElementById("toggle-inspector-panel")?.addEventListener("click", () => {
    shell?.closeNavDrawer();
    setPanelOpen("inspector", !!grid?.classList.contains("inspector-collapsed"));
  });
  document.getElementById("btn-reveal-schedule")?.addEventListener("click", () => {
    shell?.closeNavDrawer();
    setPanelOpen("schedule", true);
  });

  toggleSchedule?.addEventListener("click", () => {
    setPanelOpen("schedule", !!grid?.classList.contains("schedule-collapsed"));
  });
  if (window.matchMedia("(max-width: 1279px)").matches) {
    setPanelOpen("schedule", false);
  }

  const setStatus = (txt: string) => {
    overlayText.textContent = txt;
  };

  const refreshInspector = () => {
    if (!scheduleRef) {
      inspector.update(null, lastDate, 0);
      return;
    }
    const n =
      selectedTask == null
        ? 0
        : (scheduleRef.productGuidsByTask.get(selectedTask.id)?.length ?? selectedTask.productGuids.length);
    inspector.update(selectedTask, lastDate, n);
  };

  const refreshHud = () => {
    simHud?.update(lastDate, selectedTask?.id ?? null);
  };

  const refreshCost5d = () => {
    const currency = scheduleRef?.currency ?? "BRL";
    inspector.currency = currency;
    if (!scheduleRef || scheduleRef.roots.length === 0) {
      if (costHudEl) {
        costHudEl.textContent = "—";
        costHudEl.classList.add("is-empty");
      }
      refreshHud();
      return;
    }
    const { accrued, total } = computeCostProgress(scheduleRef, lastDate, false);
    if (total <= 0) {
      if (costHudEl) {
        costHudEl.textContent = "Sem custos 5D";
        costHudEl.classList.add("is-empty");
      }
      refreshHud();
      return;
    }
    const acc = formatMoney(accrued, currency);
    const tot = formatMoney(total, currency);
    if (costHudEl) {
      costHudEl.textContent = `${acc} / ${tot}`;
      costHudEl.classList.remove("is-empty");
    }
    refreshHud();
  };

  const setImportVisible = (open: boolean) => {
    importOverlay?.classList.toggle("is-hidden", !open);
  };

  const setLoading = (open: boolean, hint?: string) => {
    overlay.classList.toggle("hidden", !open);
    if (open) overlay.style.background = "";
    overlayText.style.color = "";
    if (hint && overlayHint) overlayHint.textContent = hint;
  };

  const setFileLabel = (name: string, dirty = false) => {
    fileNameEl.dataset.base = name;
    fileNameEl.textContent = dirty ? `${name} •` : name;
    fileNameEl.title = dirty ? "Há alterações por exportar" : name;
  };

  const markIfcDirty = () => {
    btnExport?.classList.add("is-dirty");
    btnExport?.classList.remove("is-exported");
    if (btnExportLabel) btnExportLabel.textContent = "Exportar IFC";
    const base = fileNameEl.dataset.base || "modelo.ifc";
    setFileLabel(base, true);
  };

  const exportIfc = () => {
    if (!ifcSession) return;
    try {
      ifcSession.download();
      btnExport?.classList.remove("is-dirty");
      btnExport?.classList.add("is-exported");
      if (btnExportLabel) btnExportLabel.textContent = "IFC exportado";
      const base = fileNameEl.dataset.base || ifcSession.fileName;
      setFileLabel(base, false);
      setTimeout(() => {
        btnExport?.classList.remove("is-exported");
        if (ifcSession?.dirty) {
          btnExport?.classList.add("is-dirty");
          setFileLabel(base, true);
        }
        if (btnExportLabel) btnExportLabel.textContent = "Exportar IFC";
      }, 1800);
    } catch (err) {
      console.error(err);
      window.alert(`Não foi possível exportar o IFC: ${(err as Error).message}`);
    }
  };

  btnShare?.addEventListener("click", async () => {
    const btn = btnShare;
    if (!btn) return;
    const url = window.location.href;
    const restore = () => {
      btn.classList.remove("is-copied");
      if (btnShareLabel) btnShareLabel.textContent = "Compartilhar";
    };
    try {
      await navigator.clipboard.writeText(url);
      btn.classList.add("is-copied");
      if (btnShareLabel) btnShareLabel.textContent = "Link copiado";
      setTimeout(restore, 1800);
    } catch {
      window.prompt("Copie o link:", url);
    }
  });

  const placeholder = emptySchedule();
  scheduleNameEl.textContent = "Importe um arquivo IFC";
  if (scheduleCountEl) scheduleCountEl.textContent = "0";
  if (btnExport) btnExport.disabled = true;

  const tree = new TaskTreeUI({
    container: treeEl,
    schedule: placeholder,
    onSelect: (task) => {
      selectedTask = task;
      simHud?.setSelected(task?.id ?? null);
      if (!task) {
        highlighter?.clearSelection();
        refreshInspector();
        return;
      }
      setPanelOpen("inspector", true);
      const gids = scheduleRef?.productGuidsByTask.get(task.id) ?? task.productGuids;
      highlighter?.selectByGuids(gids);
      refreshInspector();
    },
    onEdit: (task, patch) => applyTaskEdit(task, patch),
  });

  const simHudRoot = document.getElementById("sim-hud");
  if (simHudRoot) {
    simHud = new SimHud({
      root: simHudRoot,
      onPhaseSelect: (task) => tree.selectById(task.id),
    });
  }
  btnHudCost?.addEventListener("click", () => {
    const open = btnHudCost.getAttribute("aria-pressed") !== "true";
    btnHudCost.classList.toggle("is-active", open);
    btnHudCost.setAttribute("aria-pressed", open ? "true" : "false");
    simHud?.setCostPanelOpen(open);
  });

  const headerCenter = document.querySelector(".header-center");
  const timeline = new TimelineUI({
    container: timelineEl,
    schedule: placeholder,
    onDateChange: (date) => {
      lastDate = date;
      dirty = true;
      currentDateEl.textContent = formatDateLabel(date);
      tree.update(date);
      refreshInspector();
      refreshCost5d();
    },
    onPlayingChange: (playing) => {
      headerCenter?.classList.toggle("is-playing", playing);
      dirty = true;
      refreshCost5d();
    },
  });
  timeline.setIdle(true);
  pauseTimeline = () => timeline.pause();

  applyTaskEdit = (task, patch) => {
    if (!ifcSession || !scheduleRef) return;
    const { changed, timeChanged } = ifcSession.applyTaskEdit(task.id, patch);
    if (!changed) return;
    tree.refreshLayout();
    if (timeChanged) {
      timeline.setRange(scheduleRef.minDate, scheduleRef.maxDate);
      dirty = true;
    } else {
      tree.update(lastDate);
    }
    if (scheduleCountEl) {
      scheduleCountEl.textContent = String(scheduleRef.leafTaskCount);
      scheduleCountEl.title = `${scheduleRef.leafTaskCount} tarefas-folha`;
    }
    markIfcDirty();
    refreshInspector();
    refreshCost5d();
  };

  try {
    setStatus("Inicializando o visualizador…");
    const viewer = await createViewer(viewportEl);
    let modelGizmo: ModelGizmo | null = null;
    let walk: FirstPersonController | null = null;
    let lastWalkFragUpdate = 0;
    let boxSelect: BoxSelectController | null = null;
    let refreshWorkingUi = () => {};
    let renderSets = () => {};
    let bindSpatialTree = () => {};
    const btnBoxSelect = document.getElementById("btn-box-select");
    const btnNewSet = document.getElementById("btn-new-set");
    const btnNewSetPanel = document.getElementById("btn-new-set-panel");
    const btnAssignSet = document.getElementById("btn-assign-set");
    const modelSetsCount = document.getElementById("model-sets-count");
    const ifcTreeSearch = document.getElementById("ifc-tree-search") as HTMLInputElement | null;

    const linkHint = document.getElementById("link-mode-hint");
    let pendingPlanModel = false;
    setPlanModelOpen = (open) => {
      grid?.classList.toggle("model-open", open);
      projectWs?.setModelOpen(open);
      if (linkHint) linkHint.hidden = !(open && nav.getWorkspace() === "project-plan");
      const setsEl = document.getElementById("model-sets");
      if (setsEl) setsEl.hidden = !(open && nav.getWorkspace() === "project-plan");
      if (open) {
        setPanelOpen("inspector", false);
        pauseTimeline();
        void highlighter?.revealAll().then(() => {
          highlightPlanTask(projectWs?.getSelected() ?? null);
        });
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event("resize"));
          void refitViewerCamera(viewer, MODEL_ID);
        });
      } else {
        boxSelect?.setToolEnabled(false);
        btnBoxSelect?.classList.remove("is-active");
        btnBoxSelect?.setAttribute("aria-pressed", "false");
      }
    };
    togglePlanModel = () => {
      if (!ifcSession) {
        pendingPlanModel = true;
        fileInput?.click();
        return;
      }
      setPlanModelOpen(!grid?.classList.contains("model-open"));
    };
    highlightPlanTask = (task) => {
      if (!highlighter) return;
      if (!task?.linkedIfcTaskId || !scheduleRef) {
        void highlighter.clearSelection().then(() => refreshWorkingUi());
        renderSets();
        return;
      }
      const gids = scheduleRef.productGuidsByTask.get(task.linkedIfcTaskId) ?? [];
      void highlighter.selectByGuids(gids).then(() => refreshWorkingUi());
      renderSets();
    };

    btnFit?.addEventListener("click", () => {
      if (walk?.enabled) {
        walk.respawn();
        return;
      }
      void refitViewerCamera(viewer, MODEL_ID);
    });

    let pickDown: { x: number; y: number } | null = null;
    viewportEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      pickDown = { x: e.clientX, y: e.clientY };
    });
    viewportEl.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || !pickDown) return;
      const moved = Math.hypot(e.clientX - pickDown.x, e.clientY - pickDown.y);
      pickDown = null;
      if (moved > 6) return;
      if (boxSelect?.isDragging() || boxSelect?.isToolEnabled()) return;
      void pickTaskFromModel(e);
    });

    const pickTaskFromModel = async (e: PointerEvent) => {
      if (walk?.enabled) return;
      if (modelGizmo?.isDragging()) return;
      if (!highlighter || !scheduleRef) return;
      const renderer = viewer.world.renderer;
      if (!renderer) return;
      const hit = await highlighter.pickHit(viewer.world.camera.three, e, renderer.three.domElement);
      if (!hit) return;
      const { guid } = hit;

      if (nav.getWorkspace() === "project-plan" && grid?.classList.contains("model-open")) {
        if (e.ctrlKey || e.metaKey) {
          await highlighter.toggleWorkingGuid(guid);
        } else {
          await highlighter.setWorkingSelection([guid]);
        }
        refreshWorkingUi();
        return;
      }

      const task = findTaskForGuid(scheduleRef, guid);
      if (!task) return;
      tree.selectById(task.id);
    };

    const ifcTreeEl = document.getElementById("ifc-tree");
    const setsListEl = document.getElementById("selection-sets");
    const ifcTree = ifcTreeEl
      ? new IfcSpatialTree(ifcTreeEl, {
          onSelect: (guids, additive) => {
            if (!highlighter) return;
            void (additive ? highlighter.addWorkingGuids(guids) : highlighter.setWorkingSelection(guids)).then(() =>
              refreshWorkingUi(),
            );
          },
        })
      : null;
    const setsList = setsListEl
      ? new SelectionSetsList(setsListEl, {
          onCreate: () => createSetFromSelection(),
          onRename: (id, name) => {
            try {
              ifcSession?.renameGroup(id, name);
              markIfcDirty();
              renderSets();
            } catch (err) {
              projectWs?.notify((err as Error).message);
            }
          },
          onDelete: (id) => {
            if (!ifcSession) return;
            if (!window.confirm("Apagar este IfcGroup do modelo?")) return;
            try {
              ifcSession.deleteGroup(id);
              markIfcDirty();
              projectWs?.applyProductGuids(projectWs.getSelected()?.linkedIfcTaskId ?? 0, []);
              renderSets();
              projectWs?.notify("Conjunto removido do IFC.");
            } catch (err) {
              projectWs?.notify((err as Error).message);
            }
          },
          onSelect: (id) => {
            const group = scheduleRef?.groups.find((g) => g.id === id);
            if (!group || !highlighter) return;
            void highlighter.setWorkingSelection(group.productGuids).then(() => refreshWorkingUi());
            renderSets();
          },
          onAddSelection: (id) => {
            if (!ifcSession || !highlighter) return;
            const extra = highlighter.getWorkingGuids();
            const group = scheduleRef?.groups.find((g) => g.id === id);
            if (!group) return;
            const members = new Map(group.productGuids.map((g, i) => [g, group.productIds[i]]));
            for (const g of extra) {
              if (!members.has(g)) members.set(g, highlighter.localIdOf(g) ?? 0);
            }
            try {
              ifcSession.setGroupMembers(
                id,
                [...members.entries()].map(([guid, expressId]) => ({ guid, expressId })),
              );
              markIfcDirty();
              projectWs?.applyProductGuids(projectWs.getSelected()?.linkedIfcTaskId ?? 0, []);
              renderSets();
              projectWs?.notify("Seleção adicionada ao conjunto (IfcRelAssignsToGroup).");
            } catch (err) {
              projectWs?.notify((err as Error).message);
            }
          },
          onAssign: (id) => assignGroupToSelectedTask(id),
        })
      : null;

    refreshWorkingUi = () => {
      const n = highlighter?.getWorkingGuids().length ?? 0;
      if (modelSetsCount) {
        modelSetsCount.textContent = `${n} selecionado${n === 1 ? "" : "s"}`;
      }
      ifcTree?.setActiveGuids(highlighter?.getWorkingGuids() ?? []);
    };

    renderSets = () => {
      setsList?.setTaskId(projectWs?.getSelected()?.linkedIfcTaskId ?? null);
      setsList?.render(scheduleRef?.groups ?? []);
    };

    const createSetFromSelection = () => {
      if (!ifcSession || !highlighter) {
        projectWs?.notify("Importe um IFC primeiro.");
        return;
      }
      const guids = highlighter.getWorkingGuids();
      if (!guids.length) {
        projectWs?.notify("Selecione elementos no modelo, na caixa ou na árvore.");
        return;
      }
      const name = window.prompt("Nome do conjunto (IfcGroup)", "Estacas")?.trim();
      if (!name) return;
      try {
        const hl = highlighter;
        const group = ifcSession.createGroup(
          name,
          guids.map((guid) => ({ guid, expressId: hl.localIdOf(guid) })),
        );
        setsList?.setSelected(group.id);
        markIfcDirty();
        renderSets();
        document.querySelectorAll("[data-ms-tab]").forEach((btn) => {
          const on = btn.getAttribute("data-ms-tab") === "sets";
          btn.classList.toggle("is-active", on);
          btn.setAttribute("aria-selected", on ? "true" : "false");
        });
        document.querySelectorAll("[data-ms-pane]").forEach((pane) => {
          pane.classList.toggle("is-hidden", pane.getAttribute("data-ms-pane") !== "sets");
        });
        projectWs?.notify(`Conjunto «${group.name}» gravado como IfcGroup.`);
      } catch (err) {
        projectWs?.notify((err as Error).message);
      }
    };

    const assignGroupToSelectedTask = (groupId: number) => {
      const task = projectWs?.getSelected();
      if (!task?.linkedIfcTaskId) {
        projectWs?.notify("Selecione no Gantt uma tarefa com ponto azul (IfcTask nativa).");
        return;
      }
      if (!ifcSession) return;
      try {
        const { added, guids } = ifcSession.assignGroupToTask(task.linkedIfcTaskId, groupId);
        projectWs?.applyProductGuids(task.linkedIfcTaskId, guids);
        void highlighter?.selectByGuids(guids).then(() => refreshWorkingUi());
        markIfcDirty();
        renderSets();
        projectWs?.notify(
          added
            ? "Conjunto ligado à tarefa (IfcRelAssignsToProcess + produtos)."
            : "Conjunto desligado da tarefa.",
        );
      } catch (err) {
        projectWs?.notify((err as Error).message);
      }
    };

    boxSelect = new BoxSelectController({
      viewport: viewportEl,
      camera: viewer.world.camera as unknown as { three: import("three").Camera; setUserInput: (on: boolean) => void },
      highlighter: () => highlighter,
      onPicked: (guids, mode) => {
        if (!highlighter) return;
        const run =
          mode === "add"
            ? highlighter.addWorkingGuids(guids)
            : mode === "remove"
              ? highlighter.removeWorkingGuids(guids)
              : highlighter.setWorkingSelection(guids);
        void run.then(() => refreshWorkingUi());
      },
    });

    btnBoxSelect?.addEventListener("click", () => {
      const next = !boxSelect?.isToolEnabled();
      boxSelect?.setToolEnabled(!!next);
      btnBoxSelect.classList.toggle("is-active", !!next);
      btnBoxSelect.setAttribute("aria-pressed", next ? "true" : "false");
    });
    btnNewSet?.addEventListener("click", () => createSetFromSelection());
    btnNewSetPanel?.addEventListener("click", () => createSetFromSelection());
    btnAssignSet?.addEventListener("click", () => {
      const id = setsList?.getSelected();
      if (id == null) {
        projectWs?.notify("Selecione um conjunto no painel à direita.");
        return;
      }
      assignGroupToSelectedTask(id);
    });
    ifcTreeSearch?.addEventListener("input", () => ifcTree?.setFilter(ifcTreeSearch.value));
    document.querySelectorAll("[data-ms-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-ms-tab");
        document.querySelectorAll("[data-ms-tab]").forEach((b) => {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
        document.querySelectorAll("[data-ms-pane]").forEach((pane) => {
          pane.classList.toggle("is-hidden", pane.getAttribute("data-ms-pane") !== tab);
        });
      });
    });

    bindSpatialTree = () => {
      if (!highlighter) return;
      void ifcTree?.bind(highlighter.getModel(), highlighter);
      renderSets();
    };

    const FALLBACK_ANCHOR: AnchorLLA = {
      lat: -23.5614,
      lon: -46.6559,
      altitude: 0,
      heading: 0,
    };
    const apiKey = (import.meta.env?.VITE_GOOGLE_MAP_TILES_API_KEY as string | undefined) ?? "";
    let applyTerrainSnap: (alt: number) => void = () => {};
    let earthPanel: EarthPanel | null = null;
    const earth = new GoogleEarthLayer(viewer.world, {
      apiKey,
      anchor: FALLBACK_ANCHOR,
      hideRadiusMeters: 0,
      onTerrainSnap: (alt) => applyTerrainSnap(alt),
      onTerrainSnapFail: () => {
        earthPanel?.setTerrainHeight(null, "sem malha — clica Assentar outra vez");
      },
    });

    const setEarthPanelOpen = (open: boolean) => {
      if (open) earthPanel?.show();
      else earthPanel?.hide();
      btnEarthSettings?.classList.toggle("is-active", open);
      btnEarthSettings?.setAttribute("aria-pressed", open ? "true" : "false");
      if (btnEarthSettings) {
        btnEarthSettings.title = open ? "Ocultar parâmetros do terreno" : "Mostrar parâmetros do terreno";
      }
    };

    const gizmo = new ModelGizmo({
      scene: viewer.world.scene.three,
      camera: viewer.world.camera as import("@thatopen/components").OrthoPerspectiveCamera,
      domElement: viewer.world.renderer!.three.domElement,
      onChange: (t) => {
        earth.setClipCenter(t.x, t.y, t.z);
        earthPanel?.setTransform(t);
        ifcSession?.setExtraTransform(t);
        if (ifcSession && !extraIsIdentity(t)) markIfcDirty();
      },
    });
    viewer.world.onCameraChanged.add(() => gizmo.updateCamera());
    modelGizmo = gizmo;
    applyTerrainSnap = (alt) => {
      earthPanel?.setTerrainHeight(alt);
      const a = earth.getAnchor();
      if (ifcSession) {
        ifcSession.setGeoAnchor({ lat: a.lat, lon: a.lon, elevation: alt });
        markIfcDirty();
      }
      const t = gizmo.read();
      if (Math.abs(t.y) > 80) {
        const next = { ...t, y: 0 };
        gizmo.apply(next);
        earth.setClipCenter(next.x, next.y, next.z);
        earthPanel?.setTransform(next);
        ifcSession?.setExtraTransform(next);
      }
    };

    const earthPanelRoot = document.getElementById("earth-panel");
    earthPanel = earthPanelRoot
      ? new EarthPanel(earthPanelRoot, {
          initial: {
            anchor: earth.getAnchor(),
            hideRadius: earth.getHideRadius(),
            transform: emptyExtraTransform(),
          },
          onChange: (state) => {
            const prev = earth.getAnchor();
            earth.setAnchor({ ...state.anchor, altitude: earth.getAnchor().altitude });
            earth.setHideRadius(state.hideRadius);
            const geoMoved = prev.lat !== state.anchor.lat || prev.lon !== state.anchor.lon;
            if (geoMoved && ifcSession) {
              const a = earth.getAnchor();
              ifcSession.setGeoAnchor({
                lat: state.anchor.lat,
                lon: state.anchor.lon,
                elevation: a.altitude,
              });
              markIfcDirty();
            }
          },
          onTransformChange: (t) => {
            gizmo.apply(t);
            earth.setClipCenter(t.x, t.y, t.z);
            ifcSession?.setExtraTransform(t);
            if (ifcSession && !extraIsIdentity(t)) markIfcDirty();
          },
          onModeChange: (mode) => gizmo.setMode(mode),
          onSnapTerrain: () => {
            earthPanel?.setTerrainHeight(null, "a amostrar…");
            earth.requestTerrainSnap();
          },
          onDismiss: () => {
            setEarthPanelOpen(false);
          },
        })
      : null;

    const setEarthEnabledUi = (enabled: boolean) => {
      btnEarth?.classList.toggle("is-active", enabled);
      btnEarth?.setAttribute("aria-pressed", enabled ? "true" : "false");
      if (btnEarth) btnEarth.title = enabled ? "Ocultar contexto Google Earth" : "Mostrar contexto Google Earth";
      gizmo.setVisible(enabled && !walk?.enabled);
      if (btnEarthSettings) btnEarthSettings.hidden = !enabled;
      if (enabled && !walk?.enabled) setEarthPanelOpen(true);
      else if (!enabled) setEarthPanelOpen(false);
    };

    const canvas = viewer.world.renderer!.three.domElement;
    if (btnWalk && walkOverlay && walkHint) {
      walk = new FirstPersonController({
        camera: viewer.world.camera as import("@thatopen/components").OrthoPerspectiveCamera,
        domElement: canvas,
        overlay: walkOverlay,
        hint: walkHint,
        button: btnWalk,
        earth,
        onEnabledChange: (on) => {
          gizmo.setVisible(earth.enabled && !on);
          if (on) setEarthPanelOpen(false);
        },
        onCameraMove: () => {
          const t = performance.now();
          if (t - lastWalkFragUpdate < 48) return;
          lastWalkFragUpdate = t;
          void viewer.fragments.core.update();
        },
      });
    }

    btnEarthSettings?.addEventListener("click", () => {
      if (!earth.enabled) return;
      setEarthPanelOpen(!earthPanel?.isVisible());
    });

    btnEarth?.addEventListener("click", async () => {
      if (!apiKey) {
        window.alert(
          "Para ativar a camada Google Earth define a variavel VITE_GOOGLE_MAP_TILES_API_KEY " +
            "(num arquivo .env na raiz) com a tua chave da Google Map Tiles API e reinicia o dev server.",
        );
        return;
      }
      const next = !earth.enabled;
      try {
        await earth.setEnabled(next);
        setEarthEnabledUi(earth.enabled);
        if (walk?.enabled) earth.setWalkQuality(true);
      } catch (err) {
        console.error("Falha a (des)ativar Google Earth:", err);
        window.alert(`Nao foi possivel ativar a camada Google Earth: ${(err as Error).message}`);
      }
    });

    const loadFromBuffer = async (buffer: Uint8Array, fileName: string) => {
      setImportVisible(false);
      setLoading(true, "O modelo 3D e o cronograma nativo entram em seguida.");
      setStatus("Lendo o cronograma do IFC…");
      const schedule = await parseSchedule(buffer, WASM_URL);

      setStatus("Convertendo o modelo 3D…");
      highlighter = null;
      timeline.pause();
      gizmo.attach(null);
      await walk?.setModel(null);
      await unloadIfc(viewer, MODEL_ID);
      const { model } = await loadIfc(viewer, buffer.slice(), MODEL_ID, (p) =>
        setStatus(`Convertendo IFC… ${(p * 100).toFixed(0)}%`),
      );

      scheduleRef = schedule;
      ifcSession = new IfcSession(buffer, fileName, schedule);
      setFileLabel(fileName);
      scheduleNameEl.textContent =
        schedule.workPlanName && schedule.workPlanName !== schedule.name
          ? `${schedule.name} · ${schedule.workPlanName}`
          : schedule.name;
      scheduleNameEl.title = schedule.documents.length
        ? `IfcWorkSchedule nativo. Documentos: ${schedule.documents.map((d) => d.name).join(", ")}`
        : "IfcWorkPlan / IfcWorkSchedule / IfcTask";
      projectWs?.bindFromIfc(schedule, fileName);
      if (scheduleCountEl) {
        scheduleCountEl.textContent = String(schedule.leafTaskCount);
        scheduleCountEl.title = `${schedule.leafTaskCount} tarefas-folha`;
      }
      if (btnExport) btnExport.disabled = false;
      btnExport?.classList.remove("is-dirty", "is-exported");
      if (btnExportLabel) btnExportLabel.textContent = "Exportar IFC";

      selectedTask = null;
      if (taskSearch) taskSearch.value = "";
      tree.setSchedule(schedule);
      tree.setFilter("");
      simHud?.bind(schedule);
      timeline.bindSchedule(schedule);
      timeline.setIdle(false);

      const allGuids = collectAllGuids(schedule);
      setStatus(`Mapeando ${allGuids.size} elementos para a simulação…`);
      highlighter = new ScheduleHighlighter(model, viewer.fragments, allGuids);
      await highlighter.ready();
      bindSpatialTree();
      if (pendingPlanModel && nav.getWorkspace() === "project-plan") {
        pendingPlanModel = false;
        setPlanModelOpen(true);
      }

      const georef = schedule.georef;
      const storedAlt = georef?.elevation;
      const hasAlt = hasStoredSiteElevation(storedAlt);
      const anchor: AnchorLLA =
        georef?.lat != null && georef.lon != null
          ? {
              lat: georef.lat,
              lon: georef.lon,
              altitude: hasAlt ? storedAlt! : 0,
              heading: georef.heading,
            }
          : { ...FALLBACK_ANCHOR, heading: georef?.heading ?? 0 };
      earth.setAnchor(anchor, { snap: !hasAlt && earth.enabled });
      earth.setClipCenter(0, 0, 0);
      earthPanel?.setState({
        anchor,
        hideRadius: earth.getHideRadius(),
        transform: emptyExtraTransform(),
      });
      if (hasAlt) {
        earthPanel?.setTerrainHeight(anchor.altitude);
      } else {
        earthPanel?.setTerrainHeight(null, earth.enabled ? "a amostrar o terreno…" : "Assentar grava a cota no IFC");
      }
      earthPanel?.setSource(georef ? georefSourceLabel(georef) : "IFC sem coordenadas geográficas");
      gizmo.attach(model.object);
      gizmo.reset();
      gizmo.fitSize(model.object);
      gizmo.setVisible(earth.enabled && !walk?.enabled);
      void walk?.setModel(model);

      lastDate = schedule.minDate;
      dirty = true;
      tree.update(lastDate);
      currentDateEl.textContent = formatDateLabel(lastDate);
      refreshInspector();
      refreshCost5d();
      setLoading(false);
    };

    const pickIfcFile = () => fileInput?.click();

    const importFile = async (file: File) => {
      if (loading) return;
      if (!isIfcFile(file)) {
        window.alert("Selecione um arquivo IFC (.ifc).");
        return;
      }
      if (ifcSession?.dirty) {
        const ok = window.confirm(
          "Há alterações no IFC que ainda não foram exportadas. Importar outro arquivo descarta essas alterações.",
        );
        if (!ok) return;
      }
      loading = true;
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        await loadFromBuffer(buffer, file.name);
      } catch (err) {
        console.error(err);
        window.alert(`Não foi possível importar o IFC: ${(err as Error).message}`);
        if (!highlighter) {
          ifcSession = null;
          scheduleRef = null;
          selectedTask = null;
          tree.setSchedule(emptySchedule());
          timeline.bindSchedule(emptySchedule());
          timeline.setIdle(true);
          simHud?.bind(null);
          if (btnExport) btnExport.disabled = true;
          setFileLabel("Importar IFC…");
          scheduleNameEl.textContent = "Importe um arquivo IFC";
          if (scheduleCountEl) scheduleCountEl.textContent = "0";
          refreshInspector();
          refreshCost5d();
          setImportVisible(true);
        }
        setLoading(false);
      } finally {
        loading = false;
        if (fileInput) fileInput.value = "";
      }
    };

    const onPickFile = () => {
      const file = fileInput?.files?.[0];
      if (file) void importFile(file);
    };

    fileInput?.addEventListener("change", onPickFile);
    btnImport?.addEventListener("click", pickIfcFile);
    btnOpenIfc?.addEventListener("click", pickIfcFile);
    btnImportPick?.addEventListener("click", pickIfcFile);
    btnExport?.addEventListener("click", exportIfc);

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      viewportShell.classList.add("is-drop-target");
    };
    const onDragLeave = (e: DragEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && viewportShell.contains(next)) return;
      viewportShell.classList.remove("is-drop-target");
    };
    viewportShell.addEventListener("dragenter", onDragOver);
    viewportShell.addEventListener("dragover", onDragOver);
    viewportShell.addEventListener("dragleave", onDragLeave);
    viewportShell.addEventListener("drop", (e) => {
      e.preventDefault();
      viewportShell.classList.remove("is-drop-target");
      const file = [...(e.dataTransfer?.files ?? [])].find(isIfcFile);
      if (file) void importFile(file);
    });

    window.addEventListener("beforeunload", (e) => {
      if (!ifcSession?.dirty) return;
      e.preventDefault();
      e.returnValue = "";
    });

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
        e.preventDefault();
        exportIfc();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyO") {
        e.preventDefault();
        pickIfcFile();
        return;
      }
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (e.code === "KeyV") {
        e.preventDefault();
        void walk?.toggle();
        return;
      }
      if (walk?.wantsExclusiveKeys()) {
        if (e.code === "KeyF") {
          e.preventDefault();
          walk.respawn();
        }
        return;
      }
      if (nav.getWorkspace() === "project-plan") {
        if (e.code === "KeyM") {
          e.preventDefault();
          togglePlanModel();
          return;
        }
        if (e.code === "KeyF") {
          e.preventDefault();
          void refitViewerCamera(viewer, MODEL_ID);
          return;
        }
        if (e.code === "KeyI") {
          e.preventDefault();
          setPanelOpen("inspector", !!grid?.classList.contains("inspector-collapsed"));
        }
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        timeline.togglePlay();
      } else if (e.code === "Home") {
        e.preventDefault();
        timeline.jumpToStart();
      } else if (e.code === "End") {
        e.preventDefault();
        timeline.jumpToEnd();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        timeline.nudgeDays(e.shiftKey ? -7 : -1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        timeline.nudgeDays(e.shiftKey ? 7 : 1);
      } else if (e.code === "KeyF") {
        e.preventDefault();
        void refitViewerCamera(viewer, MODEL_ID);
      } else if (e.code === "KeyB") {
        e.preventDefault();
        setPanelOpen("schedule", !!grid?.classList.contains("schedule-collapsed"));
      } else if (e.code === "KeyI") {
        e.preventDefault();
        setPanelOpen("inspector", !!grid?.classList.contains("inspector-collapsed"));
      } else if (earth.enabled && (e.code === "KeyG" || e.code === "KeyT")) {
        e.preventDefault();
        gizmo.setMode("translate");
        earthPanel?.setMode("translate");
      } else if (earth.enabled && e.code === "KeyR") {
        e.preventDefault();
        gizmo.setMode("rotate");
        earthPanel?.setMode("rotate");
      }
    });

    const tick = async () => {
      walk?.update();
      if (dirty && !applying && highlighter && scheduleRef) {
        dirty = false;
        applying = true;
        try {
          if (nav.getWorkspace() === "project-plan") {
            await highlighter.revealAll();
          } else {
            const buckets = computeStateBuckets(scheduleRef, lastDate);
            const previewAll = !timeline.playing && timeline.atStart;
            await highlighter.apply(buckets, { previewAll });
          }
        } catch (err) {
          console.error("Erro ao aplicar estado 4D:", err);
        } finally {
          applying = false;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    lastDate = placeholder.minDate;
    currentDateEl.textContent = formatDateLabel(lastDate);
    refreshInspector();
    refreshCost5d();
    setLoading(false);
    setImportVisible(true);
  } catch (err) {
    console.error(err);
    setImportVisible(false);
    overlay.classList.remove("hidden");
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
  for (const group of schedule.groups ?? []) {
    for (const g of group.productGuids) out.add(g);
  }
  return out;
}

function findTaskForGuid(schedule: ScheduleData, guid: string): Task | null {
  let fallback: Task | null = null;
  for (const t of schedule.byId.values()) {
    const list = schedule.productGuidsByTask.get(t.id) ?? t.productGuids;
    if (!list.includes(guid)) continue;
    if (t.children.length === 0) return t;
    if (!fallback) fallback = t;
  }
  return fallback;
}

function isIfcFile(file: File): boolean {
  return /\.ifc$/i.test(file.name);
}

function formatDateLabel(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

main();
