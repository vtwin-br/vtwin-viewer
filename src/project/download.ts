import { VTWIN_EXTENSION } from "./manifest";

export function downloadBytes(bytes: Uint8Array, fileName: string, mime = "application/octet-stream"): void {
  const blob = new Blob([toArrayBuffer(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function vtwinDownloadName(projectName: string): string {
  const stem = projectName
    .replace(/\.vtwin$/i, "")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `${stem || "projeto"}${VTWIN_EXTENSION}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = bytes.buffer;
  if (buf instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) {
    return buf;
  }
  return bytes.slice().buffer;
}
