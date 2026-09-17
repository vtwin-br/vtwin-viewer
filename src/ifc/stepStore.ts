/** Bytes do IFC-SPF original em OPFS (derivado; o utilizador continua a receber .ifc). */

const DIR = "vista4d-ifc";

export async function saveIfcBytes(hash: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const dir = await openDir();
    if (!dir) return false;
    const handle = await dir.getFileHandle(fileName(hash), { create: true });
    const writable = await handle.createWritable();
    await writable.write(toArrayBuffer(bytes));
    await writable.close();
    return true;
  } catch (err) {
    console.warn("OPFS IFC:", err);
    return false;
  }
}

export async function hasIfcBytes(hash: string): Promise<boolean> {
  try {
    const dir = await openDir();
    if (!dir) return false;
    const handle = await dir.getFileHandle(fileName(hash));
    const file = await handle.getFile();
    return file.size > 0;
  } catch {
    return false;
  }
}

export async function loadIfcBytes(hash: string): Promise<Uint8Array | null> {
  try {
    const dir = await openDir();
    if (!dir) return null;
    const handle = await dir.getFileHandle(fileName(hash));
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function deleteIfcBytes(hash: string): Promise<void> {
  try {
    const dir = await openDir();
    if (!dir) return;
    await dir.removeEntry(fileName(hash));
  } catch {
    /* ignore */
  }
}

function fileName(hash: string): string {
  return `${hash}.ifc`;
}

async function openDir(): Promise<FileSystemDirectoryHandle | null> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof storage?.getDirectory !== "function") return null;
  const root = await storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = bytes.buffer;
  if (buf instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) {
    return buf;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
