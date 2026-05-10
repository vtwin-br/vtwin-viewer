// Copia binarios WASM do web-ifc e o arquivo 4D.ifc para a pasta public/
// Executado automaticamente apos `npm install` (ver "postinstall" em package.json).
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const publicDir = path.join(root, "public");
const wasmDir = path.join(publicDir, "wasm");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyIfExists(src, dst) {
  if (!existsSync(src)) {
    console.warn(`[setup-public] origem nao encontrada: ${src}`);
    return false;
  }
  await fs.copyFile(src, dst);
  console.log(`[setup-public] ${path.relative(root, src)} -> ${path.relative(root, dst)}`);
  return true;
}

async function main() {
  await ensureDir(publicDir);
  await ensureDir(wasmDir);

  const webIfcDir = path.join(root, "node_modules", "web-ifc");
  const wasmFiles = ["web-ifc.wasm", "web-ifc-mt.wasm"];
  for (const f of wasmFiles) {
    await copyIfExists(path.join(webIfcDir, f), path.join(wasmDir, f));
  }

  // Copia 4D.ifc da raiz para public/ (caso ainda nao tenha sido copiado)
  const ifcSrc = path.join(root, "4D.ifc");
  const ifcDst = path.join(publicDir, "4D.ifc");
  if (existsSync(ifcSrc) && !existsSync(ifcDst)) {
    await copyIfExists(ifcSrc, ifcDst);
  }
}

main().catch((err) => {
  console.error("[setup-public] erro:", err);
  process.exitCode = 1;
});
