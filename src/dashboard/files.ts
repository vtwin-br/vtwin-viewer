import { strToU8, zipSync } from "fflate";

export interface DashFile {
  name: string;
  mime: string;
  content: string;
}

export function parseFileFences(text: string): { rest: string; files: DashFile[] } {
  const files: DashFile[] = [];
  const rest = text.replace(/```file(?:\s+name="([^"]+)"|\s*:[\t ]*(\S+))?[^\n]*\n([\s\S]*?)```/gi, (_m, named, colon, body) => {
    const name = String(named || colon || `anexo-${files.length + 1}.txt`).trim();
    files.push(normalizeFile({ name, mime: mimeOf(name), content: String(body ?? "").replace(/\n$/, "") }));
    return "";
  }).trim();
  return { rest, files };
}

export function filesFromUnknown(raw: unknown): DashFile[] {
  if (!Array.isArray(raw)) return [];
  const out: DashFile[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { name?: unknown; mime?: unknown; content?: unknown; text?: unknown };
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const content = typeof rec.content === "string" ? rec.content : typeof rec.text === "string" ? rec.text : "";
    if (!name || !content) continue;
    out.push(
      normalizeFile({
        name,
        mime: typeof rec.mime === "string" ? rec.mime : mimeOf(name),
        content,
      }),
    );
  }
  return out;
}

export function downloadDashFile(file: DashFile): void {
  const ready = prepareDownload(file);
  const blob = new Blob([toArrayBuffer(ready.bytes)], { type: ready.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = ready.name;
  a.click();
  URL.revokeObjectURL(url);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizeFile(file: DashFile): DashFile {
  const name = file.name.replace(/[\\/]+/g, "-").slice(0, 80) || "anexo.txt";
  return { name, mime: file.mime || mimeOf(name), content: file.content };
}

function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "csv") return "text/csv";
  if (ext === "json") return "application/json";
  if (ext === "txt" || ext === "md") return "text/plain";
  if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "xml") return "application/xml";
  return "text/plain";
}

function prepareDownload(file: DashFile): { name: string; mime: string; bytes: Uint8Array } {
  const wantsXlsx = /\.xlsx$/i.test(file.name) || /spreadsheetml|excel/i.test(file.mime);
  if (wantsXlsx) {
    const name = file.name.replace(/\.(csv|txt|json)$/i, "") + (/\.xlsx$/i.test(file.name) ? "" : ".xlsx");
    return {
      name: name.endsWith(".xlsx") ? name : `${name}.xlsx`,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: csvToXlsx(file.content),
    };
  }
  if (/\.csv$/i.test(file.name) || file.mime === "text/csv") {
    const bom = "\uFEFF";
    return { name: file.name, mime: "text/csv;charset=utf-8", bytes: strToU8(bom + file.content) };
  }
  return { name: file.name, mime: file.mime || "text/plain", bytes: strToU8(file.content) };
}

function csvToXlsx(raw: string): Uint8Array {
  const rows = parseCsv(raw);
  const sheet = worksheetXml(rows.length ? rows : [[raw]]);
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `</Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
  return zipSync(files);
}

function worksheetXml(rows: string[][]): string {
  const body = rows
    .slice(0, 4000)
    .map((row, i) => {
      const cells = row.slice(0, 40).map((value, j) => {
        const ref = `${colName(j)}${i + 1}`;
        const text = escapeXml(value ?? "");
        const num = Number(text.replace(/\s/g, "").replace(",", "."));
        if (text && Number.isFinite(num) && /^-?\d+([.,]\d+)?$/.test(text.trim())) {
          return `<c r="${ref}"><v>${num}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
      });
      return `<row r="${i + 1}">${cells.join("")}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  );
}

function colName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseCsv(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  if (text.includes("|") && /^\s*\|/m.test(text)) return parseMarkdownTable(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") pushCell();
    else if (ch === "\n") {
      pushCell();
      rows.push(row);
      row = [];
    } else if (ch !== "\r") cell += ch;
  }
  pushCell();
  if (row.some((c) => c.length)) rows.push(row);
  return rows;
}

function parseMarkdownTable(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line.includes("|")) return false;
      const inner = line.replace(/\|/g, "").trim();
      return !/^:?-{3,}:?(\s+:?-{3,}:?)*$/.test(inner);
    })
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    )
    .filter((row) => row.some((c) => c.length));
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}
