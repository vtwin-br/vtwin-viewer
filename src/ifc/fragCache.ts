/** Cache local do .frag + cronograma derivado de um IFC (IndexedDB). */

import type { ScheduleData } from "../schedule/types";
import { scheduleFromJson, scheduleToJson } from "../schedule/serialize";
import {
  deserializeStepIndex,
  serializeStepIndex,
  type StepIndex,
  type StepIndexWire,
} from "./stepIndex";
import type { IfcSchemaKind } from "./stepText";

const DB_NAME = "vista4d-frag-cache";
const STORE = "models";
const DB_VERSION = 3;
/** Incrementar se a conversão IfcLoader / Fragments mudar de forma incompatível. */
const SCHEMA = 3;
export const ARTIFACT_PIPELINE_VERSION = 1;
export const IFC_SEMANTIC_PROFILE = "vista4d-openbim-v1";
const MAX_CACHE_BYTES = 800 * 1024 * 1024;

interface FragCacheRecord {
  hash: string;
  schema: number;
  savedAt: number;
  byteLength: number;
  frag: ArrayBuffer;
  schedule?: unknown;
  manifest?: StoredArtifactManifest;
  index?: StepIndexWire;
}

interface StoredArtifactManifest {
  pipelineVersion: number;
  semanticProfile: string;
  ifcSchema: IfcSchemaKind;
  sourceByteLength: number;
  fragByteLength: number;
}

export interface ModelArtifactManifest extends StoredArtifactManifest {
  hash: string;
  savedAt: number;
}

export interface CacheArtifactInput {
  ifcSchema: IfcSchemaKind;
  sourceByteLength: number;
  index: StepIndex;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export async function hashIfcBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toDigestSource(bytes));
  const arr = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < arr.length; i++) hex += arr[i]!.toString(16).padStart(2, "0");
  return hex;
}

export interface CachedModel {
  frag: Uint8Array;
  schedule: ScheduleData | null;
  index: StepIndex | null;
  manifest: ModelArtifactManifest | null;
  /** Cache suficiente para abrir sem preparar nem parsear novamente o IFC. */
  warmReady: boolean;
}

export async function getCachedFragments(hash: string): Promise<Uint8Array | null> {
  const rec = await getCachedModel(hash);
  return rec?.frag ?? null;
}

export async function getCachedModel(hash: string): Promise<CachedModel | null> {
  try {
    const db = await openDb();
    const rec = await idbReq<FragCacheRecord | undefined>(
      db.transaction(STORE, "readonly").objectStore(STORE).get(hash),
    );
    if (!rec || rec.schema !== SCHEMA || !rec.frag) return null;
    const schedule = rec.schedule ? scheduleFromJson(rec.schedule) : null;
    const index = deserializeStepIndex(rec.index);
    const manifest = validManifest(rec.manifest)
      ? {
          ...rec.manifest,
          hash: rec.hash,
          savedAt: rec.savedAt,
        }
      : null;
    return {
      // O structured clone do IndexedDB já devolve uma cópia própria.
      frag: new Uint8Array(rec.frag),
      schedule,
      index,
      manifest,
      warmReady: !!schedule && !!index && !!manifest,
    };
  } catch {
    return null;
  }
}

export async function saveCachedFragments(hash: string, data: Uint8Array | ArrayBuffer): Promise<void> {
  await saveCachedModel(hash, data, null);
}

export async function saveCachedModel(
  hash: string,
  data: Uint8Array | ArrayBuffer,
  schedule: ScheduleData | null,
  artifact?: CacheArtifactInput,
): Promise<void> {
  try {
    const frag = toArrayBuffer(data);
    const db = await openDb();
    const rec: FragCacheRecord = {
      hash,
      schema: SCHEMA,
      savedAt: Date.now(),
      byteLength: frag.byteLength,
      frag,
      schedule: schedule ? scheduleToJson(schedule) : undefined,
      manifest: artifact
        ? {
            pipelineVersion: ARTIFACT_PIPELINE_VERSION,
            semanticProfile: IFC_SEMANTIC_PROFILE,
            ifcSchema: artifact.ifcSchema,
            sourceByteLength: artifact.sourceByteLength,
            fragByteLength: frag.byteLength,
          }
        : undefined,
      index: artifact ? serializeStepIndex(artifact.index) : undefined,
    };
    await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(rec));
    await evictIfNeeded(db);
  } catch (err) {
    console.warn("Não foi possível guardar o cache Fragments:", err);
  }
}

export async function invalidateCachedModel(hash: string): Promise<void> {
  try {
    const db = await openDb();
    await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).delete(hash));
  } catch {
    /* cache é descartável */
  }
}

function toDigestSource(bytes: Uint8Array): ArrayBuffer {
  const buf = bytes.buffer;
  if (buf instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) {
    return buf;
  }
  return bytes.slice().buffer;
}

function toArrayBuffer(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data.buffer;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function validManifest(value: StoredArtifactManifest | undefined): value is StoredArtifactManifest {
  return (
    !!value &&
    value.pipelineVersion === ARTIFACT_PIPELINE_VERSION &&
    value.semanticProfile === IFC_SEMANTIC_PROFILE &&
    (value.ifcSchema === "IFC2X3" ||
      value.ifcSchema === "IFC4" ||
      value.ifcSchema === "IFC4X3") &&
    Number.isFinite(value.sourceByteLength) &&
    Number.isFinite(value.fragByteLength)
  );
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "hash" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  const all = await idbReq<FragCacheRecord[]>(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  all.sort((a, b) => a.savedAt - b.savedAt);
  let total = all.reduce((s, r) => s + (r.byteLength || 0), 0);
  if (total <= MAX_CACHE_BYTES && all.length <= 24) return;
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  while (all.length > 2 && (total > MAX_CACHE_BYTES || all.length > 24)) {
    const drop = all.shift();
    if (!drop) break;
    await idbReq(store.delete(drop.hash));
    total -= drop.byteLength || 0;
  }
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
