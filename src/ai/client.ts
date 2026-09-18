export interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
}

export interface AiChatInput {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  json?: boolean;
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

export async function aiChat(input: AiChatInput): Promise<string> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: input.messages,
      temperature: input.temperature ?? 0,
      json: Boolean(input.json),
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const json = (await res.json()) as { content?: string };
  const content = json.content?.trim() ?? "";
  if (!content) throw new Error("A IA não devolveu conteúdo utilizável.");
  return content;
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

export async function aiChatJson<T>(input: AiChatInput): Promise<T> {
  return parseJsonContent<T>(await aiChat({ ...input, json: true }));
}
