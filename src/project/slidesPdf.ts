import { strToU8, zipSync } from "fflate";

export interface SlidePage {
  name: string;
  comment: string;
  image?: string;
}

/** PDF com uma página por slide. A imagem, se existir, é JPEG. */
export function slidesToPdf(pages: SlidePage[]): Uint8Array {
  return buildPdf(pages);
}

function buildPdf(pages: SlidePage[]): Uint8Array {
  const chunks: Array<string | Uint8Array> = [];
  const offsets: number[] = [0];
  let cursor = 0;
  const push = (part: string | Uint8Array) => {
    chunks.push(part);
    cursor += typeof part === "string" ? part.length : part.byteLength;
  };
  push("%PDF-1.4\n");
  const list = pages.length ? pages : [{ name: "Slide", comment: "" }];
  const pageCount = list.length;
  const fontId = 1;
  const pagesId = 2;
  const catalogId = 3;
  let next = 4;
  const pageRefs: string[] = [];
  const body: Array<string | Uint8Array> = [];
  const record = (id: number, part: string | Uint8Array) => {
    offsets[id] = cursor;
    push(part);
  };
  // Reserve by writing font, pages, catalog after we know kids. Two-pass in memory.
  const stored: { id: number; data: Array<string | Uint8Array> }[] = [];
  const addObj = (id: number, parts: Array<string | Uint8Array>) => {
    stored.push({ id, data: parts });
  };
  addObj(fontId, [`${fontId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`]);
  for (const page of list) {
    const pageId = next++;
    const contentId = next++;
    pageRefs.push(`${pageId} 0 R`);
    const image = page.image ? jpegSize(page.image) : null;
    let imageId = 0;
    let imageBytes: Uint8Array | null = null;
    if (image) {
      imageId = next++;
      imageBytes = base64ToBytes(page.image || "");
    }
    const width = 595;
    const height = 842;
    const caption = pdfText(`${page.name}${page.comment ? ` — ${page.comment}` : ""}`.slice(0, 180));
    let stream = `BT /F1 11 Tf 36 812 Td ${caption} Tj ET\n`;
    if (image && imageBytes && imageId) {
      const boxW = 523;
      const boxH = 740;
      const scale = Math.min(boxW / image.width, boxH / image.height);
      const drawW = image.width * scale;
      const drawH = image.height * scale;
      const x = 36 + (boxW - drawW) / 2;
      stream += `q ${trim(drawW)} 0 0 ${trim(drawH)} ${trim(x)} 36 cm /Im${imageId} Do Q\n`;
    }
    const resources = imageId ? `/XObject << /Im${imageId} ${imageId} 0 R >>` : "";
    addObj(pageId, [
      `${pageId} 0 obj << /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontId} 0 R >> ${resources} >> /Contents ${contentId} 0 R >> endobj\n`,
    ]);
    addObj(contentId, [`${contentId} 0 obj << /Length ${stream.length} >> stream\n${stream}endstream\nendobj\n`]);
    if (image && imageBytes && imageId) {
      addObj(imageId, [
        `${imageId} 0 obj << /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.byteLength} >> stream\n`,
        imageBytes,
        `\nendstream\nendobj\n`,
      ]);
    }
  }
  addObj(pagesId, [
    `${pagesId} 0 obj << /Type /Pages /Count ${pageCount} /Kids [${pageRefs.join(" ")}] >> endobj\n`,
  ]);
  addObj(catalogId, [`${catalogId} 0 obj << /Type /Catalog /Pages ${pagesId} 0 R >> endobj\n`]);
  stored.sort((a, b) => a.id - b.id);
  for (const obj of stored) {
    offsets[obj.id] = cursor;
    for (const part of obj.data) push(part);
  }
  const xrefAt = cursor;
  const size = next;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) {
    xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer << /Size ${size} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  push(xref);
  return concat(chunks);
}

export function slidesToZip(pages: Array<SlidePage & { image?: string }>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  pages.forEach((page, index) => {
    const stem = `${String(index + 1).padStart(2, "0")}-${safeName(page.name)}`;
    if (page.image) files[`${stem}.jpg`] = base64ToBytes(page.image);
    files[`${stem}.txt`] = strToU8(page.comment || page.name);
  });
  if (!Object.keys(files).length) files["vazio.txt"] = strToU8("");
  return zipSync(files);
}

function jpegSize(base64: string): { width: number; height: number } | null {
  const bytes = base64ToBytes(base64);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function base64ToBytes(data: string): Uint8Array {
  const clean = data.replace(/\s/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pdfText(value: string): string {
  let out = "(";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 32;
    if (ch === "\\") out += "\\\\";
    else if (ch === "(" || ch === ")") out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code === 0xe7) out += "c";
    else if (code === 0xe3 || code === 0xe1 || code === 0xe0 || code === 0xe2) out += "a";
    else if (code === 0xe9 || code === 0xea) out += "e";
    else if (code === 0xed) out += "i";
    else if (code === 0xf3 || code === 0xf5 || code === 0xf4) out += "o";
    else if (code === 0xfa) out += "u";
    else out += " ";
  }
  return `${out})`;
}

function trim(value: number): string {
  return value.toFixed(2);
}

function safeName(value: string): string {
  const clean = value.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "");
  return clean || "slide";
}

function concat(chunks: Array<string | Uint8Array>): Uint8Array {
  let length = 0;
  const parts = chunks.map((chunk) => (typeof chunk === "string" ? strToU8(chunk) : chunk));
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
