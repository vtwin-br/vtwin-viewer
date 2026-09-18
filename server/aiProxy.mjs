import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_BODY = 800_000;
const UPSTREAM_MS = 60_000;

const PROVIDERS = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.6-flash",
    fallbacks: ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"],
    keyEnv: ["AI_API_KEY", "GEMINI_API_KEY"],
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    fallbacks: ["llama-3.1-8b-instant"],
    keyEnv: ["AI_API_KEY", "GROQ_API_KEY"],
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    fallbacks: [],
    keyEnv: ["AI_API_KEY", "OPENAI_API_KEY"],
  },
};

/**
 * @param {Record<string, string | undefined>} env
 */
export function resolveAiConfig(env) {
  const providerId = String(env.AI_PROVIDER || "gemini").toLowerCase().trim();
  const provider = PROVIDERS[providerId] ?? PROVIDERS.gemini;
  const id = PROVIDERS[providerId] ? providerId : "gemini";
  let apiKey = "";
  for (const name of provider.keyEnv) {
    const value = env[name]?.trim();
    if (value) {
      apiKey = value;
      break;
    }
  }
  const baseUrl = (env.AI_BASE_URL || provider.baseUrl).replace(/\/+$/, "");
  const model = (env.AI_MODEL || provider.defaultModel).trim();
  return { provider: id, apiKey, baseUrl, model, fallbacks: provider.fallbacks, configured: Boolean(apiKey) };
}

/**
 * @param {string} [cwd]
 */
export function loadDotEnvFiles(cwd = process.cwd()) {
  const fromFiles = {};
  for (const name of [".env", ".env.local"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      fromFiles[key] = value;
    }
  }
  return { ...fromFiles, ...process.env };
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

/**
 * @param {import("node:http").IncomingMessage} req
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error("Pedido demasiado grande.");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("JSON inválido.");
    err.statusCode = 400;
    throw err;
  }
}

function isMessage(row) {
  return (
    row &&
    typeof row === "object" &&
    (row.role === "system" || row.role === "user" || row.role === "assistant") &&
    typeof row.content === "string"
  );
}

function shouldFallback(status, text) {
  if (status === 503 || status === 429) return true;
  if (status !== 404) return false;
  return /no longer available|not found|not supported|does not exist/i.test(text);
}

function compactUpstreamError(text) {
  try {
    const parsed = JSON.parse(text);
    const msg = parsed?.error?.message || parsed?.[0]?.error?.message;
    if (typeof msg === "string" && msg.trim()) return msg.replace(/\s+/g, " ").slice(0, 180);
  } catch {
    /* plain text */
  }
  return text.replace(/\s+/g, " ").slice(0, 180);
}

/**
 * @param {ReturnType<typeof resolveAiConfig>} config
 * @param {{ messages: Array<{ role: string; content: string }>; temperature?: number; json?: boolean }} input
 */
async function completeUpstream(config, input) {
  const models = [...new Set([config.model, ...(config.fallbacks ?? [])])];
  let lastErr = null;
  for (const model of models) {
    const body = {
      model,
      temperature: typeof input.temperature === "number" ? input.temperature : 0,
      messages: input.messages,
    };
    if (input.json) body.response_format = { type: "json_object" };
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`O fornecedor de IA recusou o pedido (${res.status})${text ? `: ${compactUpstreamError(text)}` : ""}`);
      err.statusCode = res.status === 429 ? 429 : 502;
      if (shouldFallback(res.status, text) && models.indexOf(model) < models.length - 1) {
        lastErr = err;
        continue;
      }
      throw err;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const err = new Error("Resposta inválida do fornecedor de IA.");
      err.statusCode = 502;
      throw err;
    }
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      const err = new Error("A IA não devolveu conteúdo utilizável.");
      err.statusCode = 502;
      throw err;
    }
    return { content, model };
  }
  throw lastErr ?? new Error("A IA não devolveu conteúdo utilizável.");
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function createAiMiddleware(env) {
  return (req, res, next) => {
    const url = (req.url ?? "").split("?")[0];
    if (!url.startsWith("/api/ai")) {
      next();
      return;
    }

    const config = resolveAiConfig(env);
    if (url === "/api/ai/status" && (req.method === "GET" || req.method === "HEAD")) {
      sendJson(res, 200, {
        configured: config.configured,
        provider: config.provider,
        model: config.model,
      });
      return;
    }

    if (url === "/api/ai/chat" && req.method === "POST") {
      void (async () => {
        try {
          if (!config.configured) {
            sendJson(res, 503, {
              error: "IA não configurada no servidor. Defina AI_API_KEY no .env (a chave não vai para o browser).",
            });
            return;
          }
          const body = await readJsonBody(req);
          const messages = Array.isArray(body?.messages) ? body.messages.filter(isMessage) : [];
          if (!messages.length) {
            sendJson(res, 400, { error: "O pedido de IA precisa de mensagens." });
            return;
          }
          const { content, model } = await completeUpstream(config, {
            messages,
            temperature: body.temperature,
            json: Boolean(body.json || body.response_format?.type === "json_object"),
          });
          sendJson(res, 200, { content, provider: config.provider, model });
        } catch (err) {
          const status = Number(err?.statusCode) || 500;
          sendJson(res, status, { error: err?.message || "Falha ao contactar a IA." });
        }
      })();
      return;
    }

    sendJson(res, 404, { error: "Rota de IA desconhecida." });
  };
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function aiProxyPlugin(env) {
  const middleware = createAiMiddleware(env);
  return {
    name: "vtwin-ai-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
