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
  return `'${value.replace(/'/g, "''")}'`;
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
  const needle = `#${expressId}=`;
  let from = 0;
  while (from < text.length) {
    const hash = text.indexOf(needle, from);
    if (hash < 0) return null;
    if (hash > 0 && isDigit(text.charCodeAt(hash - 1))) {
      from = hash + 1;
      continue;
    }
    let i = hash + needle.length;
    i = skipWs(text, i);
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

export function insertBeforeLastEndsec(text: string, lines: string[]): string {
  if (lines.length === 0) return text;
  const idx = text.lastIndexOf("ENDSEC;");
  if (idx < 0) throw new Error("IFC sem ENDSEC; não é possível inserir entidades novas.");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  return text.slice(0, idx) + lines.join(nl) + nl + text.slice(idx);
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
