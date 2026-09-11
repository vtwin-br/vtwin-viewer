import "./styles.css";
import { createViewer, loadIfc, loadFragments, exportFragmentsBuffer, unloadIfc, fitCameraToItemSets, fitCameraToVisibleModels } from "./viewer/setupWorld";
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
import { renderModulePlaceholder } from "./ui/modulePlaceholder";
import { findToolByWorkspace, workspaceShell, type WorkspaceId } from "./app/catalog";
import { IfcSession, type TaskPatch } from "./ifc/ifcSession";
import { IfcModelSet, encodeIfcRef, scheduleTitle } from "./ifc/modelSet";
import { ModelLayersUI } from "./ui/modelLayers";
import { prepareIfcForOpen } from "./ifc/stepText";
import { getCachedFragments, hashIfcBytes, saveCachedFragments } from "./ifc/fragCache";
import { computeCostProgress, formatMoney } from "./schedule/cost";
import type { ScheduleData, Task } from "./schedule/types";
import { FirstPersonController } from "./viewer/firstPerson";
import { BoxSelectController } from "./viewer/boxSelect";
import { IfcSpatialTree } from "./ui/ifcTree";
import { SelectionSetsList } from "./ui/selectionSets";

const WASM_URL = "/wasm/";

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

  let models = new IfcModelSet();
  let selectedTask: Task | null = null;
  let lastDate = new Date();
  let scheduleRef: ScheduleData | null = null;
  let highlighter: ScheduleHighlighter | null = null;
  let simHud: SimHud | null = null;
  let loading = false;
  let dirty = true;
  let applying = false;

  const bumpSimulation = (guids?: Iterable<string>) => {
    dirty = true;
    if (guids && highlighter) {
      void highlighter.includeGuids(guids).then(() => {
        dirty = true;
      });
    }
  };

  let applyTaskEdit: (task: Task, patch: TaskPatch) => void = () => {};
  let onGanttNativeChange = (_info: { timeChanged?: boolean; structure?: boolean }) => {};

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
  let openEarthPanel = (_open: boolean) => {};

  type LayoutPanel = "schedule" | "inspector" | "timeline" | "gantt" | "sets";
  const PANEL_LS: Record<LayoutPanel, string> = {
    schedule: "vista4d.scheduleCollapsed",
    inspector: "vista4d.inspectorCollapsed",
    timeline: "vista4d.timelineCollapsed",
    gantt: "vista4d.ganttCollapsed",
    sets: "vista4d.setsCollapsed",
  };

  const readCollapsed = (key: string, fallback = false): boolean => {
    try {
      const v = localStorage.getItem(key);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch {
      /* ignore */
    }
    return fallback;
  };

  const writeCollapsed = (key: string, collapsed: boolean): void => {
    try {
      localStorage.setItem(key, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const refreshLayoutRestore = () => {
    const bar = document.getElementById("layout-restore");
    if (!bar || !grid) return;
    const ws = grid.getAttribute("data-workspace");
    if (grid.getAttribute("data-shell") === "placeholder") {
      for (const btn of bar.querySelectorAll<HTMLElement>("[data-restore]")) btn.hidden = true;
      bar.hidden = true;
      return;
    }
    const setChip = (id: string, on: boolean) => {
      const btn = bar.querySelector<HTMLElement>(`[data-restore="${id}"]`);
      if (btn) btn.hidden = !on;
    };
    setChip("schedule", ws === "schedule-4d" && grid.classList.contains("schedule-collapsed"));
    setChip("inspector", grid.classList.contains("inspector-collapsed"));
    setChip("timeline", ws === "schedule-4d" && grid.classList.contains("timeline-collapsed"));
    setChip(
      "gantt",
      ws === "project-plan" && grid.classList.contains("model-open") && grid.classList.contains("gantt-collapsed"),
    );
    setChip(
      "sets",
      ws === "project-plan" && grid.classList.contains("model-open") && grid.classList.contains("sets-collapsed"),
    );
    const hudIdle = document.getElementById("sim-hud")?.classList.contains("is-idle");
    setChip("hud", ws === "schedule-4d" && !hudIdle && !!simHud && !simHud.chartVisible);
    const earthEl = document.getElementById("earth-panel");
    setChip("earth", !!btnEarth?.classList.contains("is-active") && !!earthEl?.classList.contains("is-hidden"));
    bar.hidden = [...bar.querySelectorAll<HTMLElement>("[data-restore]")].every((b) => b.hidden);
  };

  const setHudCostOpen = (open: boolean) => {
    btnHudCost?.classList.toggle("is-active", open);
    btnHudCost?.setAttribute("aria-pressed", open ? "true" : "false");
    simHud?.setCostPanelOpen(open);
    refreshLayoutRestore();
  };

  const setPanelOpen = (panel: LayoutPanel, open: boolean, persist = true) => {
    if (!grid) return;
    grid.classList.toggle(`${panel}-collapsed`, !open);
    if (panel === "schedule") {
      toggleSchedule?.classList.toggle("is-active", open);
      toggleSchedule?.setAttribute("aria-pressed", open ? "true" : "false");
    }
    if (persist) writeCollapsed(PANEL_LS[panel], !open);
    refreshNavInspector();
    shell?.refresh();
    constrainPanelWidths();
    refreshLayoutRestore();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  const projectWs = projectRoot
    ? new ProjectWorkspace(projectRoot, {
        getIfcSchedule: () => scheduleRef,
        getIfcFileName: () => models.active?.fileName ?? (models.size ? models.label() : null),
        getSession: () => models.active?.session ?? null,
        resolveIfcTask: (id) => models.resolveTask(id),
        federateIfcId: (session, nativeId) => {
          const m = models.all.find((x) => x.session === session);
          return m ? encodeIfcRef(m.slot, nativeId) : nativeId;
        },
        onRequestIfcImport: () => fileInput?.click(),
        onPlanChange: () => {
          /* o nome do Gantt fica na toolbar da tela — o header mostra o IFC */
        },
        onSelectTask: (task) => {
          const ifcId = task?.linkedIfcTaskId;
          const src = ifcId != null ? models.resolveTask(ifcId)?.model.id : null;
          if (src) {
            models.setActive(src);
            renderModelLayers();
          }
          highlightPlanTask(task);
        },
        onToggleModel: () => togglePlanModel(),
        onHideGantt: () => setPanelOpen("gantt", false),
        onNativeChange: (info) => onGanttNativeChange(info),
      })
    : null;

  let pauseTimeline = () => {};
  let highlightPlanTask: (task: { linkedIfcTaskId?: number } | null) => void = () => {};
  let focusGuidsInView = async (_guids: Iterable<string>, _opts?: { fit?: boolean }) => {};
  let refreshWorkingUi = () => {};
  let togglePlanModel = () => {};
  let setPlanModelOpen = (_open: boolean) => {};
  let refreshFederatedView = (_opts?: { structure?: boolean }) => {};
  let renderModelLayers = () => {};

  const syncWorkspaceChrome = (id: WorkspaceId) => {
    const shellKind = workspaceShell(id);
    const tool = findToolByWorkspace(id);
    if (shellKind === "plan") {
      pauseTimeline();
      void highlighter?.revealAll();
      if (!projectWs?.getPlan() && scheduleRef?.roots.length) {
        projectWs?.bindFromIfc(scheduleRef, models.label());
      }
      if (simKicker) simKicker.textContent = "Planejamento";
      currentDateEl.textContent = models.size ? models.label() : "Sem modelo IFC";
    } else if (shellKind === "schedule") {
      setPlanModelOpen(false);
      dirty = true;
      if (simKicker) simKicker.textContent = "Simulação";
      currentDateEl.textContent = formatDateLabel(lastDate);
    } else {
      pauseTimeline();
      setPlanModelOpen(false);
      if (simKicker) simKicker.textContent = tool?.label ?? "Módulo";
      currentDateEl.textContent = models.size ? models.label() : "Sem modelo IFC";
    }
    projectWs?.setActive(shellKind === "plan");
    inspector.setReadOnly(shellKind === "schedule");
    renderModulePlaceholder(id);
    refreshLayoutRestore();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  const nav = initModuleNav({
    inspectorOpen: () =>
      grid?.getAttribute("data-shell") !== "placeholder" && !grid?.classList.contains("inspector-collapsed"),
    onToggleInspector: () => {
      if (grid?.getAttribute("data-shell") === "placeholder") return;
      setPanelOpen("inspector", !!grid?.classList.contains("inspector-collapsed"));
    },
    onRevealSchedule: () => setPanelOpen("schedule", true),
    onWorkspaceChange: (id) => {
      syncWorkspaceChrome(id);
      shell?.closeNavDrawer();
    },
  });
  refreshNavInspector = () => nav.refreshInspectorToggle();
  syncWorkspaceChrome(nav.getWorkspace());

  if (readCollapsed(PANEL_LS.inspector)) setPanelOpen("inspector", false, false);
  if (readCollapsed(PANEL_LS.timeline)) setPanelOpen("timeline", false, false);
  if (readCollapsed(PANEL_LS.gantt)) setPanelOpen("gantt", false, false);
  if (readCollapsed(PANEL_LS.sets)) setPanelOpen("sets", false, false);

  const navEl = document.getElementById("module-nav");
  if (grid && navEl) {
    shell = initAppShell({
      grid,
      nav: navEl,
      inspectorOpen: () =>
        grid.getAttribute("data-shell") !== "placeholder" && !grid.classList.contains("inspector-collapsed"),
      scheduleOpen: () =>
        grid.getAttribute("data-shell") === "schedule" && !grid.classList.contains("schedule-collapsed"),
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
  document.getElementById("toggle-model-sets")?.addEventListener("click", () => {
    setPanelOpen("sets", false);
  });
  document.getElementById("layout-restore")?.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest("[data-restore]")?.getAttribute("data-restore");
    if (!id) return;
    if (id === "hud") {
      setHudCostOpen(true);
      return;
    }
    if (id === "earth") {
      openEarthPanel(true);
      return;
    }
    setPanelOpen(id as LayoutPanel, true);
  });

  toggleSchedule?.addEventListener("click", () => {
    setPanelOpen("schedule", !!grid?.classList.contains("schedule-collapsed"));
  });
  if (window.matchMedia("(max-width: 1279px)").matches) {
    setPanelOpen("schedule", false, false);
  } else if (readCollapsed(PANEL_LS.schedule)) {
    setPanelOpen("schedule", false, false);
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

  const syncFileChrome = () => {
    const dirty = models.anyDirty();
    setFileLabel(models.size ? models.label() : "Importar IFC…", dirty);
    if (btnExport) btnExport.disabled = models.size === 0;
    btnExport?.classList.toggle("is-dirty", dirty);
    if (btnExportLabel) btnExportLabel.textContent = models.size > 1 ? "Exportar IFCs" : "Exportar IFC";
    const importLabel = document.getElementById("btn-import-label");
    if (importLabel) importLabel.textContent = models.size ? "Adicionar IFC" : "Importar IFC";
    btnOpenIfc?.setAttribute("title", models.size ? "Modelos IFC na vista" : "Importar arquivo IFC");
  };

  const markIfcDirty = () => {
    btnExport?.classList.add("is-dirty");
    btnExport?.classList.remove("is-exported");
    if (btnExportLabel) btnExportLabel.textContent = models.size > 1 ? "Exportar IFCs" : "Exportar IFC";
    syncFileChrome();
  };

  const exportIfc = () => {
    if (!models.size) return;
    try {
      const dirty = models.all.filter((m) => m.session.dirty);
      const list = dirty.length ? dirty : models.all;
      list.forEach((m, i) => {
        window.setTimeout(() => m.session.download(), i * 280);
      });
      btnExport?.classList.remove("is-dirty");
      btnExport?.classList.add("is-exported");
      if (btnExportLabel) btnExportLabel.textContent = list.length > 1 ? "IFCs exportados" : "IFC exportado";
      setFileLabel(models.label(), false);
      setTimeout(() => {
        btnExport?.classList.remove("is-exported");
        syncFileChrome();
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
      if (task?.sourceModelId) {
        models.setActive(task.sourceModelId);
        renderModelLayers();
      }
      simHud?.setSelected(task?.id ?? null);
      if (!task) {
        void highlighter?.clearSelection().then(() => refreshWorkingUi());
        refreshInspector();
        return;
      }
      setPanelOpen("inspector", true);
      const gids = scheduleRef?.productGuidsByTask.get(task.id) ?? task.productGuids;
      void focusGuidsInView(gids);
      refreshInspector();
    },
  });

  const simHudRoot = document.getElementById("sim-hud");
  if (simHudRoot) {
    simHud = new SimHud({
      root: simHudRoot,
      onPhaseSelect: (task) => tree.selectById(task.id),
      onDismissCost: () => setHudCostOpen(false),
    });
  }
  btnHudCost?.addEventListener("click", () => {
    const open = btnHudCost.getAttribute("aria-pressed") !== "true";
    setHudCostOpen(open);
  });

  const headerCenter = document.querySelector(".header-center");
  const timeline = new TimelineUI({
    container: timelineEl,
    schedule: placeholder,
    onDateChange: (date) => {
      lastDate = date;
      dirty = true;
      if (workspaceShell(nav.getWorkspace()) === "schedule") {
        currentDateEl.textContent = formatDateLabel(date);
      }
      tree.update(date);
      refreshInspector();
      refreshCost5d();
    },
    onPlayingChange: (playing) => {
      headerCenter?.classList.toggle("is-playing", playing);
      if (playing) void highlighter?.clearIsolation();
      dirty = true;
      refreshCost5d();
    },
    onCollapse: () => setPanelOpen("timeline", false),
  });
  timeline.setIdle(true);
  pauseTimeline = () => timeline.pause();

  applyTaskEdit = (task, patch) => {
    if (!scheduleRef || task.isFederationRoot) return;
    const resolved = models.resolveTask(task.id);
    if (!resolved || resolved.nativeId <= 0) return;
    const { changed, timeChanged } = resolved.session.applyTaskEdit(resolved.nativeId, patch);
    if (!changed) return;
    markIfcDirty();
    refreshFederatedView({ structure: false });
    if (timeChanged) dirty = true;
    else tree.update(lastDate);
    refreshInspector();
    refreshCost5d();
  };

  onGanttNativeChange = (info) => {
    if (!models.size || !scheduleRef) return;
    markIfcDirty();
    refreshFederatedView({ structure: !!info.structure });
    if (info.structure || info.timeChanged) dirty = true;
    else tree.update(lastDate);
    refreshInspector();
    refreshCost5d();
  };

  try {
    setStatus("Inicializando o visualizador…");
    const viewer = await createViewer(viewportEl);
    highlighter = new ScheduleHighlighter(viewer.fragments);
    let modelGizmo: ModelGizmo | null = null;
    let walk: FirstPersonController | null = null;
    let lastWalkFragUpdate = 0;
    let boxSelect: BoxSelectController | null = null;
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
        pauseTimeline();
        void highlighter?.revealAll().then(() => {
          highlightPlanTask(projectWs?.getSelected() ?? null);
          requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
        });
      } else {
        boxSelect?.setToolEnabled(false);
        btnBoxSelect?.classList.remove("is-active");
        btnBoxSelect?.setAttribute("aria-pressed", "false");
      }
      constrainPanelWidths();
      refreshLayoutRestore();
    };
    togglePlanModel = () => {
      if (!models.size) {
        pendingPlanModel = true;
        fileInput?.click();
        return;
      }
      setPlanModelOpen(!grid?.classList.contains("model-open"));
    };
    focusGuidsInView = async (guids: Iterable<string>, opts: { fit?: boolean } = { fit: true }) => {
      if (!highlighter) return;
      const list = [...guids];
      if (!list.length) {
        await highlighter.clearSelection();
        refreshWorkingUi();
        return;
      }
      const ids = await highlighter.isolateGuids(list);
      refreshWorkingUi();
      if (opts.fit !== false && ids.length) {
        const sets = highlighter.selectionItems();
        if (sets.length) await fitCameraToItemSets(viewer, sets);
      }
    };

    const fitCurrentView = () => {
      if (walk?.enabled) {
        walk.respawn();
        return;
      }
      const sets = highlighter?.selectionItems() ?? [];
      if (sets.some((s) => s.localIds.length)) void fitCameraToItemSets(viewer, sets);
      else void fitCameraToVisibleModels(viewer);
    };

    highlightPlanTask = (task) => {
      if (!highlighter) return;
      const picked = projectWs?.getSelectedTasks() ?? [];
      const tasks = picked.length ? picked : task ? [task] : [];
      const gids: string[] = [];
      const seen = new Set<string>();
      for (const t of tasks) {
        const id = t.linkedIfcTaskId;
        if (id == null || !scheduleRef) continue;
        for (const g of scheduleRef.productGuidsByTask.get(id) ?? []) {
          if (seen.has(g)) continue;
          seen.add(g);
          gids.push(g);
        }
      }
      if (!gids.length) {
        void highlighter.clearSelection().then(() => refreshWorkingUi());
        renderSets();
        return;
      }
      void focusGuidsInView(gids);
      renderSets();
    };

    btnFit?.addEventListener("click", () => fitCurrentView());

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
      if (boxSelect?.isDragging()) return;
      void pickTaskFromModel(e);
    });

    const pickTaskFromModel = async (e: PointerEvent) => {
      if (walk?.enabled) return;
      if (modelGizmo?.isDragging()) return;
      if (!highlighter) return;
      const renderer = viewer.world.renderer;
      if (!renderer) return;
      const hit = await highlighter.pickHit(viewer.world.camera.three, e, renderer.three.domElement);
      if (!hit) {
        if (e.ctrlKey || e.metaKey) return;
        tree.selectById(null);
        await highlighter.clearSelection();
        refreshWorkingUi();
        return;
      }
      const { guid } = hit;
      if (e.ctrlKey || e.metaKey) await highlighter.toggleWorkingGuid(guid);
      else await highlighter.setWorkingSelection([guid]);
      refreshWorkingUi();
    };

    const ifcTreeEl = document.getElementById("ifc-tree");
    const setsListEl = document.getElementById("selection-sets");
    const ifcTree = ifcTreeEl
      ? new IfcSpatialTree(ifcTreeEl, {
          onSelect: (guids, additive) => {
            if (!highlighter) return;
            void (async () => {
              if (additive) {
                await highlighter.addWorkingGuids(guids);
                await focusGuidsInView(highlighter.getWorkingGuids());
                return;
              }
              await focusGuidsInView(guids);
            })();
          },
        })
      : null;
    const setsList = setsListEl
      ? new SelectionSetsList(setsListEl, {
          onCreate: () => createSetFromSelection(),
          onRename: (id, name) => {
            try {
              const resolved = models.resolveGroup(id);
              resolved?.session.renameGroup(resolved.nativeId, name);
              markIfcDirty();
              refreshFederatedView();
            } catch (err) {
              projectWs?.notify((err as Error).message);
            }
          },
          onDelete: (id) => {
            const resolved = models.resolveGroup(id);
            if (!resolved) return;
            if (!window.confirm("Apagar este IfcGroup do modelo?")) return;
            try {
              resolved.session.deleteGroup(resolved.nativeId);
              markIfcDirty();
              projectWs?.applyProductGuids(projectWs.getSelected()?.linkedIfcTaskId ?? 0, []);
              bumpSimulation(highlighter?.getWorkingGuids() ?? []);
              refreshFederatedView({ structure: true });
              projectWs?.notify("Conjunto removido do IFC.");
            } catch (err) {
              projectWs?.notify((err as Error).message);
            }
          },
          onSelect: (id) => {
            const group = scheduleRef?.groups.find((g) => g.id === id);
            if (!group || !highlighter) return;
            void focusGuidsInView(group.productGuids);
            renderSets();
          },
          onAddSelection: (id) => {
            if (!highlighter) return;
            const resolved = models.resolveGroup(id);
            const extra = highlighter.getWorkingGuids();
            const group = scheduleRef?.groups.find((g) => g.id === id);
            if (!group || !resolved) return;
            const members = new Map(group.productGuids.map((g, i) => [g, group.productIds[i]]));
            for (const g of extra) {
              if (highlighter.guidModelId(g) !== resolved.model.id) continue;
              if (!members.has(g)) members.set(g, highlighter.localIdOf(g, resolved.model.id) ?? 0);
            }
            try {
              resolved.session.setGroupMembers(
                resolved.nativeId,
                [...members.entries()].map(([guid, expressId]) => ({ guid, expressId })),
              );
              markIfcDirty();
              projectWs?.applyProductGuids(projectWs.getSelected()?.linkedIfcTaskId ?? 0, []);
              bumpSimulation(group.productGuids);
              refreshFederatedView({ structure: true });
              projectWs?.notify("Seleção adicionada ao conjunto (IfcRelAssignsToGroup).");
            } catch (err) {
              projectWs?.notify((err as Error).message);
            }
          },
          onAssign: (id) => assignGroupToSelectedTask(id),
        })
      : null;

    const activateModelSetsTab = (tab: "tree" | "sets") => {
      document.querySelectorAll("[data-ms-tab]").forEach((btn) => {
        const on = btn.getAttribute("data-ms-tab") === tab;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll("[data-ms-pane]").forEach((pane) => {
        pane.classList.toggle("is-hidden", pane.getAttribute("data-ms-pane") !== tab);
      });
    };

    const applyIfcRelations = (rerender = true) => {
      const taskGuids: string[] = [];
      for (const list of scheduleRef?.productGuidsByTask.values() ?? []) {
        for (const g of list) taskGuids.push(g);
      }
      const groupGuids = scheduleRef?.groups.flatMap((g) => g.productGuids) ?? [];
      ifcTree?.setRelations(taskGuids, groupGuids, rerender);
    };

    const syncLinkedActivities = (guids: string[]) => {
      const ids = scheduleRef ? findTaskIdsForGuids(scheduleRef, guids) : [];
      const planOpen = nav.getWorkspace() === "project-plan" && !!grid?.classList.contains("model-open");
      tree.markHits(ids, nav.getWorkspace() === "schedule-4d");
      if (planOpen) {
        const already = projectWs?.getSelected()?.linkedIfcTaskId;
        projectWs?.markHits(ids, ids.length > 1);
        if (ids.length === 1 && ids[0] !== already) projectWs?.selectByIfcTaskId(ids[0]!);
      } else if (ids.length === 1) {
        const t = scheduleRef?.byId.get(ids[0]!);
        if (!t) return;
        selectedTask = t;
        simHud?.setSelected(t.id);
        tree.selectById(t.id, false);
        refreshInspector();
      }
    };

    refreshWorkingUi = () => {
      const guids = highlighter?.getWorkingGuids() ?? [];
      const n = guids.length;
      if (modelSetsCount) {
        modelSetsCount.textContent = `${n} selecionado${n === 1 ? "" : "s"}`;
      }
      if (guids.length && ifcTreeSearch) ifcTreeSearch.value = "";
      ifcTree?.revealGuids(guids);
      setsList?.markHits(guids, scheduleRef?.groups ?? []);
      syncLinkedActivities(guids);
      const revealed = ifcTreeEl?.querySelector(".ms-row.is-active, .ms-row.is-hit");
      if (guids.length && !revealed && setsList?.hasHits()) activateModelSetsTab("sets");
    };

    renderSets = () => {
      setsList?.setTaskId(projectWs?.getSelected()?.linkedIfcTaskId ?? null);
      setsList?.markHits(highlighter?.getWorkingGuids() ?? [], scheduleRef?.groups ?? []);
    };

    const createSetFromSelection = () => {
      if (!models.size || !highlighter) {
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
        const refs = hl.refsOf(guids);
        const byModel = new Map<string, Array<{ guid: string; expressId?: number }>>();
        for (const r of refs) {
          const list = byModel.get(r.modelId) ?? [];
          list.push({ guid: r.guid, expressId: r.localId });
          byModel.set(r.modelId, list);
        }
        if (!byModel.size) {
          projectWs?.notify("Os elementos selecionados não pertencem a um IFC visível.");
          return;
        }
        const task = projectWs?.getSelected();
        const taskRef = task?.linkedIfcTaskId != null ? models.resolveTask(task.linkedIfcTaskId) : null;
        let lastGuids: string[] = [];
        let created = 0;
        for (const [modelId, members] of byModel) {
          const entry = models.get(modelId);
          if (!entry) continue;
          const group = entry.session.createGroup(name, members);
          created += 1;
          lastGuids = group.productGuids;
          if (taskRef && taskRef.model.id === modelId && task) {
            const linked = entry.session.assignGroupToTask(taskRef.nativeId, group.id);
            lastGuids = linked.guids;
            projectWs?.applyProductGuids(task.linkedIfcTaskId!, linked.guids);
          }
          setsList?.setSelected(encodeIfcRef(entry.slot, group.id));
        }
        if (lastGuids.length) void focusGuidsInView(lastGuids);
        bumpSimulation(guids);
        markIfcDirty();
        refreshFederatedView({ structure: true });
        const extra =
          created > 1
            ? ` (${created} IfcGroup, um por ficheiro).`
            : taskRef
              ? ` ligado à tarefa «${task?.name}».`
              : ". Selecione uma tarefa no Gantt e ligue-o.";
        projectWs?.notify(`Conjunto «${name}» gravado${extra}`);
        document.querySelectorAll("[data-ms-tab]").forEach((btn) => {
          const on = btn.getAttribute("data-ms-tab") === "sets";
          btn.classList.toggle("is-active", on);
          btn.setAttribute("aria-selected", on ? "true" : "false");
        });
        document.querySelectorAll("[data-ms-pane]").forEach((pane) => {
          pane.classList.toggle("is-hidden", pane.getAttribute("data-ms-pane") !== "sets");
        });
      } catch (err) {
        projectWs?.notify((err as Error).message);
      }
    };

    const assignGroupToSelectedTask = (groupId: number) => {
      const task = projectWs?.getSelected();
      if (!task?.linkedIfcTaskId) {
        projectWs?.notify("Selecione no Gantt a IfcTask a ligar.");
        return;
      }
      const groupRef = models.resolveGroup(groupId);
      const taskRef = models.resolveTask(task.linkedIfcTaskId);
      if (!groupRef || !taskRef) return;
      if (groupRef.model.id !== taskRef.model.id) {
        projectWs?.notify("O conjunto e a tarefa têm de ser do mesmo ficheiro IFC.");
        return;
      }
      try {
        const { added, guids } = groupRef.session.assignGroupToTask(taskRef.nativeId, groupRef.nativeId);
        projectWs?.applyProductGuids(task.linkedIfcTaskId, guids);
        if (added || guids.length) void focusGuidsInView(guids);
        else void highlighter?.clearSelection().then(() => refreshWorkingUi());
        bumpSimulation(guids);
        markIfcDirty();
        refreshFederatedView({ structure: true });
        projectWs?.notify(
          added
            ? "Conjunto ligado à tarefa. No Cronograma 4D os elementos entram na linha do tempo."
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
        void run.then(() => {
          if (mode === "replace" && !guids.length) tree.selectById(null);
          refreshWorkingUi();
        });
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
      applyIfcRelations(false);
      const entries = models.visible.map((m) => ({
        model: m.model,
        label: m.displayName,
        modelId: m.id,
      }));
      void ifcTree?.bindMany(entries, highlighter).then(() => refreshWorkingUi());
      renderSets();
    };

    const syncWalkModels = () => {
      const vis = models.visible.map((m) => m.model);
      void walk?.setModel(vis.length ? vis : null);
    };

    const attachGizmoToActive = (reset: boolean) => {
      const m = models.active;
      if (!m?.visible) {
        gizmo.attach(null);
        return;
      }
      gizmo.attach(m.model.object);
      if (reset) {
        gizmo.reset();
        gizmo.fitSize(m.model.object);
      }
    };

    const applyActiveGeoref = (opts: { snap?: boolean; resetGizmo?: boolean } = {}) => {
      const session = models.active?.session;
      if (!session) return;
      const georef = session.schedule.georef;
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
      earth.setAnchor(anchor, { snap: !!opts.snap && !hasAlt && earth.enabled });
      earthPanel?.setState({
        anchor,
        hideRadius: earth.getHideRadius(),
        transform: emptyExtraTransform(),
      });
      if (hasAlt) earthPanel?.setTerrainHeight(anchor.altitude);
      else earthPanel?.setTerrainHeight(null, earth.enabled ? "a amostrar o terreno…" : "Assentar grava a cota no IFC");
      earthPanel?.setSource(georef ? georefSourceLabel(georef) : "IFC sem coordenadas geográficas");
      attachGizmoToActive(opts.resetGizmo !== false);
      earthPanel?.setMode(null);
      syncGizmo();
    };

    refreshFederatedView = (opts) => {
      const keepId = selectedTask?.id ?? null;
      scheduleRef = models.visible.length ? models.mergedSchedule() : emptySchedule();
      const schedule = scheduleRef;
      const structure = opts?.structure !== false;
      if (!models.visible.length || schedule.roots.length === 0) {
        tree.setSchedule(emptySchedule());
        timeline.bindSchedule(emptySchedule());
        timeline.setIdle(!models.size);
        simHud?.bind(null);
        selectedTask = null;
      } else if (structure) {
        tree.setSchedule(schedule, true);
        if (keepId != null && schedule.byId.has(keepId)) {
          selectedTask = schedule.byId.get(keepId) ?? null;
          tree.selectById(keepId, false);
        } else {
          selectedTask = null;
        }
        simHud?.bind(schedule);
        timeline.bindSchedule(schedule);
        timeline.setIdle(false);
        timeline.setRange(schedule.minDate, schedule.maxDate);
      } else {
        tree.setSchedule(schedule, true);
        if (keepId != null) selectedTask = schedule.byId.get(keepId) ?? selectedTask;
        simHud?.bind(schedule);
        timeline.setRange(schedule.minDate, schedule.maxDate);
      }
      scheduleNameEl.textContent = models.visible.length ? scheduleTitle(schedule) : "Importe um arquivo IFC";
      scheduleNameEl.title = models.visible.length
        ? models.visible.map((m) => m.displayName).join(", ")
        : "IfcWorkPlan / IfcWorkSchedule / IfcTask";
      if (scheduleCountEl) {
        scheduleCountEl.textContent = String(schedule.leafTaskCount);
        scheduleCountEl.title = `${schedule.leafTaskCount} tarefas-folha`;
      }
      projectWs?.bindFromIfc(schedule, models.label());
      bindSpatialTree();
      renderSets();
      renderModelLayers();
      syncFileChrome();
      refreshLayoutRestore();
      refreshInspector();
      refreshCost5d();
      if (models.visible.length) tree.update(lastDate);
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
      refreshLayoutRestore();
    };
    openEarthPanel = setEarthPanelOpen;

    const gizmo = new ModelGizmo({
      scene: viewer.world.scene.three,
      camera: viewer.world.camera as import("@thatopen/components").OrthoPerspectiveCamera,
      domElement: viewer.world.renderer!.three.domElement,
      onChange: (t) => {
        earth.setClipCenter(t.x, t.y, t.z);
        earthPanel?.setTransform(t);
        models.active?.session.setExtraTransform(t);
        if (models.active && !extraIsIdentity(t)) markIfcDirty();
      },
    });
    viewer.world.onCameraChanged.add(() => gizmo.updateCamera());
    modelGizmo = gizmo;
    applyTerrainSnap = (alt) => {
      earthPanel?.setTerrainHeight(alt);
      const a = earth.getAnchor();
      if (models.active) {
        models.active.session.setGeoAnchor({ lat: a.lat, lon: a.lon, elevation: alt });
        markIfcDirty();
      }
      const t = gizmo.read();
      if (Math.abs(t.y) > 80) {
        const next = { ...t, y: 0 };
        gizmo.apply(next);
        earth.setClipCenter(next.x, next.y, next.z);
        earthPanel?.setTransform(next);
        models.active?.session.setExtraTransform(next);
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
            if (geoMoved && models.active) {
              const a = earth.getAnchor();
              models.active.session.setGeoAnchor({
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
            models.active?.session.setExtraTransform(t);
            if (models.active && !extraIsIdentity(t)) markIfcDirty();
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

    const syncGizmo = () => {
      const allow = earth.enabled && !walk?.enabled;
      gizmo.setAllowed(allow);
      if (!allow) earthPanel?.setMode(null);
    };

    const setEarthEnabledUi = (enabled: boolean) => {
      btnEarth?.classList.toggle("is-active", enabled);
      btnEarth?.setAttribute("aria-pressed", enabled ? "true" : "false");
      if (btnEarth) btnEarth.title = enabled ? "Ocultar contexto Google Earth" : "Mostrar contexto Google Earth";
      syncGizmo();
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
          syncGizmo();
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

    const popover = document.getElementById("model-popover");
    const viewportLayers = document.getElementById("model-layers");
    const layerRoots = [popover, viewportLayers].filter((el): el is HTMLElement => !!el);
    const layersUi = layerRoots.length
      ? new ModelLayersUI(layerRoots, {
          onToggle: (id, visible) => void setModelLayerVisible(id, visible),
          onSelect: (id) => {
            models.setActive(id);
            attachGizmoToActive(false);
            applyActiveGeoref({ snap: false, resetGizmo: false });
            renderModelLayers();
          },
          onRemove: (id) => void removeLoadedModel(id),
          onAdd: () => pickIfcFile(),
        })
      : null;
    renderModelLayers = () => layersUi?.render(models.all, models.activeId);

    const setModelLayerVisible = async (id: string, visible: boolean) => {
      models.setVisible(id, visible);
      await highlighter?.setModelVisible(id, visible);
      syncWalkModels();
      attachGizmoToActive(false);
      refreshFederatedView({ structure: true });
      dirty = true;
    };

    const removeLoadedModel = async (id: string) => {
      const entry = models.get(id);
      if (!entry) return;
      if (entry.session.dirty) {
        const ok = window.confirm(
          `Há alterações em «${entry.displayName}» que ainda não foram exportadas. Remover descarta essas alterações.`,
        );
        if (!ok) return;
      }
      await highlighter?.removeModel(id);
      await unloadIfc(viewer, id);
      models.remove(id);
      if (!models.size) {
        gizmo.attach(null);
        await walk?.setModel(null);
        selectedTask = null;
        scheduleRef = emptySchedule();
        tree.setSchedule(emptySchedule());
        timeline.bindSchedule(emptySchedule());
        timeline.setIdle(true);
        simHud?.bind(null);
        ifcTree?.clear();
        setImportVisible(true);
      } else {
        attachGizmoToActive(false);
        syncWalkModels();
      }
      refreshFederatedView({ structure: true });
      dirty = true;
    };

    const loadFromBuffer = async (buffer: Uint8Array, fileName: string) => {
      setImportVisible(false);
      setLoading(true, "O modelo 3D e o cronograma nativo entram em seguida.");
      setStatus("A preparar o IFC…");
      const cacheLookup = hashIfcBytes(buffer).then(async (h) => ({
        hash: h,
        frag: await getCachedFragments(h),
      }));
      const { text: preparedText, bytes: preparedBytes } = prepareIfcForOpen(buffer);
      const { hash, frag: cachedFrag } = await cacheLookup;
      if (hash && models.hasHash(hash)) {
        setLoading(false);
        setImportVisible(false);
        window.alert(`«${fileName}» já está na vista.`);
        return;
      }

      setStatus("Lendo o cronograma do IFC…");
      const schedule = await parseSchedule(preparedBytes, WASM_URL);
      const first = models.size === 0;
      const modelId = `ifc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      timeline.pause();
      let model: import("@thatopen/fragments").FragmentsModel;
      if (cachedFrag) {
        setStatus("A carregar o modelo 3D em cache…");
        ({ model } = await loadFragments(viewer, cachedFrag, modelId));
      } else {
        setStatus("Convertendo o modelo 3D…");
        ({ model } = await loadIfc(viewer, preparedBytes, modelId, (p) =>
          setStatus(`Convertendo IFC… ${(p * 100).toFixed(0)}%`),
        ));
      }

      const session = new IfcSession(preparedText, fileName, schedule);
      const entry = models.add({ id: modelId, fileName, session, model, hash });

      setStatus(`Mapeando elementos de «${entry.displayName}»…`);
      if (!highlighter) highlighter = new ScheduleHighlighter(viewer.fragments);
      await highlighter.addModel(entry.id, model, collectAllGuids(schedule));

      refreshFederatedView({ structure: true });
      if (pendingPlanModel && nav.getWorkspace() === "project-plan") {
        pendingPlanModel = false;
        setPlanModelOpen(true);
      }

      if (first) {
        earth.setClipCenter(0, 0, 0);
        applyActiveGeoref({ snap: true, resetGizmo: true });
        lastDate = scheduleRef?.minDate ?? schedule.minDate;
      } else {
        attachGizmoToActive(true);
      }
      syncWalkModels();
      if (scheduleRef && lastDate < scheduleRef.minDate) lastDate = scheduleRef.minDate;
      if (scheduleRef && lastDate > scheduleRef.maxDate) lastDate = scheduleRef.maxDate;
      dirty = true;
      tree.update(lastDate);
      if (workspaceShell(nav.getWorkspace()) === "schedule") {
        currentDateEl.textContent = formatDateLabel(lastDate);
      } else {
        currentDateEl.textContent = models.label();
      }
      refreshInspector();
      refreshCost5d();
      setLoading(false);
      void fitCameraToVisibleModels(viewer);
      if (!cachedFrag) {
        void exportFragmentsBuffer(model)
          .then((buf) => saveCachedFragments(hash, buf))
          .catch((err) => console.warn("Cache Fragments:", err));
      }
    };

    const pickIfcFile = () => fileInput?.click();

    const importFiles = async (files: File[]) => {
      if (loading) return;
      const ifcs = files.filter(isIfcFile);
      if (!ifcs.length) {
        window.alert("Selecione um ou mais arquivos IFC (.ifc).");
        return;
      }
      loading = true;
      try {
        for (const file of ifcs) {
          const buffer = new Uint8Array(await file.arrayBuffer());
          await loadFromBuffer(buffer, file.name);
        }
      } catch (err) {
        console.error(err);
        window.alert(`Não foi possível importar o IFC: ${(err as Error).message}`);
        if (!models.size) {
          selectedTask = null;
          scheduleRef = emptySchedule();
          tree.setSchedule(emptySchedule());
          timeline.bindSchedule(emptySchedule());
          timeline.setIdle(true);
          simHud?.bind(null);
          refreshLayoutRestore();
          syncFileChrome();
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
      const files = [...(fileInput?.files ?? [])];
      if (files.length) void importFiles(files);
    };

    const toggleModelPopover = (open?: boolean) => {
      if (!popover) return;
      const next = open ?? popover.hidden;
      popover.hidden = !next;
      btnOpenIfc?.setAttribute("aria-expanded", next ? "true" : "false");
    };

    fileInput?.addEventListener("change", onPickFile);
    btnImport?.addEventListener("click", pickIfcFile);
    btnOpenIfc?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!models.size) {
        pickIfcFile();
        return;
      }
      toggleModelPopover();
    });
    btnImportPick?.addEventListener("click", pickIfcFile);
    btnExport?.addEventListener("click", exportIfc);
    document.addEventListener("pointerdown", (e) => {
      if (!popover || popover.hidden) return;
      const t = e.target as Node;
      if (popover.contains(t) || btnOpenIfc?.contains(t)) return;
      toggleModelPopover(false);
    });

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
      const files = [...(e.dataTransfer?.files ?? [])].filter(isIfcFile);
      if (files.length) void importFiles(files);
    });

    window.addEventListener("beforeunload", (e) => {
      if (!models.anyDirty()) return;
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
      if (workspaceShell(nav.getWorkspace()) === "placeholder") return;
      if (nav.getWorkspace() === "project-plan") {
        if (e.code === "KeyM") {
          e.preventDefault();
          togglePlanModel();
          return;
        }
        if (e.code === "KeyF") {
          e.preventDefault();
          fitCurrentView();
          return;
        }
        if (e.code === "Escape") {
          e.preventDefault();
          void highlighter?.clearSelection().then(() => refreshWorkingUi());
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
        fitCurrentView();
      } else if (e.code === "Escape") {
        e.preventDefault();
        void highlighter?.clearSelection().then(() => refreshWorkingUi());
      } else if (e.code === "KeyB") {
        e.preventDefault();
        setPanelOpen("schedule", !!grid?.classList.contains("schedule-collapsed"));
      } else if (e.code === "KeyI") {
        e.preventDefault();
        setPanelOpen("inspector", !!grid?.classList.contains("inspector-collapsed"));
      } else if (e.code === "KeyT" && !earth.enabled) {
        e.preventDefault();
        setPanelOpen("timeline", !!grid?.classList.contains("timeline-collapsed"));
      } else if (earth.enabled && (e.code === "KeyG" || e.code === "KeyT")) {
        e.preventDefault();
        const next = gizmo.getMode() === "translate" ? null : "translate";
        gizmo.setMode(next);
        earthPanel?.setMode(next);
      } else if (earth.enabled && e.code === "KeyR") {
        e.preventDefault();
        const next = gizmo.getMode() === "rotate" ? null : "rotate";
        gizmo.setMode(next);
        earthPanel?.setMode(next);
      }
    });

    const tick = async () => {
      walk?.update();
      const shellKind = workspaceShell(nav.getWorkspace());
      if (shellKind !== "placeholder" && dirty && !applying && highlighter && scheduleRef && models.visible.length) {
        dirty = false;
        applying = true;
        try {
          if (shellKind === "plan") {
            await highlighter.revealAll();
          } else if (shellKind === "schedule") {
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
    syncWorkspaceChrome(nav.getWorkspace());
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

function findTaskIdsForGuids(schedule: ScheduleData, guids: Iterable<string>): number[] {
  const want = new Set(guids);
  if (!want.size) return [];
  const hits: number[] = [];
  for (const t of schedule.byId.values()) {
    const list = schedule.productGuidsByTask.get(t.id) ?? t.productGuids;
    if (!list.some((g) => want.has(g))) continue;
    hits.push(t.id);
  }
  const leaves = hits.filter((id) => (schedule.byId.get(id)?.children.length ?? 0) === 0);
  return leaves.length ? leaves : hits;
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
