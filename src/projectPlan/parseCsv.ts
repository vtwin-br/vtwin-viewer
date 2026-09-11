import { addDays, diffDays, parseDurationDays, parseFlexibleDate } from "./dates";
import { finalizePlan, uid } from "./buildPlan";
import type { PlanPredecessor, PlanTask, PredType, ProjectPlan } from "./types";

export interface ColMap {
  name?: number;
  start?: number;
  end?: number;
  duration?: number;
  outline?: number;
  wbs?: number;
  progress?: number;
  pred?: number;
  milestone?: number;
}

export type CsvField = keyof ColMap;

export const CSV_FIELDS: Array<{ key: CsvField; label: string; required?: boolean; hint: string }> = [
  { key: "name", label: "Nome / descrição", required: true, hint: "Texto da tarefa (não o número do item)" },
  { key: "wbs", label: "Item / WBS / código", hint: "Número hierárquico, ex. 1.2.3" },
  { key: "start", label: "Data de início", hint: "Início agendado" },
  { key: "end", label: "Data de término", hint: "Fim agendado" },
  { key: "duration", label: "Duração", hint: "Dias, ou texto tipo 5d" },
  { key: "outline", label: "Nível da hierarquia", hint: "1 = raiz, 2 = filho…" },
  { key: "pred", label: "Predecessores", hint: "IDs tipo 12FS+1" },
  { key: "progress", label: "Progresso %", hint: "0–100" },
  { key: "milestone", label: "Marco", hint: "Sim/Não ou 0/1" },
];

export interface CsvInspection {
  fileName: string;
  text: string;
  delimiter: string;
  headers: string[];
  /** Todas as linhas já separadas (inclui cabeçalho se existir). */
  rows: string[][];
  hasHeader: boolean;
  guessed: ColMap;
  preview: string[][];
  dataRowCount: number;
}

const HEADER = {
  name: /(descri[cç][aã]o|^name$|^nome$|tarefa|atividade|activity\s*name|task\s*name|discriminante|servi[cç]o)/i,
  start: /(in[ií]cio|\bstart\b|begin|scheduled?\s*start)/i,
  end: /(t[ée]rmino|\bfim\b|\bfinish\b|\bend\b|scheduled?\s*finish)/i,
  duration: /(duration|dura[cç][aã]o|^dur\.?$|orig(inal)?\s*duration)/i,
  outline: /(outline\s*level|^n[ií]vel$|^level$|outlinelevel)/i,
  wbs: /^(item|ítem|wbs|edt|estrutura|outline\s*number|c[oó]d(igo|igo)?|id|n[ºo°.]|nr|#)(\b|$)/i,
  progress: /(%|percent|progresso|conclu[ií]d|complete)/i,
  pred: /(predecessor|sucessor)/i,
  milestone: /(milestone|marco)/i,
};

export function inspectCsv(text: string, fileName: string): CsvInspection {
  const raw = stripBom(text);
  const rows = parseCsvRows(raw).filter((r) => r.some((c) => c.trim()));
  if (rows.length === 0) throw new Error("O CSV está vazio.");
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const headerRow = rows[0].map((c) => c.trim());
  const hasHeader = looksLikeHeader(headerRow);
  const headers = hasHeader
    ? headerRow.map((h, i) => h || `Coluna ${i + 1}`)
    : headerRow.map((_, i) => `Coluna ${i + 1}`);
  const data = hasHeader ? rows.slice(1) : rows;
  const guessed = guessColumns(headers, data, hasHeader);
  return {
    fileName,
    text,
    delimiter,
    headers,
    rows,
    hasHeader,
    guessed,
    preview: data.slice(0, 8),
    dataRowCount: data.length,
  };
}

export function reinspect(insp: CsvInspection, hasHeader: boolean): CsvInspection {
  const headerRow = insp.rows[0]?.map((c) => c.trim()) ?? [];
  const headers = hasHeader
    ? headerRow.map((h, i) => h || `Coluna ${i + 1}`)
    : headerRow.map((_, i) => `Coluna ${i + 1}`);
  const data = hasHeader ? insp.rows.slice(1) : insp.rows;
  return {
    ...insp,
    hasHeader,
    headers,
    guessed: guessColumns(headers, data, hasHeader),
    preview: data.slice(0, 8),
    dataRowCount: data.length,
  };
}

export function parseCsv(text: string, fileName: string): ProjectPlan {
  const insp = inspectCsv(text, fileName);
  return planFromMappedCsv(insp, insp.guessed);
}

export function planFromMappedCsv(insp: CsvInspection, map: ColMap): ProjectPlan {
  if (map.name == null) {
    throw new Error("Indique qual coluna é o nome (descrição) da tarefa.");
  }
  const data = insp.hasHeader ? insp.rows.slice(1) : insp.rows;
  const tasks: PlanTask[] = [];
  for (const row of data) {
    if (row.every((c) => !c.trim())) continue;
    const name = cell(row, map.name) || "Tarefa";
    const start = parseFlexibleDate(cell(row, map.start));
    const end = parseFlexibleDate(cell(row, map.end));
    const duration = parseDurationDays(cell(row, map.duration));
    const wbs = cell(row, map.wbs) || undefined;
    let outline = Number.parseInt(cell(row, map.outline), 10);
    if (!Number.isFinite(outline) || outline < 1) {
      outline = wbs ? Math.max(1, wbs.split(".").filter(Boolean).length) : 1;
    }
    const progressRaw = cell(row, map.progress).replace("%", "").replace(",", ".");
    const progress = Number.parseFloat(progressRaw);
    const milestoneRaw = cell(row, map.milestone).toLowerCase();
    const isMilestone = /^(1|s|sim|true|yes|x)$/.test(milestoneRaw) || duration === 0;

    const task: PlanTask = {
      id: uid(),
      name,
      outlineLevel: outline,
      wbs,
      start,
      end,
      durationDays: duration,
      progress: Number.isFinite(progress) ? clamp(progress, 0, 100) : 0,
      isMilestone,
      isSummary: false,
      collapsed: false,
      predecessors: parsePreds(cell(row, map.pred)),
      linkedProductGuids: [],
    };
    if (!task.end && task.start && task.durationDays != null) {
      task.end = addDays(task.start, task.isMilestone ? 0 : task.durationDays);
    }
    if (!task.start && task.end && task.durationDays != null) {
      task.start = addDays(task.end, -(task.durationDays || 0));
    }
    if (task.start && task.end && task.durationDays == null) {
      task.durationDays = Math.max(0, diffDays(task.start, task.end));
    }
    tasks.push(task);
  }

  if (tasks.length === 0) throw new Error("Não encontrei tarefas neste CSV.");

  const name = insp.fileName.replace(/\.(csv|txt)$/i, "") || "Planejamento importado";
  return finalizePlan({
    id: uid("plan"),
    name,
    tasks,
    attachments: [],
    sourceLabel: insp.fileName,
    sourceKind: "import",
  });
}

function guessColumns(headers: string[], sample: string[][], hasHeader: boolean): ColMap {
  const map: ColMap = {};
  if (hasHeader) {
    headers.forEach((h, i) => {
      const v = h.trim();
      if (map.wbs == null && HEADER.wbs.test(v)) map.wbs = i;
      else if (map.name == null && HEADER.name.test(v)) map.name = i;
      else if (map.start == null && HEADER.start.test(v)) map.start = i;
      else if (map.end == null && HEADER.end.test(v)) map.end = i;
      else if (map.duration == null && HEADER.duration.test(v)) map.duration = i;
      else if (map.outline == null && HEADER.outline.test(v)) map.outline = i;
      else if (map.progress == null && HEADER.progress.test(v)) map.progress = i;
      else if (map.pred == null && HEADER.pred.test(v)) map.pred = i;
      else if (map.milestone == null && HEADER.milestone.test(v)) map.milestone = i;
    });
  }
  if (map.name == null) map.name = pickNameColumn(sample, map);
  return map;
}

function pickNameColumn(sample: string[][], taken: ColMap): number | undefined {
  const used = new Set(Object.values(taken).filter((n): n is number => n != null));
  const width = sample.reduce((m, r) => Math.max(m, r.length), 0);
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < width; i++) {
    if (used.has(i)) continue;
    let textLen = 0;
    let n = 0;
    let wbsish = 0;
    let dateish = 0;
    for (const row of sample.slice(0, 20)) {
      const v = (row[i] ?? "").trim();
      if (!v) continue;
      n += 1;
      textLen += v.length;
      if (looksLikeWbs(v)) wbsish += 1;
      if (parseFlexibleDate(v)) dateish += 1;
    }
    if (!n) continue;
    if (wbsish / n > 0.7 || dateish / n > 0.6) continue;
    const score = textLen / n;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best >= 0 ? best : undefined;
}

function looksLikeWbs(s: string): boolean {
  return /^\d+([.\-/]\d+)*[A-Za-z]?$/.test(s.trim());
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function looksLikeHeader(header: string[]): boolean {
  return header.some((h) => Object.values(HEADER).some((re) => re.test(h.trim())));
}

function cell(row: string[], index?: number): string {
  if (index == null || index < 0) return "";
  return (row[index] ?? "").trim();
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function parsePreds(raw: string): PlanPredecessor[] {
  if (!raw) return [];
  const out: PlanPredecessor[] = [];
  for (const part of raw.split(/[;,]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]?\d+)?/i.exec(p);
    if (!m) continue;
    out.push({
      id: m[1],
      type: (m[2] || "FS").toUpperCase() as PredType,
      lagDays: m[3] ? Number(m[3]) : undefined,
    });
  }
  return out;
}

export function parseCsvRows(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = detectDelimiter(first);
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delim) {
      row.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\n") {
      if (cur.endsWith("\r")) cur = cur.slice(0, -1);
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(line: string): string {
  const counts: Array<[string, number]> = [
    [";", (line.match(/;/g) || []).length],
    ["\t", (line.match(/\t/g) || []).length],
    [",", (line.match(/,/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
}

export function sampleCell(insp: CsvInspection, col: number): string {
  for (const row of insp.preview) {
    const v = (row[col] ?? "").trim();
    if (v) return v.length > 42 ? `${v.slice(0, 40)}…` : v;
  }
  return "";
}
