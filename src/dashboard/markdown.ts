export function formatChatMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i]!)) {
      const start = i;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        const line = lines[i]!;
        if (!isSeparatorRow(line)) rows.push(splitRow(line));
        i += 1;
      }
      if (rows.length >= 2 || (rows.length === 1 && i - start >= 2)) {
        out.push(renderTable(rows));
        continue;
      }
      i = start;
    }
    out.push(formatInlineBlock(lines[i]!));
    i += 1;
  }
  return out.join("").replace(/(<br>)+$/g, "");
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  if (/^\|?\s*:?-{3,}/.test(t) && t.replace(/[\s|:/-]/g, "") === "") return true;
  return splitRow(t).length >= 2;
}

function isSeparatorRow(line: string): boolean {
  const inner = line.replace(/\|/g, "").trim();
  return /^:?-{3,}:?(\s+:?-{3,}:?)*$/.test(inner);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function renderTable(rows: string[][]): string {
  if (!rows.length) return "";
  const head = rows[0]!;
  const body = rows.slice(1);
  const th = head.map((c) => `<th>${formatInline(c)}</th>`).join("");
  const tr = body
    .map((row) => `<tr>${head.map((_, j) => `<td>${formatInline(row[j] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="dash-md-table-wrap"><table class="dash-md-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

function formatInlineBlock(line: string): string {
  const t = line.trim();
  if (!t) return "<br>";
  if (/^#{1,6}\s+/.test(t)) return `<p class="dash-md-h">${formatInline(t.replace(/^#{1,6}\s+/, ""))}</p>`;
  if (/^[-*]\s+/.test(t)) return `<p class="dash-md-li">• ${formatInline(t.replace(/^[-*]\s+/, ""))}</p>`;
  return `${formatInline(t)}<br>`;
}

function formatInline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
