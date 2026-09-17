import {
  findModuleByWorkspace,
  findToolByWorkspace,
  workspaceShell,
  type WorkspaceId,
} from "../app/catalog";
import { navIcon } from "./navIcons";

export function renderModulePlaceholder(id: WorkspaceId): void {
  const root = document.getElementById("module-placeholder");
  if (!root) return;

  if (workspaceShell(id) !== "placeholder") {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }

  const tool = findToolByWorkspace(id);
  const mod = findModuleByWorkspace(id);
  const title = tool?.label ?? "Módulo";
  const description = tool?.description ?? "";
  const kicker = mod && mod.tools.length > 1 ? mod.label : "";

  root.hidden = false;
  root.innerHTML = `
    <div class="module-placeholder-card">
      <span class="module-placeholder-icon">${navIcon(tool?.icon ?? "dashboard")}</span>
      ${kicker ? `<p class="module-placeholder-kicker">${escapeHtml(kicker)}</p>` : ""}
      <h2>${escapeHtml(title)}</h2>
      <p class="sr-only">${escapeHtml(description)}</p>
      <span class="module-placeholder-badge">Em breve</span>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
