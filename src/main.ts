import "./styles.css";
import { createViewer, loadIfc, loadFragments, exportFragmentsBuffer, unloadIfc, fitCameraToItemSets, fitCameraToVisibleModels, setAllModelsQuality, deviceGraphicsQuality, setWorldGridVisible } from "./viewer/setupWorld";
import { ScheduleHighlighter } from "./viewer/highlight";
import { parseSchedule } from "./schedule/parseSchedule";
import { parseScheduleFromFragments } from "./schedule/parseFragmentsSchedule";
import { computeStateBuckets } from "./schedule/simulation";
import { emptySchedule, getTaskIdsByGuid } from "./schedule/range";
import { TaskTreeUI } from "./ui/taskTree";
import { TimelineUI } from "./ui/timeline";
import { InspectorUI } from "./ui/inspector";
import { SimHud } from "./ui/simHud";
import { GoogleEarthLayer, type AnchorLLA } from "./viewer/earthTiles";
import { EarthPanel } from "./ui/earthPanel";
import { ModelGizmo, type GizmoMode } from "./viewer/modelGizmo";
import { emptyExtraTransform, extraIsIdentity, extraFromObject, applyExtraToObject, georefSourceLabel, hasGeographicAnchor, hasStoredSiteElevation, threeWorldToIfc } from "./ifc/georef";
import { initPanelSplitters, constrainPanelWidths } from "./ui/splitters";
import { initModuleNav } from "./ui/moduleNav";
import { initAppShell } from "./ui/appShell";
import { ProjectWorkspace } from "./ui/projectWorkspace";
import { buildBimCatalog, compactCatalog, type BimCatalog } from "./projectPlan/bimCatalog";
import { applyLlmPicks, compactTasksForLlm, suggestProductLinks } from "./projectPlan/linkAssist";
import { refineWithAi } from "./projectPlan/linkAssistLlm";
import { LogisticsWorkspace } from "./ui/logisticsWorkspace";
import { renderModulePlaceholder } from "./ui/modulePlaceholder";
import { findToolByWorkspace, workspaceHasEarth, workspaceShell, type WorkspaceId } from "./app/catalog";
import { IfcSession, type TaskPatch } from "./ifc/ifcSession";
import { IfcModelSet, encodeIfcRef, scheduleTitle, type LoadedIfc } from "./ifc/modelSet";
import {
  createCoordinationSession,
  persistCoordinationSession,
  seedCoordinationFromDisciplines,
} from "./ifc/coordination";
import { ModelLayersUI } from "./ui/modelLayers";
import { prepareIfcOffthread } from "./ifc/prepareIfc";
import { hasIfcBytes, loadIfcBytes, saveIfcBytes } from "./ifc/stepStore";
import { getCachedModel, hashIfcBytes, saveCachedModel } from "./ifc/fragCache";
import {
  downloadBytes,
  isCoordinationEntry,
  isVtwinFileName,
  listOrphanSummary,
  looksLikeZip,
  packVtwin,
  unpackVtwin,
  vtwinDownloadName,
  type VtwinPackModel,
} from "./project";
import { computeCostProgress, formatMoney } from "./schedule/cost";
import type { ScheduleData, Task } from "./schedule/types";
import { FirstPersonController } from "./viewer/firstPerson";
import { BoxSelectController } from "./viewer/boxSelect";
import { SiteOverlay } from "./viewer/siteOverlay";
import { SiteDrawController } from "./viewer/siteDraw";
import { defaultSiteLimit } from "./logistics/types";
import { IfcSpatialTree } from "./ui/ifcTree";
import { SelectionSetsList } from "./ui/selectionSets";
import { isFileDrag } from "./ui/dnd";
import { attachPerfStats, markLoad, measureAsync, recordMetric } from "./viewer/perfStats";
import { requestFragmentsUpdate } from "./viewer/fragmentsUpdate";
import { ViewportModelRegistry } from "./viewer/modelRegistry";

const WASM_URL = "/wasm/";

function showEarthStatus(message: string | null): void {
  let el = document.getElementById("earth-status");
  if (!message) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("p");
    el.id = "earth-status";
    el.className = "earth-status";
    el.setAttribute("role", "alert");
    document.querySelector(".viewport-stage")?.appendChild(el);
  }
  el.hidden = false;
  el.textContent = message;
}

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
  const replaceIfcInput = document.getElementById("replace-ifc-input") as HTMLInputElement | null;
  const btnShare = document.getElementById("btn-share");
  const btnShareLabel = document.getElementById("btn-share-label");
  const btnExport = document.getElementById("btn-export") as HTMLButtonElement | null;
  const btnExportLabel = document.getElementById("btn-export-label");
  const btnSaveProject = document.getElementById("btn-save-project") as HTMLButtonElement | null;
  const btnImport = document.getElementById("btn-import");
  const btnOpenIfc = document.getElementById("btn-open-ifc");
  const fileExtEl = document.getElementById("file-ext");
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
  const viewportModels = new ViewportModelRegistry();
  let projectName: string | null = null;

  const meshEntry = (): LoadedIfc | undefined => {
    const active = models.active;
    if (active && active.role !== "coordination") return active;
    return models.disciplines.find((m) => m.visible) ?? models.disciplines[0];
  };

  /** Canteiro / recorte do terreno: sempre o extra da COORD, nunca o da disciplina ativa. */
  const siteExtra = () => models.coordination?.session.getExtraTransform() ?? emptyExtraTransform();
  const skipFitIds = () =>
    models.all
      .filter((m) => m.role === "coordination" || /^coord$/i.test(m.fileName.replace(/\.ifc$/i, "")))
      .map((m) => m.id);

  const ensurePlanning = (): LoadedIfc | null => {
    if (!models.size) return null;
    if (models.coordination) return models.coordination;
    const session = createCoordinationSession(projectName ?? models.label());
    const entry = models.ensureCoordination(() => ({ session }));
    seedCoordinationFromDisciplines(
      session,
      models.disciplines.map((d) => d.session),
    );
    return entry;
  };

  const planningSession = () => ensurePlanning()?.session ?? null;

  const resolvePlanningTask = (federatedId: number, globalId?: string) => {
    const root = ensurePlanning();
    const gid = globalId || scheduleRef?.byId.get(federatedId)?.globalId;
    if (root && gid) {
      for (const t of root.session.schedule.byId.values()) {
        if (t.globalId === gid) {
          return { model: root, nativeId: t.id, session: root.session };
        }
      }
    }
    return models.resolveTask(federatedId);
  };
  let selectedTask: Task | null = null;
  let lastDate = new Date();
  let scheduleRef: ScheduleData | null = null;
  let highlighter: ScheduleHighlighter | null = null;
  let lastAssistCatalog: BimCatalog | null = null;
  let simHud: SimHud | null = null;
  let loading = false;
  let dirty = true;
  let applying = false;
  let lastHudMs = 0;

  const bumpSimulation = (guids?: Iterable<string>) => {
    dirty = true;
    highlighter?.invalidateApply();
    if (guids && highlighter) {
      void highlighter.includeGuids(guids).then(() => {
        dirty = true;
      });
    }
  };

  let applyTaskEdit: (task: Task, patch: TaskPatch) => void = () => {};
  let onGanttNativeChange = (_info: { timeChanged?: boolean; structure?: boolean }) => {};
  let assignGuidsToFederatedTask = (_taskId: number, _guids: string[]) => {};
  let assignGroupToFederatedTask = (_taskId: number, _groupId: number) => {};

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
    setChip("schedule", (ws === "schedule-4d" || ws === "logistics") && grid.classList.contains("schedule-collapsed"));
    const scheduleChip = bar.querySelector<HTMLElement>('[data-restore="schedule"]');
    if (scheduleChip) scheduleChip.textContent = ws === "logistics" ? "Canteiro" : "Cronograma";
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
    setChip(
      "earth",
      (ws === "schedule-4d" || ws === "logistics") &&
        !!btnEarth?.classList.contains("is-active") &&
        !!earthEl?.classList.contains("is-hidden"),
    );
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
    shell?.refresh();
    constrainPanelWidths();
    refreshLayoutRestore();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  const projectWs = projectRoot
    ? new ProjectWorkspace(projectRoot, {
        getIfcSchedule: () => scheduleRef,
        getIfcFileName: () => models.active?.fileName ?? (models.size ? models.label() : null),
        getSession: () => planningSession(),
        resolveIfcTask: (id) => resolvePlanningTask(id),
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
        onDropGuids: (ifcTaskId, guids) => assignGuidsToFederatedTask(ifcTaskId, guids),
        onDropGroup: (ifcTaskId, groupId) => assignGroupToFederatedTask(ifcTaskId, groupId),
        onSuggestLinks: async (tasks) => {
          if (!highlighter) throw new Error("O visualizador 3D ainda não está pronto.");
          const entries = models.visible
            .filter((m) => m.role !== "coordination" && !/^coord$/i.test(m.fileName.replace(/\.ifc$/i, "")))
            .map((m) => {
              const model = viewportModels.get(m.id);
              return model ? { model, modelId: m.id, label: m.displayName } : null;
            })
            .filter((item): item is { model: NonNullable<ReturnType<typeof viewportModels.get>>; modelId: string; label: string } => !!item);
          if (!entries.length) {
            throw new Error("Não há modelo IFC com geometria visível. Importe um IFC de disciplina (não só o COORD).");
          }
          const catalog = await buildBimCatalog(entries, highlighter);
          lastAssistCatalog = catalog;
          if (!catalog.buckets.length) {
            throw new Error("Não encontrei elementos com geometria para ligar (paredes, lajes, etc.).");
          }
          return suggestProductLinks(tasks, catalog);
        },
        onRefineLinks: async (report, tasks) => {
          const catalog = lastAssistCatalog;
          if (!catalog) throw new Error("Volte a gerar as sugestões antes de refinar com IA.");
          const picks = await refineWithAi({
            tasks: compactTasksForLlm(tasks, report),
            buckets: compactCatalog(catalog),
          });
          if (!picks.length) throw new Error("A IA não devolveu correspondências utilizáveis.");
          return applyLlmPicks(report, catalog, tasks, picks);
        },
        onPreviewGuids: (guids) => {
          void focusGuidsInView(guids);
        },
        onApplyLinkSuggestions: (items) => {
          let lastGuids: string[] = [];
          for (const item of items) {
            const taskRef = resolvePlanningTask(item.ifcTaskId);
            if (!taskRef) continue;
            const members = item.guids.map((guid) => {
              const ownerId = highlighter?.guidModelId(guid);
              const localId = ownerId ? highlighter?.localIdOf(guid, ownerId) : undefined;
              return { guid, expressIdHint: localId };
            });
            try {
              const { guids } = taskRef.session.addProductsToTask(taskRef.nativeId, members);
              lastGuids = guids;
              projectWs?.applyProductGuids(item.ifcTaskId, guids);
              bumpSimulation(item.guids);
            } catch (err) {
              projectWs?.notify((err as Error).message);
            }
          }
          markIfcDirty();
          refreshFederatedView({ structure: true });
          if (lastGuids.length) void focusGuidsInView(lastGuids);
        },
      })
    : null;

  let pauseTimeline = () => {};
  let disablePlanVizTools = () => {};
  let restorePlanVizTools = () => {};
  let onLogisticsWorkspace = () => {};
  let highlightPlanTask: (task: { linkedIfcTaskId?: number } | null) => void = () => {};
  let focusGuidsInView = async (_guids: Iterable<string>, _opts?: { fit?: boolean }) => {};
  let refreshWorkingUi = () => {};
  let togglePlanModel = () => {};
  let setPlanModelOpen = (_open: boolean) => {};
  let refreshFederatedView = (_opts?: { structure?: boolean }) => {};
  let renderModelLayers = () => {};
  let refitVisibleModels = () => {};

  const syncWorkspaceChrome = (id: WorkspaceId) => {
    const shellKind = workspaceShell(id);
    const tool = findToolByWorkspace(id);
    const logisticsPanel = document.getElementById("logistics-panel");
    const panelTitle = document.querySelector("#sidebar .panel-title");
    if (logisticsPanel) logisticsPanel.hidden = shellKind !== "logistics";
    if (panelTitle) panelTitle.textContent = shellKind === "logistics" ? "Canteiro" : "4D";
    if (shellKind !== "schedule" && shellKind !== "logistics") {
      pauseTimeline();
      disablePlanVizTools();
    } else {
      if (shellKind !== "schedule") pauseTimeline();
      restorePlanVizTools();
    }
    if (shellKind === "plan") {
      dirty = false;
      void highlighter?.revealAll();
      if (!projectWs?.getPlan() && scheduleRef?.roots.length) {
        projectWs?.bindFromIfc(scheduleRef, models.label());
      }
      if (simKicker) simKicker.textContent = "Gantt";
      currentDateEl.textContent = models.size ? models.label() : "Sem modelo IFC";
    } else if (shellKind === "schedule") {
      setPlanModelOpen(false);
      dirty = true;
      if (simKicker) simKicker.textContent = "Simulação 4D";
      currentDateEl.textContent = formatDateLabel(lastDate);
      if (toggleSchedule) {
        toggleSchedule.title = "Ocultar";
        toggleSchedule.setAttribute("aria-label", "Ocultar");
      }
      void highlighter?.clearIsolation().then(() => {
        dirty = true;
        refitVisibleModels();
      });
    } else if (shellKind === "logistics") {
      setPlanModelOpen(false);
      dirty = true;
      if (simKicker) simKicker.textContent = "Canteiro";
      currentDateEl.textContent = models.size ? models.label() : "Sem modelo IFC";
      if (toggleSchedule) {
        toggleSchedule.title = "Ocultar canteiro";
        toggleSchedule.setAttribute("aria-label", "Ocultar canteiro");
      }
      onLogisticsWorkspace();
      if (grid?.classList.contains("schedule-collapsed")) setPanelOpen("schedule", true);
    } else {
      setPlanModelOpen(false);
      if (simKicker) simKicker.textContent = tool?.label ?? "Módulo";
      currentDateEl.textContent = models.size ? models.label() : "Sem modelo IFC";
    }
    projectWs?.setActive(shellKind === "plan");
    inspector.setReadOnly(shellKind === "schedule" || shellKind === "logistics");
    renderModulePlaceholder(id);
    refreshLayoutRestore();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  const nav = initModuleNav({
    onRevealSchedule: () => setPanelOpen("schedule", true),
    onWorkspaceChange: (id) => {
      syncWorkspaceChrome(id);
      shell?.closeNavDrawer();
    },
  });
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
        (grid.getAttribute("data-shell") === "schedule" || grid.getAttribute("data-shell") === "logistics") &&
        !grid.classList.contains("schedule-collapsed"),
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
    fileNameEl.title = dirty ? "Há alterações por guardar" : name;
  };

  const syncFileChrome = () => {
    const dirty = models.anyDirty();
    const label = projectName ?? (models.size ? models.label() : "Abrir modelo");
    setFileLabel(label, dirty);
    if (fileExtEl) fileExtEl.textContent = projectName ? "VTWIN" : "IFC";
    if (btnExport) btnExport.disabled = models.size === 0;
    if (btnSaveProject) btnSaveProject.disabled = models.size === 0;
    btnExport?.classList.toggle("is-dirty", dirty);
    btnSaveProject?.classList.toggle("is-dirty", dirty);
    if (btnExportLabel) btnExportLabel.textContent = models.size > 1 ? "Exportar IFCs" : "Exportar IFC";
    const importLabel = document.getElementById("btn-import-label");
    if (importLabel) importLabel.textContent = models.size ? "Adicionar" : "Abrir";
    btnOpenIfc?.classList.toggle("has-models", models.size > 0);
    btnOpenIfc?.setAttribute("title", models.size ? "Modelos IFC" : "Abrir IFC ou projeto");
  };

  const markIfcDirty = () => {
    btnExport?.classList.add("is-dirty");
    btnExport?.classList.remove("is-exported");
    if (btnExportLabel) btnExportLabel.textContent = models.size > 1 ? "Exportar IFCs" : "Exportar IFC";
    syncFileChrome();
  };

  const exportIfc = () => {
    if (!models.size) return;
    void (async () => {
      try {
        const dirtyModels = models.all.filter((m) => m.session.dirty);
        const coord = models.coordination;
        if (coord) {
          for (const d of models.disciplines) {
            d.session.syncCoordinationBindings(coord.session.schedule);
          }
        }
        let list = dirtyModels.length ? dirtyModels : [...models.all];
        if (coord && !list.includes(coord)) list = [coord, ...list];
        list.sort((a, b) => Number(b.role === "coordination") - Number(a.role === "coordination"));
        for (let i = 0; i < list.length; i++) {
          if (i) await new Promise((r) => setTimeout(r, 280));
          const entry = list[i]!;
          const downloadName =
            entry.role === "coordination" ? coordinationExportName(projectName, entry.fileName) : undefined;
          await entry.session.download(downloadName);
          entry.hash = entry.session.sourceHash ?? entry.hash;
        }
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
    })();
  };

  const saveProject = () => {
    if (!models.size) return;
    void (async () => {
      try {
        setLoading(true, "A guardar projeto");
        setStatus("Projeto");
        ensurePlanning();
        const coord = models.coordination;
        if (coord) {
          coord.session.markPlanningForExport();
          if (!coord.hash || coord.session.dirty) {
            coord.hash = await persistCoordinationSession(coord.session);
          }
          for (const d of models.disciplines) {
            d.session.syncCoordinationBindings(coord.session.schedule);
          }
        }
        const packed: VtwinPackModel[] = [];
        for (const entry of models.all) {
          const vp = viewportModels.get(entry.id);
          let extra = entry.session.getExtraTransform();
          if (extraIsIdentity(extra) && vp) {
            extra = extraFromObject(vp.object);
            if (!extraIsIdentity(extra)) entry.session.hydrateExtraTransform(extra);
          }
          let ifc: Uint8Array;
          const hasPlanning = entry.session.dirty;
          if (hasPlanning) {
            ifc = await entry.session.exportBytes();
            entry.hash = entry.session.sourceHash ?? (await hashIfcBytes(ifc));
          } else if (entry.hash) {
            const stored = await loadIfcBytes(entry.hash);
            if (!stored) throw new Error(`Não há IFC canónico de «${entry.displayName}».`);
            ifc = stored;
          } else {
            throw new Error(`Não há IFC canónico de «${entry.displayName}».`);
          }
          const hash = entry.hash ?? (await hashIfcBytes(ifc));
          entry.hash = hash;
          let frag: Uint8Array | null = null;
          if (vp) {
            try {
              frag = await exportFragmentsBuffer(vp);
              await saveCachedModel(hash, frag, entry.session.schedule, {
                ifcSchema: entry.session.ifcSchema,
                sourceByteLength: ifc.byteLength,
                index: entry.session.stepIndex,
              });
            } catch (err) {
              console.warn("Fragments no projeto:", err);
            }
          } else {
            const cached = await getCachedModel(hash);
            frag = cached?.frag ?? null;
          }
          packed.push({
            id: entry.id,
            fileName: entry.fileName,
            schema: entry.session.ifcSchema,
            hash,
            visible: entry.visible,
            extra,
            ifc,
            frag,
            schedule: entry.session.schedule,
            index: entry.session.stepIndex,
            role: entry.role,
          });
        }
        const name = projectName ?? models.label();
        const bytes = await packVtwin(name, packed);
        downloadBytes(bytes, vtwinDownloadName(name));
        projectName = name;
        btnExport?.classList.remove("is-dirty");
        btnSaveProject?.classList.remove("is-dirty");
        syncFileChrome();
        setLoading(false);
      } catch (err) {
        console.error(err);
        setLoading(false);
        window.alert(`Não foi possível guardar o projeto: ${(err as Error).message}`);
      }
    })();
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
  let timelinePlaying = false;
  const timeline = new TimelineUI({
    container: timelineEl,
    schedule: placeholder,
    onDateChange: (date) => {
      lastDate = date;
      dirty = true;
      if (workspaceShell(nav.getWorkspace()) === "schedule") {
        currentDateEl.textContent = formatDateLabel(date);
      }
      const now = performance.now();
      if (!timelinePlaying || now - lastHudMs > 100) {
        lastHudMs = now;
        tree.update(date);
        refreshInspector();
        refreshCost5d();
      }
    },
    onPlayingChange: (playing) => {
      timelinePlaying = playing;
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
    const resolved = resolvePlanningTask(task.id, task.globalId);
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
    setStatus("vtwin");
    const viewer = await createViewer(viewportEl);
    attachPerfStats(
      viewer.world,
      viewportEl.closest<HTMLElement>(".viewport-stage") ?? viewportEl,
    );
    highlighter = new ScheduleHighlighter(viewer.fragments);
    refitVisibleModels = () => {
      void fitCameraToVisibleModels(viewer, { skipModelIds: skipFitIds() });
    };
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
        if (sets.length) await fitCameraToItemSets(viewer, sets, { skipModelIds: skipFitIds() });
      }
    };

    const fitCurrentView = () => {
      if (walk?.enabled) {
        walk.respawn();
        return;
      }
      const sets = highlighter?.selectionItems() ?? [];
      if (sets.some((s) => s.localIds.length)) void fitCameraToItemSets(viewer, sets, { skipModelIds: skipFitIds() });
      else void fitCameraToVisibleModels(viewer, { skipModelIds: skipFitIds() });
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
      const guid = hit.globalId;
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
    ifcTree?.attachFilterUi({
      modelSelect: document.getElementById("ifc-tree-model") as HTMLSelectElement | null,
      typeSelect: document.getElementById("ifc-tree-type") as HTMLSelectElement | null,
      viewButtons: document.querySelectorAll<HTMLButtonElement>("[data-ifc-view]"),
    });
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
              projectWs?.notify("Removido");
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
              projectWs?.notify("Conjunto");
            } catch (err) {
              projectWs?.notify((err as Error).message);
            }
          },
          onAssign: (id) => assignGroupToSelectedTask(id),
          onDropGuids: (id, guids) => addGuidsToGroup(id, guids),
          onReorder: (fromId, beforeId) => reorderGroup(fromId, beforeId),
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

    const addGuidsToGroup = (id: number, extra: string[]) => {
      if (!highlighter || !extra.length) return;
      const resolved = models.resolveGroup(id);
      const group = scheduleRef?.groups.find((g) => g.id === id);
      if (!group || !resolved) return;
      const members = new Map(group.productGuids.map((g, i) => [g, group.productIds[i]]));
      for (const g of extra) {
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
      } catch (err) {
        projectWs?.notify((err as Error).message);
      }
    };

    const reorderGroup = (fromId: number, beforeId: number | null) => {
      const from = models.resolveGroup(fromId);
      if (!from) return;
      const before = beforeId != null ? models.resolveGroup(beforeId) : null;
      if (before && before.model.id !== from.model.id) return;
      const list = from.session.schedule.groups;
      const i = list.findIndex((g) => g.id === from.nativeId);
      if (i < 0) return;
      const [item] = list.splice(i, 1);
      if (!item) return;
      if (!before) list.push(item);
      else {
        const j = list.findIndex((g) => g.id === before.nativeId);
        list.splice(j < 0 ? list.length : j, 0, item);
      }
      renderSets();
    };

    const createSetFromSelection = () => {
      if (!models.size || !highlighter) {
        projectWs?.notify("IFC");
        return;
      }
      const guids = highlighter.getWorkingGuids();
      if (!guids.length) {
        projectWs?.notify("Seleção");
        return;
      }
      const n = (scheduleRef?.groups.length ?? 0) + 1;
      const name = `Conjunto ${n}`;
      try {
        const hl = highlighter;
        const refs = hl.refsOf(guids);
        const byModel = new Map<string, Array<{ guid: string; expressId?: number }>>();
        for (const r of refs) {
          const list = byModel.get(r.modelId) ?? [];
          list.push({ guid: r.globalId, expressId: r.expressId });
          byModel.set(r.modelId, list);
        }
        if (!byModel.size) {
          projectWs?.notify("IFC");
          return;
        }
        const task = projectWs?.getSelected();
        const taskRef = task?.linkedIfcTaskId != null ? resolvePlanningTask(task.linkedIfcTaskId) : null;
        const members = [...byModel.values()].flat();
        const root = ensurePlanning();
        if (!root) {
          projectWs?.notify("IFC");
          return;
        }
        const group = root.session.createGroup(name, members);
        let lastGuids = group.productGuids;
        if (taskRef && taskRef.session === root.session && task?.linkedIfcTaskId != null) {
          const linked = root.session.assignGroupToTask(taskRef.nativeId, group.id);
          lastGuids = linked.guids;
          projectWs?.applyProductGuids(task.linkedIfcTaskId, linked.guids);
        }
        setsList?.setSelected(encodeIfcRef(root.slot, group.id));
        if (lastGuids.length) void focusGuidsInView(lastGuids);
        bumpSimulation(guids);
        markIfcDirty();
        refreshFederatedView({ structure: true });
        projectWs?.notify(name);
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
        projectWs?.notify("Gantt");
        return;
      }
      const groupRef = models.resolveGroup(groupId);
      const taskRef = resolvePlanningTask(task.linkedIfcTaskId);
      if (!groupRef || !taskRef) return;
      if (groupRef.model.id !== taskRef.model.id) {
        projectWs?.notify("IFC");
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
        projectWs?.notify(added ? "Ligado" : "Desligado");
      } catch (err) {
        projectWs?.notify((err as Error).message);
      }
    };

    assignGroupToFederatedTask = (federatedTaskId, groupId) => {
      const groupRef = models.resolveGroup(groupId);
      const taskRef = resolvePlanningTask(federatedTaskId);
      if (!groupRef || !taskRef) return;
      if (groupRef.model.id !== taskRef.model.id) {
        projectWs?.notify("Ficheiro");
        return;
      }
      try {
        const { added, guids } = groupRef.session.assignGroupToTask(taskRef.nativeId, groupRef.nativeId);
        projectWs?.applyProductGuids(federatedTaskId, guids);
        if (added || guids.length) void focusGuidsInView(guids);
        else void highlighter?.clearSelection().then(() => refreshWorkingUi());
        bumpSimulation(guids);
        markIfcDirty();
        refreshFederatedView({ structure: true });
        projectWs?.notify(added ? "Ligado" : "Desligado");
      } catch (err) {
        projectWs?.notify((err as Error).message);
      }
    };

    assignGuidsToFederatedTask = (federatedTaskId, guids) => {
      const taskRef = resolvePlanningTask(federatedTaskId);
      if (!taskRef || !highlighter || !guids.length) return;
      const task = taskRef.session.schedule.byId.get(taskRef.nativeId);
      let last: string[] = task ? [...(scheduleRef?.productGuidsByTask.get(federatedTaskId) ?? task.productGuids)] : [];
      let changed = false;
      for (const guid of guids) {
        if (task?.productGuids.includes(guid)) continue;
        try {
          const ownerId = highlighter.guidModelId(guid);
          const localId = ownerId ? highlighter.localIdOf(guid, ownerId) : undefined;
          const result = taskRef.session.assignProductToTask(taskRef.nativeId, guid, localId);
          last = result.guids;
          changed = true;
        } catch (err) {
          projectWs?.notify((err as Error).message);
        }
      }
      if (!changed) return;
      projectWs?.applyProductGuids(federatedTaskId, last);
      bumpSimulation(guids);
      markIfcDirty();
      refreshFederatedView({ structure: true });
      if (last.length) void focusGuidsInView(last);
      projectWs?.notify("3D");
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
        projectWs?.notify("Conjunto");
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
        if (tab === "tree") bindSpatialTree();
      });
    });

    bindSpatialTree = () => {
      if (!highlighter) return;
      const pane = document.querySelector<HTMLElement>('[data-ms-pane="tree"]');
      if (pane?.classList.contains("is-hidden")) return;
      applyIfcRelations(false);
      const entries = models.visible
        .filter((m) => m.role !== "coordination" && !/^coord$/i.test(m.fileName.replace(/\.ifc$/i, "")))
        .map((m) => ({ entry: m, model: viewportModels.get(m.id) }))
        .filter((item): item is { entry: (typeof models.visible)[number]; model: NonNullable<typeof item.model> } => !!item.model)
        .map((m) => ({
          model: m.model,
          label: m.entry.displayName,
          modelId: m.entry.id,
        }));
      void ifcTree?.bindMany(entries, highlighter).then(() => refreshWorkingUi());
      renderSets();
    };

    const syncWalkModels = () => {
      const vis = viewportModels.values(models.visible.map((model) => model.id));
      void walk?.setModel(vis.length ? vis : null);
    };

    const attachGizmoToActive = (_reset: boolean) => {
      const m = meshEntry();
      const viewportModel = m ? viewportModels.get(m.id) : null;
      if (!m?.visible || !viewportModel) {
        gizmo.attach(null);
        return;
      }
      gizmo.attach(viewportModel.object);
      const extra = m.session.getExtraTransform();
      applyExtraToObject(viewportModel.object, extra);
      gizmo.fitSize(viewportModel.object);
      const site = siteExtra();
      earth.setClipCenter(site.x, site.y, site.z);
    };

    const applyActiveGeoref = (opts: { snap?: boolean; resetGizmo?: boolean } = {}) => {
      const mesh = meshEntry();
      const coordGeo = models.coordination?.session.schedule.georef;
      const meshGeo = mesh?.session.schedule.georef;
      if (models.coordination && !hasGeographicAnchor(coordGeo) && hasGeographicAnchor(meshGeo)) {
        models.coordination.session.schedule.georef = { ...meshGeo };
      }
      const georef = [models.coordination?.session.schedule.georef, meshGeo].find(hasGeographicAnchor) ?? coordGeo ?? meshGeo;
      if (!models.coordination && !mesh) return;
      const extra = mesh?.session.getExtraTransform() ?? emptyExtraTransform();
      const storedAlt = georef?.elevation;
      const hasAlt = hasStoredSiteElevation(storedAlt);
      const live = earth.getAnchor();
      if (hasGeographicAnchor(georef)) {
        const anchor: AnchorLLA = {
          lat: georef.lat,
          lon: georef.lon,
          altitude: hasAlt ? storedAlt! : 0,
          heading: georef.heading,
        };
        earth.setAnchor(anchor, { snap: !!opts.snap && !hasAlt && earth.enabled });
        if (hasAlt) earthPanel?.setTerrainHeight(anchor.altitude);
        else earthPanel?.setTerrainHeight(null, earth.enabled ? "a amostrar o terreno…" : "Assentar grava a cota no IFC");
      } else if (hasGeographicAnchor({ source: "none", heading: 0, lat: live.lat, lon: live.lon })) {
        if (opts.snap && earth.enabled) earth.requestTerrainSnap();
        earthPanel?.setTerrainHeight(
          hasStoredSiteElevation(live.altitude) ? live.altitude : null,
          earth.enabled ? "a amostrar o terreno…" : "Assentar grava a cota no IFC",
        );
      } else {
        earth.setAnchor({ ...FALLBACK_ANCHOR, heading: georef?.heading ?? 0 }, { snap: !!opts.snap && earth.enabled });
        earthPanel?.setTerrainHeight(null, earth.enabled ? "a amostrar o terreno…" : "Assentar grava a cota no IFC");
      }
      earthPanel?.setState({
        anchor: earth.getAnchor(),
        hideRadius: earth.getHideRadius(),
        transform: extra,
      });
      earthPanel?.setSource(
        hasGeographicAnchor(georef) ? georefSourceLabel(georef) : "IFC sem coordenadas geográficas",
      );
      attachGizmoToActive(opts.resetGizmo === true);
      earthPanel?.setMode(null);
      syncGizmo();
      refreshSiteVisual();
    };

    refreshFederatedView = (opts) => {
      const keepId = selectedTask?.id ?? null;
      earth.setIfcModelCount(models.visible.length);
      scheduleRef = models.size ? models.mergedSchedule() : emptySchedule();
      const schedule = scheduleRef;
      const structure = opts?.structure !== false;
      if (!models.size || schedule.roots.length === 0) {
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
        tree.refreshLayout();
        if (keepId != null) selectedTask = schedule.byId.get(keepId) ?? selectedTask;
        simHud?.bind(schedule);
        timeline.setRange(schedule.minDate, schedule.maxDate);
      }
      const coord = models.coordination;
      scheduleNameEl.textContent = models.size ? scheduleTitle(schedule) : "Importe um arquivo IFC";
      scheduleNameEl.title = coord
        ? `${coord.displayName} · cronograma da raiz`
        : models.size
          ? models.all.map((m) => m.displayName).join(", ")
          : "IfcWorkPlan / IfcWorkSchedule / IfcTask";
      if (scheduleCountEl) {
        scheduleCountEl.textContent = String(schedule.leafTaskCount);
        scheduleCountEl.title = `${schedule.leafTaskCount} tarefas-folha`;
      }
      if (structure) projectWs?.bindFromIfc(schedule, models.label());
      if (structure) bindSpatialTree();
      else applyIfcRelations(false);
      renderSets();
      renderModelLayers();
      syncFileChrome();
      refreshLayoutRestore();
      refreshInspector();
      refreshCost5d();
      if (models.visible.length) tree.update(lastDate);
      refreshSiteVisual();
    };

    const FALLBACK_ANCHOR: AnchorLLA = {
      lat: -23.5614,
      lon: -46.6559,
      altitude: 0,
      heading: 0,
    };
    const apiKey = (import.meta.env?.VITE_GOOGLE_MAP_TILES_API_KEY as string | undefined) ?? "";
    let earthWanted = false;
    let applyTerrainSnap: (alt: number) => void = () => {};
    let refreshSiteVisual = () => {};
    let onEarthTilesReady = () => {};
    let earthPanel: EarthPanel | null = null;
    const earth = new GoogleEarthLayer(viewer.world, {
      apiKey,
      anchor: FALLBACK_ANCHOR,
      hideRadiusMeters: 0,
      onTerrainSnap: (alt) => applyTerrainSnap(alt),
      onTerrainSnapFail: () => {
        earthPanel?.setTerrainHeight(null, "sem malha — clica Assentar outra vez");
      },
      onLoadError: (message) => {
        earthPanel?.setTerrainHeight(null, message);
        showEarthStatus(message);
        setEarthEnabledUi(earth.enabled);
      },
      onTilesReady: () => onEarthTilesReady(),
    });

    const setEarthPanelOpen = (open: boolean) => {
      if (open) earthPanel?.show();
      else earthPanel?.hide();
      btnEarthSettings?.classList.toggle("is-active", open);
      btnEarthSettings?.setAttribute("aria-pressed", open ? "true" : "false");
      if (btnEarthSettings) {
        btnEarthSettings.title = open ? "Ocultar posição do modelo" : "Mostrar posição do modelo";
      }
      refreshLayoutRestore();
    };
    openEarthPanel = setEarthPanelOpen;

    const gizmo = new ModelGizmo({
      scene: viewer.world.scene.three,
      camera: viewer.world.camera as import("@thatopen/components").OrthoPerspectiveCamera,
      domElement: viewer.world.renderer!.three.domElement,
      onChange: (t) => {
        earthPanel?.setTransform(t);
        const mesh = meshEntry();
        mesh?.session.setExtraTransform(t);
        if (mesh && !extraIsIdentity(t)) markIfcDirty();
        const site = siteExtra();
        earth.setClipCenter(site.x, site.y, site.z);
      },
    });
    viewer.world.onCameraChanged.add(() => gizmo.updateCamera());
    modelGizmo = gizmo;
    applyTerrainSnap = (alt) => {
      earthPanel?.setTerrainHeight(alt);
      earthPanel?.setTerrainY(0, false);
      const a = earth.getAnchor();
      if (models.active || models.coordination) {
        planningSession()?.setGeoAnchor({ lat: a.lat, lon: a.lon, elevation: alt });
        markIfcDirty();
      }
      refreshSiteVisual();
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
            const geoMoved = prev.lat !== state.anchor.lat || prev.lon !== state.anchor.lon;
            earth.setAnchor(
              {
                lat: state.anchor.lat,
                lon: state.anchor.lon,
                altitude: prev.altitude,
                heading: prev.heading,
              },
              { snap: geoMoved && earth.enabled },
            );
            earth.setHideRadius(state.hideRadius);
            if (geoMoved && (models.active || models.coordination)) {
              const a = earth.getAnchor();
              planningSession()?.setGeoAnchor({
                lat: state.anchor.lat,
                lon: state.anchor.lon,
                elevation: a.altitude,
              });
              markIfcDirty();
            }
          },
          onTransformChange: (t) => {
            gizmo.apply(t);
            const mesh = meshEntry();
            mesh?.session.setExtraTransform(t);
            if (mesh && !extraIsIdentity(t)) markIfcDirty();
            const site = siteExtra();
            earth.setClipCenter(site.x, site.y, site.z);
          },
          onTerrainY: (delta) => {
            earth.raiseTerrain(delta);
            const a = earth.getAnchor();
            if (models.active || models.coordination) {
              planningSession()?.setGeoAnchor({ lat: a.lat, lon: a.lon, elevation: a.altitude });
              markIfcDirty();
            }
            refreshSiteVisual();
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
      const allow = workspaceHasEarth(nav.getWorkspace()) && !walk?.enabled;
      gizmo.setAllowed(allow);
      if (!allow) earthPanel?.setMode(null);
      if (btnEarthSettings) btnEarthSettings.hidden = !allow;
    };

    const toggleGizmoMode = (mode: GizmoMode) => {
      if (!workspaceHasEarth(nav.getWorkspace()) || walk?.enabled) return;
      const next = gizmo.getMode() === mode ? null : mode;
      gizmo.setMode(next);
      earthPanel?.setMode(next);
    };

    const setEarthEnabledUi = (enabled: boolean) => {
      btnEarth?.classList.toggle("is-active", enabled);
      btnEarth?.setAttribute("aria-pressed", enabled ? "true" : "false");
      if (btnEarth) btnEarth.title = enabled ? "Ocultar contexto Google Earth" : "Mostrar contexto Google Earth";
      earthPanelRoot?.classList.toggle("is-earth-on", enabled);
      syncGizmo();
      if (enabled && !walk?.enabled) setEarthPanelOpen(true);
      const q = deviceGraphicsQuality();
      setAllModelsQuality(viewer.fragments, enabled ? Math.min(q, 0.45) : q);
      setWorldGridVisible(viewer.world, !enabled);
      refreshSiteVisual();
    };
    syncGizmo();

    const canvas = viewer.world.renderer!.three.domElement;
    if (btnWalk && walkOverlay && walkHint) {
      walk = new FirstPersonController({
        camera: viewer.world.camera as import("@thatopen/components").OrthoPerspectiveCamera,
        domElement: canvas,
        overlay: walkOverlay,
        hint: walkHint,
        button: btnWalk,
        earth,
        canEnable: () => workspaceHasEarth(nav.getWorkspace()),
        onEnabledChange: (on) => {
          syncGizmo();
          if (on) setEarthPanelOpen(false);
        },
        onCameraMove: () => {
          const t = performance.now();
          if (t - lastWalkFragUpdate < 48) return;
          lastWalkFragUpdate = t;
          void requestFragmentsUpdate(viewer.fragments);
        },
      });
    }

    const siteOverlay = new SiteOverlay(viewer.world.scene.three);
    const drawHint = document.getElementById("link-mode-hint");
    const setDrawHint = (text: string | null) => {
      if (!drawHint) return;
      if (!text) {
        if (nav.getWorkspace() !== "project-plan") {
          drawHint.hidden = true;
          drawHint.textContent = "";
        }
        return;
      }
      drawHint.hidden = false;
      drawHint.textContent = text;
    };

    const refreshSiteVisualNow = (draft?: import("three").Vector3[], skipUi = false) => {
      const planning = models.coordination?.session ?? models.active?.session;
      const extra = siteExtra();
      const limit = planning?.getSiteLimit() ?? null;
      if (earth.hasTiles()) {
        const clip = siteOverlay.clipPolygon(limit, extra);
        if (clip) earth.setSiteClip(clip.xz, clip.yMin, clip.yMax);
        else earth.setSiteClip(null);
      } else {
        earth.setSiteClip(null);
      }
      siteOverlay.apply(limit, extra, draft, {
        earthEnabled: earth.enabled,
        sampleGround: earth.enabled ? (x, z, aroundY) => earth.sampleGroundY(x, z, aroundY) : null,
      });
      walk?.collider.setSiteGround(siteOverlay.ground);
      if (!skipUi && !draft) logisticsWs?.refresh();
    };
    refreshSiteVisual = () => refreshSiteVisualNow();

    const siteDraw = new SiteDrawController({
      viewport: document.getElementById("viewport") ?? canvas,
      camera: viewer.world.camera as import("@thatopen/components").OrthoPerspectiveCamera,
      earth,
      onDraft: (pts) => {
        logisticsWs?.setDraftCount(pts.length);
        refreshSiteVisualNow(pts);
        setDrawHint(
          pts.length < 3
            ? `Limite: ${pts.length} vértice${pts.length === 1 ? "" : "s"} · continua a clicar`
            : "Enter ou duplo clique fecha o polígono",
        );
      },
      onComplete: (worldPts) => {
        const session = planningSession();
        logisticsWs?.setDrawing(false);
        setDrawHint(null);
        if (!session || worldPts.length < 3) {
          refreshSiteVisual();
          return;
        }
        const extra = siteExtra();
        const ifcPts = worldPts.map((p) => threeWorldToIfc(p, extra));
        const z = ifcPts.reduce((s, p) => s + p.z, 0) / ifcPts.length;
        const prev = session.getSiteLimit();
        session.setSiteLimit({
          ...defaultSiteLimit(
            ifcPts.map((p) => ({ ...p, z })),
            prev?.name || "Canteiro",
          ),
          globalId: prev?.globalId ?? "",
          clipBelow: prev?.clipBelow ?? 40,
          clipAbove: prev?.clipAbove ?? 80,
          clipBuffer: prev?.clipBuffer ?? 1.5,
          showPlateau: prev?.showPlateau ?? true,
          annotationId: prev?.annotationId,
          clusterIds: prev?.clusterIds,
        });
        markIfcDirty();
        refreshSiteVisual();
      },
      onCancel: () => {
        logisticsWs?.setDrawing(false);
        setDrawHint(null);
        refreshSiteVisual();
      },
    });
    onEarthTilesReady = () => {
      if (siteDraw.active) return;
      refreshSiteVisualNow(undefined, true);
    };

    const logisticsRoot = document.getElementById("logistics-panel");
    const logisticsWs = logisticsRoot
      ? new LogisticsWorkspace(logisticsRoot, {
          hasModel: () => models.size > 0,
          getLimit: () => (models.coordination?.session ?? models.active?.session)?.getSiteLimit() ?? null,
          getExtra: () => siteExtra(),
          onDraw: () => {
            const mesh = meshEntry();
            if (!mesh && !models.size) {
              window.alert("Abre um IFC para gravar o limite no modelo.");
              return;
            }
            ensurePlanning();
            siteDraw.setPlaneY(siteExtra().y);
            logisticsWs?.setDrawing(true);
            siteDraw.startDraw();
            setDrawHint("Clica no terreno para os vértices do canteiro");
            if (apiKey && !earth.enabled) {
              earthWanted = true;
              void earth.setEnabled(true).then((how) => {
                setEarthEnabledUi(earth.enabled);
                if (earth.enabled) {
                  showEarthStatus(null);
                  applyActiveGeoref({ snap: how === "created" });
                }
              }).catch((err) => {
                showEarthStatus((err as Error).message);
              });
            }
          },
          onFinishDraw: () => {
            if (!siteDraw.finish()) window.alert("São precisos pelo menos 3 vértices.");
          },
          onCancelDraw: () => siteDraw.cancel(),
          onPatch: (patch) => {
            const session = planningSession();
            const cur = session?.getSiteLimit();
            if (!session || !cur) return;
            session.setSiteLimit({ ...cur, ...patch, points: patch.points ?? cur.points });
            markIfcDirty();
            refreshSiteVisual();
          },
          onDelete: () => {
            planningSession()?.clearSiteLimit();
            markIfcDirty();
            refreshSiteVisual();
          },
        })
      : null;

    onLogisticsWorkspace = () => {
      void (async () => {
        if (models.coordination) await models.coordination.session.hydrateSiteLimit();
        else if (models.active) await models.active.session.hydrateSiteLimit();
        logisticsWs?.refresh();
        refreshSiteVisual();
        if (nav.getWorkspace() !== "logistics") return;
        if (grid?.classList.contains("schedule-collapsed")) setPanelOpen("schedule", true);
        if (apiKey && !earth.enabled) {
          try {
            earthWanted = true;
            const how = await earth.setEnabled(true);
            setEarthEnabledUi(true);
            showEarthStatus(null);
            applyActiveGeoref({ snap: how === "created" });
          } catch (err) {
            console.warn("Terreno Google não ativou na logística:", err);
            showEarthStatus((err as Error).message);
          }
        }
      })();
    };
    if (nav.getWorkspace() === "logistics") onLogisticsWorkspace();

    disablePlanVizTools = () => {
      if (walk?.enabled) walk.disable();
      syncGizmo();
      setEarthPanelOpen(false);
      showEarthStatus(null);
      if (earth.enabled) {
        void earth.setEnabled(false).then(() => setEarthEnabledUi(false));
      }
    };
    restorePlanVizTools = () => {
      syncGizmo();
      if (!earthWanted || !apiKey || earth.enabled) return;
      if (!workspaceHasEarth(nav.getWorkspace())) return;
      void earth.setEnabled(true).then((how) => {
        setEarthEnabledUi(earth.enabled);
        if (earth.enabled) {
          showEarthStatus(null);
          applyActiveGeoref({ snap: how === "created" });
        }
      }).catch((err) => {
        showEarthStatus((err as Error).message);
      });
    };

    btnEarthSettings?.addEventListener("click", () => {
      if (!workspaceHasEarth(nav.getWorkspace())) return;
      setEarthPanelOpen(!earthPanel?.isVisible());
    });

    btnEarth?.addEventListener("click", async () => {
      if (!workspaceHasEarth(nav.getWorkspace())) return;
      if (!apiKey) {
        window.alert(
          "Para ativar a camada Google Earth define a variavel VITE_GOOGLE_MAP_TILES_API_KEY " +
            "(num arquivo .env na raiz) com a tua chave da Google Map Tiles API e reinicia o dev server.",
        );
        return;
      }
      const next = !earth.enabled;
      earthWanted = next;
      try {
        const how = await earth.setEnabled(next);
        setEarthEnabledUi(earth.enabled);
        if (next) {
          showEarthStatus(null);
          applyActiveGeoref({ snap: how === "created" });
        } else {
          showEarthStatus(null);
        }
        if (walk?.enabled) earth.setWalkQuality(true);
      } catch (err) {
        console.error("Falha a (des)ativar Google Earth:", err);
        const message = (err as Error).message;
        showEarthStatus(message);
        window.alert(`Não foi possível ativar o Google Earth: ${message}`);
      }
    });

    const popover = document.getElementById("model-popover");
    const layersUi = popover
      ? new ModelLayersUI(popover, {
          onToggle: (id, visible) => void setModelLayerVisible(id, visible),
          onSelect: (id) => {
            models.setActive(id);
            attachGizmoToActive(false);
            applyActiveGeoref({ snap: false, resetGizmo: false });
            renderModelLayers();
          },
          onRemove: (id) => void removeLoadedModel(id),
          onReplace: (id) => pickReplaceIfc(id),
          onAdd: () => pickIfcFile(),
          onReorder: (id, beforeId) => {
            models.move(id, beforeId);
            renderModelLayers();
          },
        })
      : null;
    renderModelLayers = () => {
      layersUi?.render(models.all, models.activeId);
      if (!models.size && popover) {
        popover.hidden = true;
        btnOpenIfc?.setAttribute("aria-expanded", "false");
      }
    };

    const setModelLayerVisible = async (id: string, visible: boolean) => {
      const entry = models.get(id);
      if (!entry) return;
      if (entry.role === "coordination") {
        models.setVisible(id, visible);
        refreshFederatedView({ structure: true });
        dirty = true;
        return;
      }
      if (!visible) {
        await highlighter?.removeModel(id);
        if (viewportModels.get(id)) {
          await unloadIfc(viewer, id);
          viewportModels.detach(id);
        }
        models.setVisible(id, false);
        entry.session.dropText();
      } else {
        try {
          const cached = entry.hash ? await getCachedModel(entry.hash) : null;
          let model: import("@thatopen/fragments").FragmentsModel;
          if (cached?.frag) {
            ({ model } = await loadFragments(viewer, cached.frag, id));
          } else {
            const bytes = entry.hash ? await loadIfcBytes(entry.hash) : null;
            if (!bytes) {
              window.alert(`Não foi possível recarregar «${entry.displayName}». Volte a importar o IFC.`);
              return;
            }
            const sourceByteLength = bytes.byteLength;
            const prepared = await prepareIfcOffthread(bytes, { transferOwnership: true });
            ({ model } = await loadIfc(viewer, prepared.bytes, id));
            if (entry.hash) {
              void exportFragmentsBuffer(model)
                .then((frag) =>
                  saveCachedModel(entry.hash!, frag, entry.session.schedule, {
                    ifcSchema: entry.session.ifcSchema,
                    sourceByteLength,
                    index: entry.session.stepIndex,
                  }),
                )
                .catch((err) => console.warn("Cache Fragments:", err));
            }
          }
          viewportModels.attach(id, model);
          models.setVisible(id, true);
          applyExtraToObject(model.object, entry.session.getExtraTransform());
          if (!highlighter) highlighter = new ScheduleHighlighter(viewer.fragments);
          await highlighter.addModel(id, model, collectAllGuids(models.mergedSchedule()));
        } catch (err) {
          console.error(err);
          window.alert(`Não foi possível mostrar «${entry.displayName}»: ${(err as Error).message}`);
          return;
        }
      }
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
      viewportModels.detach(id);
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
        projectName = null;
      } else {
        attachGizmoToActive(false);
        syncWalkModels();
      }
      refreshFederatedView({ structure: true });
      dirty = true;
    };

    const ingestIfc = async (
      buffer: Uint8Array,
      fileName: string,
      opts?: {
        modelId?: string;
        skipDuplicateCheck?: boolean;
        frag?: Uint8Array | null;
        schedule?: ScheduleData | null;
        index?: import("./ifc/stepIndex").StepIndex | null;
        schema?: import("./ifc/stepText").IfcSchemaKind;
      },
    ) => {
      setImportVisible(false);
      setStatus("IFC");
      performance.mark("vista:load:start");
      const sourceByteLength = buffer.byteLength;
      const hash = await hashIfcBytes(buffer);
      markLoad("vista:hash", "vista:load:start");
      if (!opts?.skipDuplicateCheck && hash && models.hasHash(hash)) {
        window.alert(`«${fileName}» já está na vista.`);
        return null;
      }
      const cached = hash ? await getCachedModel(hash) : null;
      const cacheHasCanonicalSource = cached?.warmReady === true && (await hasIfcBytes(hash));
      const sourceStored = cacheHasCanonicalSource ? true : await saveIfcBytes(hash, buffer);
      markLoad("vista:cache", "vista:hash");

      const first = models.disciplines.length === 0;
      const modelId = opts?.modelId ?? `ifc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      timeline.pause();

      let schedule: ScheduleData;
      let loaded: Awaited<ReturnType<typeof loadIfc>>;
      let index: import("./ifc/stepIndex").StepIndex;
      let schema: import("./ifc/stepText").IfcSchemaKind;
      const packWarm = !!(opts?.frag && opts.schedule && opts.index && opts.schema);
      const cacheWarm = cached?.warmReady === true && !!cached.schedule && !!cached.index && !!cached.manifest;
      const packedSchedule = opts?.schedule && opts.schedule.roots.length ? opts.schedule : null;
      const warm = packWarm || cacheWarm;

      if (packWarm) {
        setStatus("3D");
        schedule = packedSchedule ?? opts.schedule!;
        index = opts.index!;
        schema = opts.schema!;
        loaded = await loadFragments(viewer, opts.frag!, modelId);
        markLoad("vista:warm-load", "vista:cache");
      } else if (cacheWarm) {
        setStatus("3D");
        schedule = packedSchedule ?? cached.schedule!;
        index = opts?.index ?? cached.index!;
        schema = opts?.schema ?? cached.manifest!.ifcSchema;
        loaded = await loadFragments(viewer, cached.frag, modelId);
        markLoad("vista:warm-load", "vista:cache");
      } else {
        setStatus("Preparando IFC");
        const prepared = await prepareIfcOffthread(buffer, { transferOwnership: sourceStored });
        markLoad("vista:prepare", "vista:cache");
        index = prepared.index;
        schema = prepared.schema;
        setStatus("3D");
        loaded = await loadIfc(
          viewer,
          prepared.bytes,
          modelId,
          (p, phase) => {
            const label =
              phase === "geometries"
                ? "Geometria"
                : phase === "attributes"
                  ? "Atributos"
                  : phase === "relations"
                    ? "Relações"
                    : "IFC";
            setStatus(`${label} ${(p * 100).toFixed(0)}%`);
          },
        );
        setStatus("Cronograma");
        const fromFragments = await measureAsync(
          "vista:schedule:fragments",
          () => parseScheduleFromFragments(loaded.model, index),
          () => ({ modelId }),
        );
        schedule =
          packedSchedule ??
          (fromFragments && fromFragments.roots.length ? fromFragments : null) ??
          (await measureAsync(
            "vista:schedule:web-ifc-fallback",
            () => parseSchedule(prepared.bytes, WASM_URL),
            () => ({ modelId }),
          ));
      }
      markLoad("vista:geometry", "vista:load:start");
      const model = loaded.model;
      const session = new IfcSession(sourceStored ? null : buffer, fileName, schedule, {
        index,
        storeHash: hash,
        schema,
        wasmPath: WASM_URL,
      });
      await session.hydrateSiteLimit();
      recordMetric("vista:model:loaded", 0, {
        fileName,
        sourceByteLength,
        warm,
        indexEntities: index.offset.size,
        tasks: schedule.byId.size,
      });
      if (!warm) {
        void exportFragmentsBuffer(model)
          .then((buf) =>
            saveCachedModel(hash, buf, schedule, {
              ifcSchema: schema,
              sourceByteLength,
              index,
            }),
          )
          .catch((err) => console.warn("Cache Fragments:", err));
      } else if (packWarm && hash) {
        void saveCachedModel(hash, opts.frag!, schedule, {
          ifcSchema: schema,
          sourceByteLength,
          index,
        }).catch((err) => console.warn("Cache Fragments:", err));
      }
      return { modelId, hash, fileName, session, model, first, schedule };
    };

    const finishLoadedModel = async (
      ingested: NonNullable<Awaited<ReturnType<typeof ingestIfc>>>,
      opts?: { extra?: import("./ifc/georef").ModelExtraTransform; skipFit?: boolean },
    ) => {
      if (opts?.extra) ingested.session.hydrateExtraTransform(opts.extra);
      const entry = models.add({
        id: ingested.modelId,
        fileName: ingested.fileName,
        session: ingested.session,
        hash: ingested.hash,
        role: "discipline",
      });
      viewportModels.attach(entry.id, ingested.model);
      applyExtraToObject(ingested.model.object, ingested.session.getExtraTransform());
      setStatus(entry.displayName);
      if (!highlighter) highlighter = new ScheduleHighlighter(viewer.fragments);
      await highlighter.addModel(entry.id, ingested.model, collectAllGuids(models.mergedSchedule()));
      refreshFederatedView({ structure: true });
      if (pendingPlanModel && nav.getWorkspace() === "project-plan") {
        pendingPlanModel = false;
        setPlanModelOpen(true);
      }
      if (ingested.first) {
        earth.setClipCenter(0, 0, 0);
        applyActiveGeoref({ snap: true, resetGizmo: false });
        lastDate = scheduleRef?.minDate ?? ingested.schedule.minDate;
      } else {
        attachGizmoToActive(true);
      }
      const extra = ingested.session.getExtraTransform();
      if (!extraIsIdentity(extra)) gizmo.apply(extra);
      syncWalkModels();
      if (scheduleRef && lastDate < scheduleRef.minDate) lastDate = scheduleRef.minDate;
      if (scheduleRef && lastDate > scheduleRef.maxDate) lastDate = scheduleRef.maxDate;
      dirty = true;
      tree.update(lastDate);
      if (workspaceShell(nav.getWorkspace()) === "schedule") {
        currentDateEl.textContent = formatDateLabel(lastDate);
      } else {
        currentDateEl.textContent = projectName ?? models.label();
      }
      refreshInspector();
      refreshCost5d();
      markLoad("vista:load", "vista:load:start");
      if (!opts?.skipFit) void fitCameraToVisibleModels(viewer, { skipModelIds: skipFitIds() });
    };

    const loadFromBuffer = async (buffer: Uint8Array, fileName: string) => {
      setLoading(true, "");
      const ingested = await ingestIfc(buffer, fileName);
      if (!ingested) {
        setLoading(false);
        if (!models.size) setImportVisible(true);
        return;
      }
      await finishLoadedModel(ingested);
      setLoading(false);
    };

    const finishCoordinationModel = async (member: {
      entry: { id: string; fileName: string; schema: import("./ifc/stepText").IfcSchemaKind; hash: string; extra?: import("./ifc/georef").ModelExtraTransform };
      ifc: Uint8Array;
      schedule: ScheduleData | null;
      index: import("./ifc/stepIndex").StepIndex | null;
    }) => {
      const hash = member.entry.hash || (await hashIfcBytes(member.ifc));
      if (!(await hasIfcBytes(hash))) await saveIfcBytes(hash, member.ifc);
      let schedule = member.schedule && member.schedule.roots.length ? member.schedule : null;
      if (!schedule && member.ifc.byteLength) {
        try {
          schedule = await parseSchedule(member.ifc, WASM_URL);
        } catch (err) {
          console.warn("Cronograma da COORD a partir do IFC:", err);
        }
      }
      schedule ??= emptySchedule();
      const session = new IfcSession(member.ifc, member.entry.fileName, schedule, {
        index: member.index ?? undefined,
        storeHash: hash,
        schema: member.entry.schema,
      });
      if (member.entry.extra) session.hydrateExtraTransform(member.entry.extra);
      await session.hydrateSiteLimit();
      models.add({
        id: member.entry.id,
        fileName: member.entry.fileName,
        session,
        hash,
        role: "coordination",
      });
    };

    const loadFromVtwin = async (buffer: Uint8Array, fileName: string) => {
      setLoading(true, "A abrir projeto");
      setStatus("Projeto");
      if (!looksLikeZip(buffer)) throw new Error("Este ficheiro não é um projeto vtwin.");
      const unpacked = await unpackVtwin(buffer);
      if (models.size) {
        const ok = window.confirm("Abrir este projeto substitui os modelos atuais na vista. Continuar?");
        if (!ok) {
          setLoading(false);
          return;
        }
        const ids = models.all.map((m) => m.id);
        for (const id of ids) {
          const entry = models.get(id);
          if (!entry) continue;
          await highlighter?.removeModel(id);
          await unloadIfc(viewer, id);
          viewportModels.detach(id);
          models.remove(id);
        }
        selectedTask = null;
      }
      projectName = unpacked.manifest.name || fileName.replace(/\.vtwin$/i, "");
      const members = [...unpacked.models].sort(
        (a, b) =>
          Number(isCoordinationEntry(b.entry, unpacked.manifest.rootId)) -
          Number(isCoordinationEntry(a.entry, unpacked.manifest.rootId)),
      );
      let index = 0;
      for (const member of members) {
        setStatus(`${member.entry.fileName} (${index + 1}/${members.length})`);
        if (isCoordinationEntry(member.entry, unpacked.manifest.rootId)) {
          await finishCoordinationModel(member);
          const entry = models.get(member.entry.id);
          if (entry && !member.entry.visible) models.setVisible(entry.id, false);
          index += 1;
          continue;
        }
        let ingested: Awaited<ReturnType<typeof ingestIfc>> = null;
        try {
          ingested = await ingestIfc(member.ifc, member.entry.fileName, {
            modelId: member.entry.id,
            skipDuplicateCheck: true,
            frag: member.frag,
            schedule: member.schedule,
            index: member.index,
            schema: member.entry.schema,
          });
        } catch (err) {
          console.warn(`IFC «${member.entry.fileName}» no projeto:`, err);
        }
        if (!ingested) {
          if (member.schedule && member.schedule.roots.length) {
            await finishCoordinationModel(member);
            const fallback = models.get(member.entry.id);
            if (fallback && !member.entry.visible) models.setVisible(fallback.id, false);
            index += 1;
            continue;
          }
          continue;
        }
        await finishLoadedModel(ingested, {
          extra: member.entry.extra,
          skipFit: index < members.length - 1,
        });
        const entry = models.get(ingested.modelId);
        if (entry && !member.entry.visible) {
          await setModelLayerVisible(entry.id, false);
        }
        index += 1;
      }
      if (!models.size) {
        projectName = null;
        setImportVisible(true);
        throw new Error("O projeto não carregou nenhum modelo.");
      }
      refreshFederatedView({ structure: true });
      bumpSimulation(collectAllGuids(models.mergedSchedule()));
      for (const m of models.disciplines) {
        const model = viewportModels.get(m.id);
        if (model) applyExtraToObject(model.object, m.session.getExtraTransform());
      }
      applyActiveGeoref({ snap: false, resetGizmo: false });
      syncFileChrome();
      setLoading(false);
    };

    let replaceTargetId: string | null = null;
    const pickReplaceIfc = (id: string) => {
      if (models.get(id)?.role === "coordination") {
        window.alert("A raiz de coordenação não se substitui por um IFC de disciplina.");
        return;
      }
      replaceTargetId = id;
      replaceIfcInput?.click();
    };

    const replaceMemberIfc = async (id: string, buffer: Uint8Array, fileName: string) => {
      const entry = models.get(id);
      if (!entry) return;
      setLoading(true, "A substituir IFC");
      const previous = entry.session.schedule;
      const extra = entry.session.getExtraTransform();
      await highlighter?.removeModel(id);
      await unloadIfc(viewer, id);
      viewportModels.detach(id);
      const ingested = await ingestIfc(buffer, fileName, { modelId: id, skipDuplicateCheck: true });
      if (!ingested) {
        setLoading(false);
        window.alert("Não foi possível substituir o IFC.");
        return;
      }
      const report = ingested.session.adoptPlanningFrom(previous);
      ingested.session.hydrateExtraTransform(extra);
      entry.session = ingested.session;
      entry.hash = ingested.hash;
      models.rename(id, fileName);
      ingested.session.fileName = entry.fileName;
      viewportModels.attach(id, ingested.model);
      if (!highlighter) highlighter = new ScheduleHighlighter(viewer.fragments);
      await highlighter.addModel(id, ingested.model, collectAllGuids(models.mergedSchedule()));
      models.setActive(id);
      attachGizmoToActive(false);
      if (!extraIsIdentity(extra)) gizmo.apply(extra);
      syncWalkModels();
      refreshFederatedView({ structure: true });
      dirty = true;
      tree.update(lastDate);
      refreshInspector();
      refreshCost5d();
      setLoading(false);
      void fitCameraToVisibleModels(viewer, { skipModelIds: skipFitIds() });
      window.alert(listOrphanSummary(report, entry.displayName));
    };

    const pickIfcFile = () => fileInput?.click();

    const resetEmptyWorkspace = () => {
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
      projectName = null;
    };

    const importFiles = async (files: File[]) => {
      if (loading) return;
      const vtwin = files.find((f) => isVtwinFileName(f.name));
      const ifcs = files.filter(isIfcFile);
      if (!vtwin && !ifcs.length) {
        window.alert("Selecione um projeto (.vtwin) ou um ou mais arquivos IFC (.ifc).");
        return;
      }
      loading = true;
      try {
        if (vtwin) {
          const buffer = new Uint8Array(await vtwin.arrayBuffer());
          await loadFromVtwin(buffer, vtwin.name);
        } else {
          for (const file of ifcs) {
            const buffer = new Uint8Array(await file.arrayBuffer());
            await loadFromBuffer(buffer, file.name);
          }
        }
      } catch (err) {
        console.error(err);
        window.alert(`Não foi possível importar: ${(err as Error).message}`);
        if (!models.size) resetEmptyWorkspace();
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
    btnImportPick?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pickIfcFile();
      }
    });
    btnExport?.addEventListener("click", exportIfc);
    btnSaveProject?.addEventListener("click", saveProject);
    replaceIfcInput?.addEventListener("change", () => {
      const file = replaceIfcInput.files?.[0];
      const id = replaceTargetId;
      replaceIfcInput.value = "";
      replaceTargetId = null;
      if (!file || !id || !isIfcFile(file)) return;
      void (async () => {
        if (loading) return;
        loading = true;
        try {
          const buffer = new Uint8Array(await file.arrayBuffer());
          await replaceMemberIfc(id, buffer, file.name);
        } catch (err) {
          console.error(err);
          setLoading(false);
          window.alert(`Não foi possível substituir o IFC: ${(err as Error).message}`);
        } finally {
          loading = false;
        }
      })();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!popover || popover.hidden) return;
      const t = e.target as Node;
      if (popover.contains(t) || btnOpenIfc?.contains(t)) return;
      toggleModelPopover(false);
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !popover || popover.hidden) return;
        e.preventDefault();
        toggleModelPopover(false);
      },
      true,
    );

    const dropVeil = document.getElementById("drop-veil");
    const setFileDrop = (on: boolean) => {
      document.body.classList.toggle("is-dragging-files", on);
      if (dropVeil) dropVeil.hidden = !on;
      viewportShell.classList.toggle("is-drop-target", on);
    };
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setFileDrop(true);
    };
    document.addEventListener("dragenter", onDragOver);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", (e) => {
      if (!isFileDrag(e)) return;
      if (e.relatedTarget) return;
      setFileDrop(false);
    });
    document.addEventListener("drop", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setFileDrop(false);
      if ((e.target as HTMLElement | null)?.closest?.("#project-workspace")) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void importFiles(files);
    });

    // Benchmark reproduzível em desenvolvimento:
    // http://localhost:5173/?ifc=/4D.ifc (recarregue para medir o warm load).
    const devIfcUrl = import.meta.env.DEV
      ? new URLSearchParams(window.location.search).get("ifc")
      : null;
    if (devIfcUrl) {
      void (async () => {
        loading = true;
        try {
          const response = await fetch(devIfcUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const name = decodeURIComponent(devIfcUrl.split("/").pop() || "benchmark.ifc");
          await loadFromBuffer(bytes, name);
        } catch (error) {
          console.error("Benchmark IFC:", error);
          setLoading(false);
          setImportVisible(true);
        } finally {
          loading = false;
        }
      })();
    }

    window.addEventListener("beforeunload", (e) => {
      if (!models.anyDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    });

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
        e.preventDefault();
        saveProject();
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
      if (e.code === "KeyV" && workspaceHasEarth(nav.getWorkspace())) {
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
      if (nav.getWorkspace() === "logistics") {
        if (e.code === "KeyF") {
          e.preventDefault();
          fitCurrentView();
          return;
        }
        if (e.code === "Escape") {
          e.preventDefault();
          return;
        }
        if (e.code === "KeyB") {
          e.preventDefault();
          setPanelOpen("schedule", !!grid?.classList.contains("schedule-collapsed"));
          return;
        }
        if (e.code === "KeyI") {
          e.preventDefault();
          setPanelOpen("inspector", !!grid?.classList.contains("inspector-collapsed"));
          return;
        }
        if (e.code === "KeyG" || (earth.enabled && e.code === "KeyT")) {
          e.preventDefault();
          toggleGizmoMode("translate");
          return;
        }
        if (e.code === "KeyR") {
          e.preventDefault();
          toggleGizmoMode("rotate");
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
      } else if (e.code === "KeyG" || (earth.enabled && e.code === "KeyT")) {
        e.preventDefault();
        toggleGizmoMode("translate");
      } else if (e.code === "KeyR") {
        e.preventDefault();
        toggleGizmoMode("rotate");
      }
    });

    const tick = async () => {
      walk?.update();
      const shellKind = workspaceShell(nav.getWorkspace());
      if (shellKind !== "placeholder" && dirty && !applying && highlighter && scheduleRef && models.visible.length) {
        dirty = false;
        applying = true;
        try {
          if (shellKind === "plan" || shellKind === "logistics") {
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

function coordinationExportName(project: string | null, fileName: string): string {
  const raw = (project || fileName || "COORD").trim() || "COORD";
  const stem = raw.replace(/\.ifc$/i, "").replace(/-coordenacao$/i, "");
  if (/^coord$/i.test(stem)) return "COORD.ifc";
  return `${stem}-coordenacao.ifc`;
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
  const want = [...new Set(guids)];
  if (!want.length) return [];
  const index = getTaskIdsByGuid(schedule);
  const hits = new Set<number>();
  for (const g of want) {
    const list = index.get(g);
    if (!list) continue;
    for (const id of list) hits.add(id);
  }
  if (!hits.size) return [];
  const leaves = [...hits].filter((id) => (schedule.byId.get(id)?.children.length ?? 0) === 0);
  return leaves.length ? leaves : [...hits];
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
