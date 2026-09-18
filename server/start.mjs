import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { createAiMiddleware, loadDotEnvFiles } from "./aiProxy.mjs";

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".ifc": "application/octet-stream",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const env = loadDotEnvFiles();
const dist = resolve(process.cwd(), env.DIST_DIR || "dist");
const port = Number(env.PORT || 4173);
const ai = createAiMiddleware(env);

if (!existsSync(join(dist, "index.html"))) {
  console.error("Não encontrei dist/index.html. Corre `npm run build` antes de `npm start`.");
  process.exit(1);
}

function insideDist(filePath) {
  const rel = relative(dist, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sendFile(res, filePath) {
  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  ai(req, res, () => {
    try {
      const url = new URL(req.url || "/", "http://local");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      let filePath = resolve(dist, `.${pathname}`);
      if (!insideDist(filePath) && filePath !== dist) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(dist, "index.html");
      }
      sendFile(res, filePath);
    } catch {
      res.statusCode = 500;
      res.end("Erro a servir o VTwin.");
    }
  });
});

server.listen(port, () => {
  const aiCfg = env.AI_API_KEY || env.GEMINI_API_KEY || env.GROQ_API_KEY || env.OPENAI_API_KEY;
  console.log(`VTwin em http://localhost:${port}`);
  console.log(aiCfg ? "IA: chave carregada no backend." : "IA: sem AI_API_KEY (refinar com IA fica indisponível).");
});
