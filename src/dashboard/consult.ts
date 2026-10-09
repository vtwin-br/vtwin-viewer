import { aiChat, tryParseJsonContent, type AiChatMessage, type AiStreamEvent, type AiThinking } from "../ai/client";
import type { BimCatalog } from "../projectPlan/bimCatalog";
import type { ScheduleData } from "../schedule/types";
import { filesFromUnknown, parseFileFences, type DashFile } from "./files";
import { resolvePaintPlan, type DashPaintPlan, type PaintContext } from "./paint";
import type { DashboardSnapshot } from "./snapshot";

export interface DashboardConsultAction {
  isolate: boolean;
  clear: boolean;
  bucketIds: string[];
  taskIds: number[];
  label: string;
}

export interface DashboardConsultReply {
  answer: string;
  thinking: string;
  action: DashboardConsultAction | null;
  paint: DashPaintPlan | null;
  files: DashFile[];
}

export interface ConsultImage {
  name: string;
  dataUrl: string;
}

const SYSTEM = `És o assistente BIM 4D/5D da Vista (vtwin). Consultas o snapshot do projeto aberto.

Regras:
- Responde em português. Tabelas em markdown com | colunas | (cabeçalho + separador + linhas).
- Não inventes números, GUIDs, datas nem bucketId.
- Excel/CSV: preenche files[] (CSV UTF-8). Para .xlsx, content CSV e nome .xlsx.
- Destaques no modelo: usa paint.layers com filtros do snapshot (unlinked, linked, done, active, pending, not_done, undated), bucketIds, taskIds, family (IFCCOLUMN ou "pilares"), storey, color (#rrggbb) e heatmap:"cost" (from verde / to vermelho).
- Sem progresso real medido: done = concluído na data de referência; not_done = ainda não concluído; unlinked = geometria sem vínculo ao cronograma.
- Modelo inteiro: paint.clear=true ou isolate.clear=true.
- Não peças chaves de API.

No FIM, se precisares de destacar geometria ou entregar ficheiros, um bloco JSON:

\`\`\`json
{"paint":{"isolate":true,"label":"Sem vínculo","layers":[{"filter":"unlinked","color":"#c026d3"}]},"files":[]}
\`\`\`

Exemplo RAG 4D: layers done verde e not_done vermelho, isolate false.
Exemplo custo: family IFCCOLUMN + storey + heatmap cost.`;

type ConsultJson = {
  answer?: string;
  isolate?: { clear?: boolean; bucketIds?: unknown; taskIds?: unknown; label?: string };
  paint?: unknown;
  files?: unknown;
};

export async function consultDashboard(input: {
  snapshot: DashboardSnapshot;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
  images?: ConsultImage[];
  thinking?: AiThinking;
  paintCtx: PaintContext;
  signal?: AbortSignal;
  onEvent?: (event: AiStreamEvent) => void;
}): Promise<DashboardConsultReply> {
  const prompt = input.prompt.trim() || (input.images?.length ? "Analisa as imagens anexadas e relaciona com o snapshot do projeto." : "");
  const messages: AiChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `SNAPSHOT JSON:\n${JSON.stringify(input.snapshot)}` },
    ...input.history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content }) as AiChatMessage),
    { role: "user", content: buildUserContent(prompt, input.images) },
  ];
  const raw = await aiChat({
    temperature: 0.2,
    json: false,
    stream: true,
    thinking: input.thinking ?? "low",
    messages,
    signal: input.signal,
    onEvent: input.onEvent,
  });
  const parsed = parseConsultPayload(raw.content, input.paintCtx);
  const answer =
    parsed.answer.trim() ||
    (parsed.files.length
      ? `Preparei ${parsed.files.length === 1 ? "o ficheiro" : `${parsed.files.length} ficheiros`} para download.`
      : "Não consegui interpretar o modelo com este pedido.");
  return {
    answer,
    thinking: raw.thinking,
    action: actionFrom(parsed.isolate),
    paint: parsed.paint,
    files: parsed.files,
  };
}

export function resolveConsultGuids(
  action: DashboardConsultAction,
  catalog: BimCatalog | null,
  schedule: ScheduleData | null,
): string[] {
  if (action.clear) return [];
  const guids = new Set<string>();
  const allowedBuckets = new Map((catalog?.buckets ?? []).map((b) => [b.id, b]));
  for (const id of action.bucketIds) {
    const bucket = allowedBuckets.get(id);
    if (!bucket) continue;
    for (const guid of bucket.guids) guids.add(guid);
  }
  if (schedule) {
    for (const id of action.taskIds) {
      if (!schedule.byId.has(id)) continue;
      for (const guid of schedule.productGuidsByTask.get(id) ?? []) guids.add(guid);
    }
  }
  return [...guids];
}

function buildUserContent(prompt: string, images?: ConsultImage[]): AiChatMessage["content"] {
  if (!images?.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.slice(0, 4).map((img) => ({
      type: "image_url" as const,
      image_url: { url: img.dataUrl },
    })),
  ];
}

function parseConsultPayload(
  raw: string,
  ctx: PaintContext,
): { answer: string; isolate: ConsultJson["isolate"]; paint: DashPaintPlan | null; files: DashFile[] } {
  const fenced = parseFileFences(raw);
  const sidecar = extractSidecar(fenced.rest);
  const files = [...fenced.files, ...filesFromUnknown(sidecar.json?.files)];
  const answer = (typeof sidecar.json?.answer === "string" && sidecar.json.answer.trim()
    ? sidecar.json.answer.trim()
    : sidecar.rest
  ).trim();
  const paint = sidecar.json?.paint ? resolvePaintPlan(sidecar.json.paint, ctx) : null;
  return { answer, isolate: sidecar.json?.isolate, paint, files };
}

function extractSidecar(text: string): { rest: string; json: ConsultJson | null } {
  const block = text.match(/```json\s*([\s\S]*?)```/i);
  if (block) {
    const json = tryParseJsonContent<ConsultJson>(block[1] ?? "");
    const rest = `${text.slice(0, block.index ?? 0)}${text.slice((block.index ?? 0) + block[0].length)}`.trim();
    if (json && isSidecar(json)) return { rest, json };
  }
  const whole = tryParseJsonContent<ConsultJson>(text);
  if (whole && isSidecar(whole)) {
    return { rest: typeof whole.answer === "string" ? whole.answer : "", json: whole };
  }
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const json = tryParseJsonContent<ConsultJson>(text.slice(start, end + 1));
    if (json && isSidecar(json)) return { rest: text.slice(0, start).trim(), json };
  }
  return { rest: text.trim(), json: null };
}

function isSidecar(json: ConsultJson): boolean {
  return Boolean(json.answer || json.isolate || json.files || json.paint);
}

function actionFrom(raw: ConsultJson["isolate"]): DashboardConsultAction | null {
  if (!raw) return null;
  const bucketIds = asStringList(raw.bucketIds);
  const taskIds = asNumberList(raw.taskIds);
  const clear = Boolean(raw.clear);
  if (!clear && !bucketIds.length && !taskIds.length) return null;
  return {
    isolate: !clear && (bucketIds.length > 0 || taskIds.length > 0),
    clear,
    bucketIds,
    taskIds,
    label: String(raw.label || "").slice(0, 80),
  };
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0))];
}

function asNumberList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return [...new Set(out)];
}
