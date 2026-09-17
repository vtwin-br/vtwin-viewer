import type { NavIconId } from "../app/catalog";

const SVG: Record<NavIconId, string> = {
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="4" rx="1.5"/><rect x="13" y="10" width="7" height="10" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/></svg>`,
  viewer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 16.5V8.2L12 4l8 4.2v8.3L12 21z" stroke-linejoin="round"/><path d="M4 8.2L12 12.5 20 8.2M12 12.5V21" opacity="0.55" stroke-linejoin="round"/></svg>`,
  docs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 4.5h7l4 4V19.5a2 2 0 01-2 2H7a2 2 0 01-2-2v-13a2 2 0 012-2z" stroke-linejoin="round"/><path d="M14 4.5V9h4M8 13h8M8 17h5" stroke-linecap="round"/></svg>`,
  planning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="5" width="14" height="16" rx="2"/><path d="M8 4v3M16 4v3M8 11h8M8 15h5" stroke-linecap="round"/></svg>`,
  schedule4d: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 16.5V8.2L12 4l8 4.2v8.3L12 21z" stroke-linejoin="round"/><path d="M4 8.2L12 12.5 20 8.2M12 12.5V21" opacity="0.55" stroke-linejoin="round"/></svg>`,
  projectPlan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h13" stroke-linecap="round"/><path d="M14 10h6v4h-6z" opacity="0.7"/></svg>`,
  logistics: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 16V8.5h11V16M14 11h4.2L21 14.2V16h-7" stroke-linejoin="round"/><circle cx="7" cy="16.5" r="1.7"/><circle cx="17.5" cy="16.5" r="1.7"/><path d="M3 11h11" stroke-linecap="round"/></svg>`,
  coordination: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="8" cy="8" r="2.4"/><circle cx="16" cy="8" r="2.4"/><circle cx="12" cy="16.5" r="2.4"/><path d="M9.8 9.6l1.4 4.2M14.2 9.6l-1.4 4.2" stroke-linecap="round"/></svg>`,
  editor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 16.5V8.2L12 4l8 4.2v8.3L12 21z" stroke-linejoin="round"/><path d="M9.2 14.8l6.2-6.2 1.8 1.8-6.2 6.2H9.2v-1.8z" stroke-linejoin="round"/></svg>`,
  collapse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

export function navIcon(id: string): string {
  return SVG[id as NavIconId] ?? "";
}
