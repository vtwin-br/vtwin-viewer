import { fileToAttachment } from "./buildPlan";
import { inspectCsv } from "./parseCsv";
import { parseMspdi } from "./parseMspdi";
import type { ImportResult } from "./types";

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

export async function importPlanFile(file: File): Promise<ImportResult> {
  const ext = extension(file.name);

  if (ext === "pdf") {
    return {
      kind: "attachment",
      attachment: fileToAttachment(file, "document"),
    };
  }

  if (ext === "csv" || ext === "txt") {
    const text = await file.text();
    const csv = inspectCsv(text, file.name);
    return { kind: "csv-preview", csv };
  }

  if (ext === "xml") {
    const text = await file.text();
    const plan = parseMspdi(text, file.name);
    plan.attachments.push(fileToAttachment(file, "schedule"));
    return { kind: "plan", plan };
  }

  if (ext === "mpp") {
    const buf = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 256)).trim();
    if (head.startsWith("<?xml") || /<Project[\s>]/i.test(head)) {
      const text = new TextDecoder().decode(buf);
      const plan = parseMspdi(text, file.name);
      plan.attachments.push(fileToAttachment(file, "schedule"));
      return { kind: "plan", plan };
    }
    if (isOle(buf)) {
      return {
        kind: "unsupported-mpp",
        attachment: fileToAttachment(
          file,
          "schedule",
          "Binário .mpp anexado. Exporte XML ou CSV no Microsoft Project para montar o Gantt aqui.",
        ),
        message:
          "O .mpp binário ainda não é lido no browser. O arquivo ficou anexado ao planejamento — no Project use Ficheiro → Guardar como → XML ou CSV.",
      };
    }
    throw new Error("Não reconheci este .mpp. Tente exportar XML ou CSV a partir do Microsoft Project.");
  }

  throw new Error(`Formato não suportado: .${ext || file.name}. Use .csv, .xml, .mpp ou .pdf.`);
}

function extension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return (m?.[1] || "").toLowerCase();
}

function isOle(buf: Uint8Array): boolean {
  if (buf.length < 4) return false;
  return OLE_MAGIC.every((b, i) => buf[i] === b);
}
