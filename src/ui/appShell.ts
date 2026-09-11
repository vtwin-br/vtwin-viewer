/**
 * Comportamento responsivo do shell: drawers, scrim e prioridade da área central.
 * Não altera a lógica dos workspaces — só o encaixe visual.
 */

export type LayoutId = "wide" | "medium" | "narrow" | "compact";

export interface AppShellOptions {
  grid: HTMLElement;
  nav: HTMLElement;
  inspectorOpen: () => boolean;
  scheduleOpen: () => boolean;
  setInspectorOpen: (open: boolean) => void;
  setScheduleOpen: (open: boolean) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  isNavCollapsed: () => boolean;
  constrainPanels?: () => void;
}

export interface AppShellApi {
  layout: () => LayoutId;
  closeOverlays: () => void;
  toggleNavDrawer: () => void;
  closeNavDrawer: () => void;
  refresh: () => void;
}

const MQ_MEDIUM = "(max-width: 1439px)";
const MQ_NARROW = "(max-width: 1279px)";
const MQ_COMPACT = "(max-width: 1099px)";

export function initAppShell(opts: AppShellOptions): AppShellApi {
  const root = document.documentElement;
  const scrim = document.getElementById("shell-scrim");
  const menuBtn = document.getElementById("btn-nav-menu");
  let layout: LayoutId = "wide";
  let drawerOpen = false;

  const readLayout = (): LayoutId => {
    if (window.matchMedia(MQ_COMPACT).matches) return "compact";
    if (window.matchMedia(MQ_NARROW).matches) return "narrow";
    if (window.matchMedia(MQ_MEDIUM).matches) return "medium";
    return "wide";
  };

  const apply = () => {
    layout = readLayout();
    root.dataset.layout = layout;

    if (layout === "compact") {
      document.documentElement.style.setProperty("--nav-w", "0px");
      if (!drawerOpen) opts.nav.classList.remove("is-drawer-open");
    } else {
      opts.nav.classList.remove("is-drawer-open");
      drawerOpen = false;
      document.documentElement.style.setProperty(
        "--nav-w",
        opts.isNavCollapsed() ? "52px" : "232px",
      );
    }

    refreshScrim();
    opts.constrainPanels?.();
  };

  const refreshScrim = () => {
    const overlayNav = layout === "compact" && drawerOpen;
    const overlaySchedule = (layout === "compact" || layout === "narrow") && opts.scheduleOpen();
    const overlayInspector =
      (layout === "compact" || layout === "narrow" || layout === "medium") && opts.inspectorOpen();
    const show =
      overlayNav ||
      (layout === "compact" && (overlaySchedule || overlayInspector)) ||
      (layout === "narrow" && (overlaySchedule || overlayInspector));
    if (scrim) {
      scrim.hidden = !show;
      scrim.classList.toggle("is-visible", show);
    }
    menuBtn?.setAttribute("aria-expanded", overlayNav ? "true" : "false");
    opts.nav.classList.toggle("is-drawer-open", overlayNav);
  };

  const closeOverlays = () => {
    if (layout === "compact" || layout === "narrow") {
      if (opts.scheduleOpen()) opts.setScheduleOpen(false);
      if (opts.inspectorOpen()) opts.setInspectorOpen(false);
    }
    if (layout === "medium" && opts.inspectorOpen() && window.matchMedia(MQ_NARROW).matches) {
      opts.setInspectorOpen(false);
    }
    drawerOpen = false;
    opts.nav.classList.remove("is-drawer-open");
    refreshScrim();
  };

  const toggleNavDrawer = () => {
    if (layout !== "compact") {
      opts.setNavCollapsed(!opts.isNavCollapsed());
      apply();
      return;
    }
    drawerOpen = !drawerOpen;
    refreshScrim();
  };

  menuBtn?.addEventListener("click", () => toggleNavDrawer());
  scrim?.addEventListener("click", () => closeOverlays());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOverlays();
  });
  window.addEventListener("resize", () => {
    const next = readLayout();
    if (next !== layout) drawerOpen = false;
    apply();
  });

  apply();

  return {
    layout: () => layout,
    closeOverlays,
    toggleNavDrawer,
    refresh: () => {
      apply();
    },
    closeNavDrawer: () => {
      drawerOpen = false;
      refreshScrim();
    },
  };
}

export function currentLayout(): LayoutId {
  const v = document.documentElement.dataset.layout;
  if (v === "medium" || v === "narrow" || v === "compact") return v;
  return "wide";
}
