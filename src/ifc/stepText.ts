/** Leitura/escrita pontual de entidades STEP (ISO-10303-21) sem regravar o IFC inteiro. */

export interface StepEntity {
  expressId: number;
  type: string;
  args: string[];
  start: number;
  end: number;
}

export function bytesToLatin1(buf: Uint8Array): string {
  return new TextDecoder("latin1").decode(buf);
}

export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Uma só passagem texto + bytes para web-ifc / IfcLoader.
 * Em IFC4 (sem rewrite) reutiliza o buffer original — não re-encoda 170 MB.
 */
export function prepareIfcForOpen(buffer: Uint8Array): { text: string; bytes: Uint8Array } {
  const text = bytesToLatin1(buffer);
  const prepared = prepareIfcTextForOpen(text);
  if (prepared === text) return { text, bytes: buffer };
  return { text: prepared, bytes: latin1ToBytes(prepared) };
}

export function maxExpressId(text: string): number {
  let max = 0;
  const re = /#(\d+)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

export function ifcString(value: string): string {
  const cleaned = value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
  let inner = "";
  for (const ch of cleaned) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32) continue;
    if (ch === "'") {
      inner += "''";
      continue;
    }
    if (ch === "\\") {
      inner += "\\\\";
      continue;
    }
    if (c < 256) {
      inner += ch;
      continue;
    }
    if (c > 0xffff) {
      const h = c - 0x10000;
      const hi = 0xd800 + (h >> 10);
      const lo = 0xdc00 + (h & 0x3ff);
      inner += `\\X2\\${hex4(hi)}${hex4(lo)}\\X0\\`;
    } else {
      inner += `\\X2\\${hex4(c)}\\X0\\`;
    }
  }
  return `'${inner}'`;
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

export function ifcOptionalString(value: string | undefined): string {
  const v = value?.trim();
  return v ? ifcString(v) : "$";
}

const IFC_GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** GlobalId IFC de 22 caracteres (único; não precisa ser UUID comprimido oficial). */
export function createIfcGuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 6 && out.length < 22) {
      bits -= 6;
      out += IFC_GUID_CHARS[(acc >> bits) & 63];
    }
  }
  while (out.length < 22) out += IFC_GUID_CHARS[0];
  return out;
}

export function formatMonetaryMeasure(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const body = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return `IFCMONETARYMEASURE(${body})`;
}

export function formatIfcDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** ExpressID da entidade cujo GlobalId (1.º argumento) é `guid`. */
export function findExpressIdByGlobalId(text: string, guid: string): number | undefined {
  const g = guid.trim();
  if (!g) return undefined;
  const escaped = g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`#(\\d+)\\s*=\\s*IFC[A-Z0-9]+\\s*\\(\\s*'${escaped}'`, "i");
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function findEntity(text: string, expressId: number): StepEntity | null {
  const needle = `#${expressId}`;
  let from = 0;
  while (from < text.length) {
    const hash = text.indexOf(needle, from);
    if (hash < 0) return null;
    if (hash > 0 && isDigit(text.charCodeAt(hash - 1))) {
      from = hash + 1;
      continue;
    }
    let i = hash + needle.length;
    if (i < text.length && isDigit(text.charCodeAt(i))) {
      from = hash + 1;
      continue;
    }
    i = skipWs(text, i);
    if (text[i] !== "=") {
      from = hash + 1;
      continue;
    }
    i = skipWs(text, i + 1);
    const typeStart = i;
    while (i < text.length && isIdentChar(text.charCodeAt(i))) i++;
    const type = text.slice(typeStart, i);
    i = skipWs(text, i);
    if (text[i] !== "(") {
      from = hash + 1;
      continue;
    }
    const close = findMatchingParen(text, i);
    if (close < 0) return null;
    const argsRaw = text.slice(i + 1, close);
    let j = skipWs(text, close + 1);
    if (text[j] !== ";") {
      from = hash + 1;
      continue;
    }
    return {
      expressId,
      type,
      args: splitStepArgs(argsRaw),
      start: hash,
      end: j + 1,
    };
  }
  return null;
}

export function serializeEntity(expressId: number, type: string, args: string[]): string {
  return `#${expressId}=${type}(${args.join(",")});`;
}

export function stepSet(ids: number[]): string {
  return ids.length ? `(${ids.map((id) => `#${id}`).join(",")})` : "()";
}

export function parseStepSetIds(arg: string | undefined): number[] {
  if (!arg || arg === "$" || arg === "()") return [];
  const out: number[] = [];
  const re = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg))) out.push(Number(m[1]));
  return out;
}

export function findFirstExpressIdByType(text: string, type: string): number | undefined {
  const re = new RegExp(`#(\\d+)\\s*=\\s*${type}\\s*\\(`, "i");
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
}

export type IfcSchemaKind = "IFC2X3" | "IFC4";

/** Lê FILE_SCHEMA do cabeçalho STEP. */
export function detectIfcSchema(text: string): IfcSchemaKind {
  const m = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text);
  const raw = (m?.[1] ?? "IFC4").toUpperCase();
  if (raw.includes("2X3") || raw.includes("2X_3") || raw.includes("2X2")) return "IFC2X3";
  return "IFC4";
}

const IFC4_ONLY_TYPES_IN_2X3 = ["IFCRELDECLARES", "IFCTASKTIME"];

/**
 * Entidades IFC4 num FILE_SCHEMA IFC2X3 fazem o web-ifc rebentar no GetLine
 * (`FromRawLineData[…] is not a function`). Comenta-as e alinha IfcTask /
 * IfcWorkControl ao arity 2x3 para o ficheiro voltar a abrir.
 */
export function prepareIfcTextForOpen(text: string): string {
  if (detectIfcSchema(text) !== "IFC2X3") return text;
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const seen = new Set<number>();

  const collect = (type: string, rewrite: (ent: StepEntity) => string | null) => {
    const re = new RegExp(`#(\\d+)\\s*=\\s*${type}\\s*\\(`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const id = Number(m[1]);
      if (seen.has(id)) continue;
      const ent = findEntity(text, id);
      if (!ent) continue;
      const next = rewrite(ent);
      if (next == null) continue;
      seen.add(id);
      replacements.push({ start: ent.start, end: ent.end, text: next });
    }
  };

  for (const type of IFC4_ONLY_TYPES_IN_2X3) {
    collect(type, (ent) => commentEntity(ent, "ifc4-only-in-ifc2x3"));
  }
  collect("IFCTASK", (ent) => {
    if (ent.args.length <= 10) return null;
    return serializeEntity(ent.expressId, "IFCTASK", ent.args.slice(0, 10));
  });
  const coerceWorkControl = (ent: StepEntity) => {
    const args = [...ent.args];
    const needsPad = args.length !== 15;
    const needsDate = looksLikeIfc4DateString(args[6]) || looksLikeIfc4DateString(args[11]);
    if (!needsPad && !needsDate) return null;
    while (args.length < 15) args.push("$");
    if (args.length > 15) args.length = 15;
    if (looksLikeIfc4DateString(args[6])) args[6] = "$";
    if (looksLikeIfc4DateString(args[11])) args[11] = "$";
    return serializeEntity(ent.expressId, ent.type, args);
  };
  collect("IFCWORKPLAN", coerceWorkControl);
  collect("IFCWORKSCHEDULE", coerceWorkControl);

  return applyReplacements(text, replacements);
}

function looksLikeIfc4DateString(arg: string | undefined): boolean {
  return typeof arg === "string" && /^'\d{4}-\d{2}-\d{2}/.test(arg);
}

export function commentEntity(ent: StepEntity, reason = "deleted"): string {
  return `/* ${reason} #${ent.expressId} ${ent.type} */`;
}

export function insertBeforeLastEndsec(text: string, lines: string[]): string {
  if (lines.length === 0) return text;
  const dataIdx = text.search(/\bDATA\s*;/i);
  const searchFrom = dataIdx >= 0 ? dataIdx : 0;
  const re = /ENDSEC\s*;/gi;
  re.lastIndex = searchFrom;
  let last = -1;
  let found: RegExpExecArray | null;
  while ((found = re.exec(text))) last = found.index;
  if (last < 0) throw new Error("IFC sem ENDSEC; não é possível inserir entidades novas.");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  return text.slice(0, last) + lines.join(nl) + nl + text.slice(last);
}

export function applyReplacements(
  text: string,
  replacements: Array<{ start: number; end: number; text: string }>,
): string {
  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Infinity;
  for (const r of ordered) {
    if (r.end > lastStart) {
      throw new Error("Substituições STEP sobrepostas — abortando para não corromper o IFC.");
    }
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
    lastStart = r.start;
  }
  return out;
}

export function splitStepArgs(argsRaw: string): string[] {
  const args: string[] = [];
  let cur = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < argsRaw.length; i++) {
    const c = argsRaw[i];
    if (inString) {
      cur += c;
      if (c === "'") {
        if (argsRaw[i + 1] === "'") {
          cur += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      cur += c;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")") {
      depth--;
      cur += c;
      continue;
    }
    if (c === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  args.push(cur.trim());
  return args;
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && text.charCodeAt(i) <= 32) i++;
  return i;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95
  );
}
