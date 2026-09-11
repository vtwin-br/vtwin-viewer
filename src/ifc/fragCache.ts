/** Cache local do .frag derivado de um IFC (IndexedDB). Best-effort: quota ou modo privado não bloqueiam a abertura. */

const DB_NAME = "vista4d-frag-cache";
const STORE = "models";
const DB_VERSION = 1;
/** Incrementar se a conversão IfcLoader / Fragments mudar de forma incompatível. */
const SCHEMA = 1;
const MAX_MODELS = 8;

interface FragCacheRecord {
  hash: string;
  schema: number;
  savedAt: number;
  byteLength: number;
  frag: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export async function hashIfcBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toDigestSource(bytes));
  const arr = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < arr.length; i++) hex += arr[i]!.toString(16).padStart(2, "0");
  return hex;
}

export async function getCachedFragments(hash: string): Promise<Uint8Array | null> {
  try {
    const db = await openDb();
    const rec = await idbReq<FragCacheRecord | undefined>(
      db.transaction(STORE, "readonly").objectStore(STORE).get(hash),
    );
    if (!rec || rec.schema !== SCHEMA || !rec.frag) return null;
    return new Uint8Array(rec.frag.slice(0));
  } catch {
    return null;
  }
}

export async function saveCachedFragments(hash: string, data: Uint8Array | ArrayBuffer): Promise<void> {
  try {
    const frag = toArrayBuffer(data);
    const db = await openDb();
    const rec: FragCacheRecord = {
      hash,
      schema: SCHEMA,
      savedAt: Date.now(),
      byteLength: frag.byteLength,
      frag,
    };
    await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(rec));
    await evictIfNeeded(db);
  } catch (err) {
    console.warn("Não foi possível guardar o cache Fragments:", err);
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
  if (data instanceof ArrayBuffer) return data.slice(0);
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
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
  if (all.length <= MAX_MODELS) return;
  all.sort((a, b) => a.savedAt - b.savedAt);
  const drop = all.slice(0, all.length - MAX_MODELS);
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  await Promise.all(drop.map((r) => idbReq(store.delete(r.hash))));
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
