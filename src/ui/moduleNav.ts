import {
  APP_MODULES,
  DEFAULT_WORKSPACE,
  findTool,
  isWorkspaceId,
  workspaceShell,
  type WorkspaceId,
} from "../app/catalog";
import { navIcon } from "./navIcons";

const LS_WORKSPACE = "vista4d.workspace";
const LS_NAV = "vista4d.navCollapsed";
const LS_GROUPS = "vista4d.navGroups";

export interface ModuleNavOptions {
  onWorkspaceChange: (id: WorkspaceId) => void;
  /** Reabrir o painel de tarefas do cronograma 4D. */
  onRevealSchedule?: () => void;
}

export interface ModuleNavApi {
  getWorkspace: () => WorkspaceId;
  setWorkspace: (id: WorkspaceId, opts?: { silent?: boolean }) => void;
  setCollapsed: (collapsed: boolean) => void;
  isCollapsed: () => boolean;
}

export function initModuleNav(opts: ModuleNavOptions): ModuleNavApi {
  const root = document.getElementById("module-nav");
  if (!root) {
    return {
      getWorkspace: () => DEFAULT_WORKSPACE,
      setWorkspace: () => {},
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
        <div class="brand module-brand" aria-label="vtwin">
          <img class="brand-mark brand-mark-lockup" src="/brand/logo-inverse.svg" width="120" height="22" alt="" />
          <img class="brand-mark brand-mark-symbol" src="/brand/symbol-inverse.svg" width="28" height="21" alt="" />
        </div>
        <button type="button" class="module-nav-collapse" id="module-nav-collapse" title="${collapsed ? "Expandir" : "Recolher"}" aria-label="${collapsed ? "Expandir" : "Recolher"}">
          ${collapsed ? navIcon("expand") : navIcon("collapse")}
        </button>
      </div>
      <div class="module-nav-scroll"></div>
    `;

    const scroll = root.querySelector(".module-nav-scroll")!;
    for (const mod of APP_MODULES) {
      if (mod.tools.length === 1) {
        const tool = mod.tools[0];
        const on = tool.workspace === workspace;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `module-leaf${on ? " is-active" : ""}`;
        btn.dataset.tool = tool.id;
        if (on) btn.setAttribute("aria-current", "page");
        btn.title = mod.label;
        btn.setAttribute("data-tooltip", escapeAttr(mod.label));
        btn.setAttribute("aria-label", mod.label);
        btn.innerHTML = `
          <span class="module-icon">${navIcon(mod.icon)}</span>
          <span class="module-leaf-copy">
            <span class="module-leaf-name">${escapeHtml(mod.label)}</span>
          </span>
        `;
        scroll.appendChild(btn);
        continue;
      }

      const open = groupsOpen[mod.id] !== false;
      const current = mod.tools.some((t) => t.workspace === workspace);
      const section = document.createElement("section");
      section.className = `module-group${open ? " is-open" : ""}${current ? " is-current" : ""}`;
      section.dataset.module = mod.id;
      section.innerHTML = `
        <button type="button" class="module-group-btn" aria-expanded="${open}" title="${escapeAttr(mod.label)}" data-tooltip="${escapeAttr(mod.label)}">
          <span class="module-icon">${navIcon(mod.icon)}</span>
          <span class="module-group-copy">
            <span class="module-group-label">${escapeHtml(mod.label)}</span>
          </span>
          <span class="module-chevron" aria-hidden="true">${navIcon("expand")}</span>
        </button>
        <div class="module-tools" role="list" ${open ? "" : "hidden"}></div>
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
          <span class="module-icon">${navIcon(tool.icon)}</span>
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
    });

    root.querySelectorAll(".module-group-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
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

    root.querySelectorAll<HTMLButtonElement>(".module-tool, .module-leaf").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tool = findTool(btn.dataset.tool || "");
        if (!tool) return;
        if (tool.workspace === workspace && tool.workspace === "schedule-4d") {
          opts.onRevealSchedule?.();
        }
        setWorkspace(tool.workspace);
      });
    });
  };

  const setCollapsed = (collapsed: boolean) => {
    root.classList.toggle("is-collapsed", collapsed);
    const drawer = document.documentElement.dataset.layout === "compact";
    document.documentElement.style.setProperty("--nav-w", drawer ? "0px" : collapsed ? "52px" : "232px");
    writeFlag(LS_NAV, collapsed);
  };

  const applyWorkspaceAttr = () => {
    const grid = document.querySelector(".body-grid");
    const app = document.getElementById("app");
    const shell = workspaceShell(workspace);
    grid?.setAttribute("data-workspace", workspace);
    grid?.setAttribute("data-shell", shell);
    app?.setAttribute("data-workspace", workspace);
    app?.setAttribute("data-shell", shell);
  };

  const setWorkspace = (id: WorkspaceId, extra?: { silent?: boolean }) => {
    const prev = workspace;
    workspace = id;
    writeWorkspace(id);
    applyWorkspaceAttr();
    root.querySelectorAll<HTMLButtonElement>(".module-tool, .module-leaf").forEach((btn) => {
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

  setCollapsed(collapsedStored);
  applyWorkspaceAttr();
  render();

  return {
    getWorkspace: () => workspace,
    setWorkspace,
    setCollapsed: (collapsed) => {
      setCollapsed(collapsed);
      render();
    },
    isCollapsed: () => root.classList.contains("is-collapsed"),
  };
}

function readWorkspace(): WorkspaceId {
  try {
    const v = localStorage.getItem(LS_WORKSPACE);
    if (isWorkspaceId(v)) return v;
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
