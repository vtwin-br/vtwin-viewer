import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";

let workerReady = false;

function ensureWorker(): void {
  if (workerReady) return;
  GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  workerReady = true;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    let part = "";
    for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j]!);
    binary += part;
  }
  return btoa(binary);
}

export async function renderPdfSheet(
  base64: string,
  sheet: number,
  removeWhite: boolean,
): Promise<{ canvas: HTMLCanvasElement; aspect: number; pageCount: number }> {
  ensureWorker();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const doc = await getDocument({ data: bytes }).promise;
  const page = await doc.getPage(Math.min(doc.numPages, Math.max(1, sheet + 1)));
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(base.width, 1)) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Sem canvas para a folha.");
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (removeWhite) knockOutWhite(ctx, canvas.width, canvas.height);
  return { canvas, aspect: base.width / Math.max(base.height, 1), pageCount: doc.numPages };
}

function knockOutWhite(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! > 245 && data[i + 1]! > 245 && data[i + 2]! > 245) data[i + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);
}
