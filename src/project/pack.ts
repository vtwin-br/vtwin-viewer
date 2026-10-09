import { strFromU8, strToU8, unzip, zip } from "fflate";
import { parseSitePlan, sitePlanToJson, SITE_PLAN_PATH, emptySitePlan, type SitePlan } from "../planning/sitePlan";
import { emptySidecar, readSidecar, sidecarFiles, type ViewerSidecar } from "./viewerPack";
import type { ScheduleData } from "../schedule/types";
import { scheduleFromJson, scheduleToJson } from "../schedule/serialize";
import {
  deserializeStepIndex,
  serializeStepIndex,
  type StepIndex,
} from "../ifc/stepIndex";
import type { ModelExtraTransform } from "../ifc/georef";
import type { IfcSchemaKind } from "../ifc/stepText";
import {
  modelZipDir,
  parseVtwinManifest,
  VTWIN_FORMAT,
  VTWIN_MANIFEST_VERSION,
  type VtwinManifest,
  type VtwinModelEntry,
  type VtwinModelRevision,
} from "./manifest";

export interface VtwinPackModel {
  id: string;
  fileName: string;
  schema: IfcSchemaKind;
  hash: string;
  visible: boolean;
  extra: ModelExtraTransform;
  ifc: Uint8Array;
  frag: Uint8Array | null;
  schedule: ScheduleData;
  index: StepIndex;
  role?: VtwinModelEntry["role"];
  displayName?: string;
  revision?: number;
  revisedAt?: string;
  history?: VtwinModelRevision[];
}

export interface UnpackedVtwinModel {
  entry: VtwinModelEntry;
  ifc: Uint8Array;
  frag: Uint8Array | null;
  schedule: ScheduleData | null;
  index: StepIndex | null;
}

export interface UnpackedVtwin {
  manifest: VtwinManifest;
  models: UnpackedVtwinModel[];
  sitePlan: SitePlan;
  sidecar: ViewerSidecar;
}

export interface VtwinPackOptions {
  /** Pacote para o cliente: .frag + índice + cronograma, sem duplicar os STEP. */
  meshOnly?: boolean;
  /** Planejamento de obra. Não entra no STEP. */
  sitePlan?: SitePlan;
  /** Câmara, markup, keyframes e BCF. Não entram no STEP. */
  sidecar?: ViewerSidecar;
}

const ZIP_OPTS = { level: 6 as const };

export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
}

export async function packVtwin(
  name: string,
  models: VtwinPackModel[],
  opts?: VtwinPackOptions,
): Promise<Uint8Array> {
  const meshOnly = opts?.meshOnly === true;
  if (meshOnly) {
    for (const model of models) {
      if (model.role === "coordination") continue;
      if (!model.frag?.byteLength) {
        throw new Error(`«${model.fileName}» não tem malha para o pacote do cliente.`);
      }
    }
  }
  const rootId = models.find((m) => m.role === "coordination")?.id ?? null;
  const manifest: VtwinManifest = {
    format: VTWIN_FORMAT,
    version: VTWIN_MANIFEST_VERSION,
    name: name.trim() || "Projeto",
    createdAt: new Date().toISOString(),
    rootId,
    meshOnly,
    models: models.map((m) => ({
      id: m.id,
      fileName: m.fileName,
      displayName: m.displayName,
      role: m.role === "coordination" ? "coordination" : "discipline",
      schema: m.schema,
      hash: m.hash,
      visible: m.visible,
      revision: m.revision,
      revisedAt: m.revisedAt,
      history: m.history,
      extra: m.extra,
    })),
  };
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    [SITE_PLAN_PATH]: strToU8(JSON.stringify(sitePlanToJson(opts?.sitePlan ?? emptySitePlan()), null, 2)),
    ...sidecarFiles(opts?.sidecar ?? emptySidecar()),
  };
  for (const m of models) {
    const dir = `models/${modelZipDir(m.id)}`;
    if (!meshOnly) files[`${dir}/model.ifc`] = m.ifc;
    files[`${dir}/schedule.json`] = strToU8(JSON.stringify(scheduleToJson(m.schedule)));
    files[`${dir}/index.json`] = strToU8(JSON.stringify(serializeStepIndex(m.index)));
    if (m.frag && m.frag.byteLength > 0) files[`${dir}/model.frag`] = m.frag;
  }
  return zipAsync(files);
}

export async function unpackVtwin(bytes: Uint8Array): Promise<UnpackedVtwin> {
  const files = normalizeZipKeys(await unzipAsync(bytes));
  const manifestFile = files["manifest.json"];
  if (!manifestFile) throw new Error("Falta manifest.json no projeto.");
  const manifest = parseVtwinManifest(JSON.parse(strFromU8(manifestFile)));
  const models: UnpackedVtwinModel[] = [];
  for (const entry of manifest.models) {
    const dir = `models/${modelZipDir(entry.id)}`;
    const ifc = files[`${dir}/model.ifc`];
    if (!ifc?.byteLength && !manifest.meshOnly) {
      throw new Error(`Falta o IFC de «${entry.fileName}» no projeto.`);
    }
    const scheduleRaw = files[`${dir}/schedule.json`];
    const indexRaw = files[`${dir}/index.json`];
    let schedule: ScheduleData | null = null;
    let index: StepIndex | null = null;
    if (scheduleRaw) {
      try {
        schedule = scheduleFromJson(JSON.parse(strFromU8(scheduleRaw)));
      } catch {
        schedule = null;
      }
    }
    if (indexRaw) {
      try {
        index = deserializeStepIndex(JSON.parse(strFromU8(indexRaw)));
      } catch {
        index = null;
      }
    }
    models.push({
      entry,
      ifc: ifc ?? new Uint8Array(),
      frag: files[`${dir}/model.frag`] ?? null,
      schedule,
      index,
    });
  }
  const planFile = files[SITE_PLAN_PATH];
  const sitePlan = planFile ? parseSitePlan(JSON.parse(strFromU8(planFile))) : emptySitePlan();
  return { manifest, models, sitePlan, sidecar: readSidecar(files) };
}

function normalizeZipKeys(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(files)) {
    out[key.replace(/\\/g, "/")] = value;
  }
  return out;
}

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, ZIP_OPTS, (err, data) => {
      if (err || !data) reject(err ?? new Error("Falha ao compactar o projeto."));
      else resolve(data);
    });
  });
}

function unzipAsync(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (err, data) => {
      if (err || !data) reject(err ?? new Error("Não foi possível abrir o projeto."));
      else resolve(data);
    });
  });
}
