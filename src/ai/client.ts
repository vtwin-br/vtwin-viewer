export interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
}

export type AiThinking = "low" | "medium" | "high";

export type AiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string | AiContentPart[];
}

export interface AiStreamEvent {
  thinking?: string;
  content?: string;
}

export interface AiChatInput {
  messages: AiChatMessage[];
  temperature?: number;
  json?: boolean;
  stream?: boolean;
  thinking?: AiThinking;
  signal?: AbortSignal;
  onEvent?: (event: AiStreamEvent) => void;
}

export interface AiChatResult {
  content: string;
  thinking: string;
}

const LEGACY_LS = "vtwin.linkAssist.openai";

function forgetLegacyBrowserKey(): void {
  try {
    localStorage.removeItem(LEGACY_LS);
  } catch {
    /* ignore */
  }
}

export async function fetchAiStatus(): Promise<AiStatus> {
  forgetLegacyBrowserKey();
  try {
    const res = await fetch("/api/ai/status");
    if (!res.ok) return { configured: false, provider: "", model: "" };
    const json = (await res.json()) as Partial<AiStatus>;
    return {
      configured: Boolean(json.configured),
      provider: typeof json.provider === "string" ? json.provider : "",
      model: typeof json.model === "string" ? json.model : "",
    };
  } catch {
    return { configured: false, provider: "", model: "" };
  }
}

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (json?.error) return json.error;
  return `IA recusou o pedido (${res.status})`;
}

export async function aiChat(input: AiChatInput): Promise<AiChatResult> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: input.stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify({
      messages: input.messages,
      temperature: input.temperature ?? 0,
      json: Boolean(input.json),
      stream: Boolean(input.stream && !input.json),
      thinking: input.thinking ?? "low",
    }),
    signal: input.signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  const ctype = res.headers.get("content-type") ?? "";
  if (input.stream && !input.json && ctype.includes("text/event-stream") && res.body) {
    return readSse(res.body, input.onEvent);
  }
  const json = (await res.json()) as { content?: string; thinking?: string };
  const content = json.content?.trim() ?? "";
  const thinking = json.thinking?.trim() ?? "";
  if (!content) throw new Error("A IA não devolveu conteúdo utilizável.");
  if (thinking) input.onEvent?.({ thinking });
  if (content) input.onEvent?.({ content });
  return { content, thinking };
}

async function readSse(body: ReadableStream<Uint8Array>, onEvent?: (event: AiStreamEvent) => void): Promise<AiChatResult> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let thinking = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json: { thinking?: string; content?: string; error?: string };
      try {
        json = JSON.parse(data) as { thinking?: string; content?: string; error?: string };
      } catch {
        continue;
      }
      if (json.error) throw new Error(json.error);
      if (typeof json.thinking === "string" && json.thinking) {
        thinking += json.thinking;
        onEvent?.({ thinking });
      }
      if (typeof json.content === "string" && json.content) {
        content += json.content;
        onEvent?.({ content });
      }
    }
  }
  if (!content.trim()) throw new Error("A IA não devolveu conteúdo utilizável.");
  return { content, thinking };
}

export function parseJsonContent<T>(content: string): T {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new Error("A IA devolveu um JSON inválido.");
  }
}

export function tryParseJsonContent<T>(content: string): T | null {
  try {
    return parseJsonContent<T>(content);
  } catch {
    return null;
  }
}

export async function aiChatJson<T>(input: AiChatInput): Promise<T> {
  const result = await aiChat({ ...input, json: true, stream: false });
  return parseJsonContent<T>(result.content);
}
