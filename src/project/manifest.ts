import type { IfcSchemaKind } from "../ifc/stepText";
import type { ModelExtraTransform } from "../ifc/georef";

export const VTWIN_FORMAT = "vtwin";
export const VTWIN_MANIFEST_VERSION = 1;
export const VTWIN_EXTENSION = ".vtwin";

export type VtwinModelRole = "coordination" | "discipline";

export interface VtwinModelEntry {
  id: string;
  fileName: string;
  /** Dono do 4D/5D/logística na federação. */
  role: VtwinModelRole;
  schema: IfcSchemaKind;
  hash: string;
  visible: boolean;
  extra?: ModelExtraTransform;
}

export interface VtwinManifest {
  format: typeof VTWIN_FORMAT;
  version: typeof VTWIN_MANIFEST_VERSION;
  name: string;
  createdAt: string;
  /** IFC de coordenação (COORD.ifc) quando o projeto tem raiz. */
  rootId: string | null;
  models: VtwinModelEntry[];
}

export function isVtwinFileName(name: string): boolean {
  return /\.vtwin$/i.test(name);
}

export function modelZipDir(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "model";
}

export function parseVtwinManifest(raw: unknown): VtwinManifest {
  if (!raw || typeof raw !== "object") throw new Error("O manifesto do projeto está vazio.");
  const j = raw as Partial<VtwinManifest>;
  if (j.format !== VTWIN_FORMAT) throw new Error("Este ficheiro não é um projeto vtwin.");
  if (j.version !== VTWIN_MANIFEST_VERSION) {
    throw new Error(`Versão de projeto não suportada (${String(j.version)}).`);
  }
  if (typeof j.name !== "string" || !j.name.trim()) throw new Error("O projeto não tem nome.");
  if (!Array.isArray(j.models) || j.models.length === 0) {
    throw new Error("O projeto não contém modelos.");
  }
  const models: VtwinModelEntry[] = j.models.map((m, i) => {
    if (!m || typeof m !== "object") throw new Error(`Modelo #${i + 1} inválido no manifesto.`);
    if (typeof m.id !== "string" || !m.id) throw new Error(`Modelo #${i + 1} sem id.`);
    if (typeof m.fileName !== "string" || !m.fileName) throw new Error(`Modelo «${m.id}» sem ficheiro.`);
    if (m.schema !== "IFC2X3" && m.schema !== "IFC4" && m.schema !== "IFC4X3") {
      throw new Error(`Schema IFC desconhecido em «${m.fileName}».`);
    }
    if (typeof m.hash !== "string" || !m.hash) throw new Error(`Hash em falta em «${m.fileName}».`);
    const extra = parseExtra(m.extra);
    return {
      id: m.id,
      fileName: m.fileName,
      role: m.role === "coordination" ? "coordination" : "discipline",
      schema: m.schema,
      hash: m.hash,
      visible: m.visible !== false,
      extra,
    };
  });
  return {
    format: VTWIN_FORMAT,
    version: VTWIN_MANIFEST_VERSION,
    name: j.name.trim(),
    createdAt: typeof j.createdAt === "string" ? j.createdAt : new Date().toISOString(),
    rootId: typeof j.rootId === "string" && j.rootId ? j.rootId : null,
    models,
  };
}

function parseExtra(raw: VtwinModelEntry["extra"]): ModelExtraTransform | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const z = Number(raw.z);
  const yaw = Number(raw.yaw);
  if (![x, y, z, yaw].every(Number.isFinite)) return undefined;
  return { x, y, z, yaw };
}
