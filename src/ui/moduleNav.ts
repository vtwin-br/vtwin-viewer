import {
  APP_MODULES,
  DEFAULT_WORKSPACE,
  findTool,
  type WorkspaceId,
} from "../app/catalog";

const ICONS: Record<string, string> = {
  planning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="5" width="14" height="16" rx="2"/><path d="M8 4v3M16 4v3M8 11h8M8 15h5" stroke-linecap="round"/></svg>`,
  schedule4d: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 16.5V8.2L12 4l8 4.2v8.3L12 21z" stroke-linejoin="round"/><path d="M4 8.2L12 12.5 20 8.2M12 12.5V21" opacity="0.55" stroke-linejoin="round"/></svg>`,
  projectPlan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h13" stroke-linecap="round"/><path d="M14 10h6v4h-6z" opacity="0.7"/></svg>`,
  inspector: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8 9h8M8 13h5" stroke-linecap="round"/></svg>`,
  collapse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const LS_WORKSPACE = "vista4d.workspace";
const LS_NAV = "vista4d.navCollapsed";
const LS_GROUPS = "vista4d.navGroups";

export interface ModuleNavOptions {
  onWorkspaceChange: (id: WorkspaceId) => void;
  onToggleInspector: () => void;
  inspectorOpen: () => boolean;
  /** Reabrir o painel de tarefas do cronograma 4D. */
  onRevealSchedule?: () => void;
}

export interface ModuleNavApi {
  getWorkspace: () => WorkspaceId;
  setWorkspace: (id: WorkspaceId, opts?: { silent?: boolean }) => void;
  refreshInspectorToggle: () => void;
  setCollapsed: (collapsed: boolean) => void;
  isCollapsed: () => boolean;
}

export function initModuleNav(opts: ModuleNavOptions): ModuleNavApi {
  const root = document.getElementById("module-nav");
  if (!root) {
    return {
      getWorkspace: () => DEFAULT_WORKSPACE,
      setWorkspace: () => {},
      refreshInspectorToggle: () => {},
      setCollapsed: () => {},
      isCollapsed: () => false,
    };
  }

  const collapsedStored = readFlag(LS_NAV, false);
  const groupsOpen = readGroups();
  let workspace = readWorkspace();

  const render = () => {
    const collapsed = root.classList.contains("is-collapsed");
    root.innerHTML = `
      <div class="module-nav-top">
        <span class="module-nav-kicker">Módulos</span>
        <button type="button" class="module-nav-collapse" id="module-nav-collapse" title="${collapsed ? "Expandir menu" : "Recolher menu"}" aria-label="${collapsed ? "Expandir menu" : "Recolher menu"}">
          ${collapsed ? ICONS.expand : ICONS.collapse}
        </button>
      </div>
      <div class="module-nav-scroll"></div>
      <div class="module-nav-footer">
        <button type="button" class="module-footer-btn" id="toggle-inspector" title="Propriedades (I)" data-tooltip="Propriedades" aria-pressed="false" aria-controls="inspector">
          ${ICONS.inspector}
          <span>Propriedades</span>
        </button>
      </div>
    `;

    const scroll = root.querySelector(".module-nav-scroll")!;
    for (const mod of APP_MODULES) {
      const open = groupsOpen[mod.id] !== false;
      const current = mod.tools.some((t) => t.workspace === workspace);
      const section = document.createElement("section");
      section.className = `module-group${open ? " is-open" : ""}${current ? " is-current" : ""}`;
      section.dataset.module = mod.id;
      section.innerHTML = `
        <button type="button" class="module-group-btn" aria-expanded="${open}" title="${escapeAttr(mod.label)}" data-tooltip="${escapeAttr(mod.label)}">
          <span class="module-icon">${ICONS[mod.icon] ?? ""}</span>
          <span class="module-group-copy">
            <span class="module-group-label">${escapeHtml(mod.label)}</span>
          </span>
          <span class="module-chevron" aria-hidden="true">${ICONS.expand}</span>
        </button>
        <div class="module-tools" role="list" ${open || collapsed ? "" : "hidden"}></div>
      `;
      const toolsEl = section.querySelector(".module-tools")!;
      for (const tool of mod.tools) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `module-tool${tool.workspace === workspace ? " is-active" : ""}`;
        btn.dataset.tool = tool.id;
        btn.setAttribute("role", "listitem");
        if (tool.workspace === workspace) btn.setAttribute("aria-current", "page");
        btn.title = tool.label;
        btn.setAttribute("data-tooltip", tool.label);
        btn.setAttribute("aria-label", tool.label);
        btn.innerHTML = `
          <span class="module-icon">${ICONS[tool.icon] ?? ""}</span>
          <span class="module-tool-copy">
            <span class="module-tool-name">${escapeHtml(tool.label)}</span>
          </span>
        `;
        toolsEl.appendChild(btn);
      }
      scroll.appendChild(section);
    }

    root.querySelector("#module-nav-collapse")?.addEventListener("click", () => {
      const next = !root.classList.contains("is-collapsed");
      setCollapsed(next);
      render();
      refreshInspectorToggle();
    });

    root.querySelectorAll(".module-group-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (root.classList.contains("is-collapsed")) {
          setCollapsed(false);
          render();
          refreshInspectorToggle();
          return;
        }
        const section = btn.closest(".module-group");
        const id = section?.getAttribute("data-module");
        if (!section || !id) return;
        const next = !section.classList.contains("is-open");
        groupsOpen[id] = next;
        writeGroups(groupsOpen);
        section.classList.toggle("is-open", next);
        btn.setAttribute("aria-expanded", next ? "true" : "false");
        const tools = section.querySelector(".module-tools") as HTMLElement | null;
        if (tools) tools.hidden = !next;
      });
    });

    root.querySelectorAll<HTMLButtonElement>(".module-tool").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tool = findTool(btn.dataset.tool || "");
        if (!tool) return;
        if (tool.workspace === workspace && tool.workspace === "schedule-4d") {
          opts.onRevealSchedule?.();
        }
        setWorkspace(tool.workspace);
      });
    });

    const insp = root.querySelector("#toggle-inspector");
    insp?.addEventListener("click", () => opts.onToggleInspector());
    refreshInspectorToggle();
  };

  const setCollapsed = (collapsed: boolean) => {
    root.classList.toggle("is-collapsed", collapsed);
    const drawer = document.documentElement.dataset.layout === "compact";
    document.documentElement.style.setProperty("--nav-w", drawer ? "0px" : collapsed ? "52px" : "232px");
    writeFlag(LS_NAV, collapsed);
  };

  const applyWorkspaceAttr = () => {
    document.querySelector(".body-grid")?.setAttribute("data-workspace", workspace);
  };

  const setWorkspace = (id: WorkspaceId, extra?: { silent?: boolean }) => {
    const prev = workspace;
    workspace = id;
    writeWorkspace(id);
    applyWorkspaceAttr();
    root.querySelectorAll<HTMLButtonElement>(".module-tool").forEach((btn) => {
      const tool = findTool(btn.dataset.tool || "");
      const on = tool?.workspace === id;
      btn.classList.toggle("is-active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    root.querySelectorAll<HTMLElement>(".module-group").forEach((section) => {
      const tools = APP_MODULES.find((m) => m.id === section.dataset.module)?.tools ?? [];
      section.classList.toggle(
        "is-current",
        tools.some((t) => t.workspace === id),
      );
    });
    if (!extra?.silent && prev !== id) opts.onWorkspaceChange(id);
  };

  const refreshInspectorToggle = () => {
    const btn = root.querySelector("#toggle-inspector");
    const open = opts.inspectorOpen();
    btn?.classList.toggle("is-active", open);
    btn?.setAttribute("aria-pressed", open ? "true" : "false");
  };

  setCollapsed(collapsedStored);
  applyWorkspaceAttr();
  render();

  return {
    getWorkspace: () => workspace,
    setWorkspace,
    refreshInspectorToggle,
    setCollapsed: (collapsed) => {
      setCollapsed(collapsed);
      render();
      refreshInspectorToggle();
    },
    isCollapsed: () => root.classList.contains("is-collapsed"),
  };
}

function readWorkspace(): WorkspaceId {
  try {
    const v = localStorage.getItem(LS_WORKSPACE);
    if (v === "schedule-4d" || v === "project-plan") return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_WORKSPACE;
}

function writeWorkspace(id: WorkspaceId): void {
  try {
    localStorage.setItem(LS_WORKSPACE, id);
  } catch {
    /* ignore */
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function readGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_GROUPS);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* ignore */
  }
  return { planning: true };
}

function writeGroups(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(LS_GROUPS, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
