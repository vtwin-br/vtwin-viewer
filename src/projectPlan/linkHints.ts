import { FAMILY_LABELS } from "../ifc/ifcFamilies";

const FAMILY_PHRASES: Array<{ family: string; phrases: string[] }> = [
  { family: "IFCCURTAINWALL", phrases: ["fachada cortina", "curtain wall", "muro cortina", "pele de vidro"] },
  { family: "IFCCOVERING", phrases: ["revestimento", "forro", "teto falso", "ceiling", "covering", "pavimento acabado"] },
  { family: "IFCRAILING", phrases: ["guarda corpo", "guarda-corpo", "corrimao", "corrimão", "railing", "guardrail"] },
  { family: "IFCFOOTING", phrases: ["fundacao", "fundação", "sapata", "footing", "radier", "bloco de fundacao", "infrastructure"] },
  { family: "IFCPILE", phrases: ["estaca", "estacas", "pile", "piles"] },
  { family: "IFCSLAB", phrases: ["laje", "lajes", "slab", "slabs", "piso estrutural", "concrete slab"] },
  { family: "IFCROOF", phrases: ["cobertura", "telhado", "roof", "telha"] },
  { family: "IFCWALL", phrases: ["parede", "paredes", "alvenaria", "wall", "walls", "masonry", "vedacao", "vedação", "drywall", "tabique"] },
  { family: "IFCBEAM", phrases: ["viga", "vigas", "beam", "beams", "girder"] },
  { family: "IFCCOLUMN", phrases: ["pilar", "pilares", "coluna", "colunas", "column", "columns", "pilarete"] },
  { family: "IFCDOOR", phrases: ["porta", "portas", "door", "doors"] },
  { family: "IFCWINDOW", phrases: ["janela", "janelas", "window", "windows", "caixilho"] },
  { family: "IFCSTAIR", phrases: ["escada", "escadas", "stair", "stairs", "escadaria"] },
  { family: "IFCRAMP", phrases: ["rampa", "rampas", "ramp"] },
  { family: "IFCMEMBER", phrases: ["perfil metalico", "perfil metálico", "estrutura metalica", "estrutura metálica", "steel member"] },
  { family: "IFCPIPESEGMENT", phrases: ["hidraulica", "hidráulica", "plumbing", "tubulacao", "tubulação", "pipe", "pipes", "agua", "água"] },
  { family: "IFCDUCTSEGMENT", phrases: ["conduta", "condutas", "duct", "hvac", "ar condicionado", "avac", "ventilacao", "ventilação"] },
  { family: "IFCCABLECARRIERSEGMENT", phrases: ["eletrica", "elétrica", "electrical", "bandeja", "eletrocalha", "cable tray"] },
  { family: "IFCFLOWTERMINAL", phrases: ["luminaria", "luminária", "sanitario", "sanitário", "louca", "louça"] },
  { family: "IFCFURNISHINGELEMENT", phrases: ["mobiliario", "mobiliário", "furniture"] },
];

const MODEL_HINTS: Array<{ id: string; phrases: string[] }> = [
  { id: "arch", phrases: ["arq", "arch", "arquitetura", "architecture", "archi"] },
  { id: "str", phrases: ["est", "str", "estrutura", "structural", "struct", "concreto", "formwork", "forma"] },
  { id: "mep", phrases: ["mep", "hid", "ele", "avac", "hvac", "instalacao", "instalação"] },
];

export function foldPt(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ç/g, "c");
}

export function tokenize(value: string): string[] {
  const folded = foldPt(value);
  return folded
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

export function storeyKeys(text: string): string[] {
  const folded = foldPt(text);
  const keys = new Set<string>();
  if (/\b(terreo|ground|rdc|rez de chaussee|t0|pavimento terreo|piso terreo)\b/.test(folded)) {
    keys.add("n:0");
  }
  if (/\b(subsolo|basement|cave|ss1|ss)\b/.test(folded)) {
    const n = folded.match(/\b(?:ss|subsolo|basement)[^\d]{0,4}(-?\d+)/);
    keys.add(n ? `n:${-Math.abs(Number(n[1]))}` : "n:-1");
  }
  if (/\b(cobertura|telhado|roof|attic|atico)\b/.test(folded) && !/\blaje\b/.test(folded)) {
    keys.add("roof");
  }
  const nums = folded.matchAll(
    /\b(?:n|niv|nivel|pav|piso|andar|floor|l|p)\s*[-.]?\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:o|a|º)?\s*(?:andar|pavimento|pav|piso|nivel|floor)\b/g,
  );
  for (const m of nums) {
    const n = Number(m[1] || m[2]);
    if (n >= 0 && n <= 80) keys.add(`n:${n}`);
  }
  const slug = folded.replace(/[^a-z0-9]+/g, " ").trim().slice(0, 28);
  if (slug && !/^\d+$/.test(slug)) keys.add(`s:${slug}`);
  return [...keys];
}

export function inferFamilies(text: string): string[] {
  const folded = ` ${foldPt(text)} `;
  const hit = new Set<string>();
  for (const row of FAMILY_PHRASES) {
    if (row.phrases.some((p) => folded.includes(` ${foldPt(p)} `) || folded.includes(foldPt(p)))) {
      hit.add(row.family);
    }
  }
  for (const [family, label] of Object.entries(FAMILY_LABELS)) {
    const token = foldPt(label);
    if (token.length >= 4 && folded.includes(` ${token} `)) hit.add(family);
  }
  return [...hit];
}

export function inferModelHints(text: string): string[] {
  const folded = foldPt(text);
  return MODEL_HINTS.filter((h) => h.phrases.some((p) => folded.includes(p))).map((h) => h.id);
}

export function modelHintOfLabel(label: string): string | null {
  const hits = inferModelHints(label);
  return hits[0] ?? null;
}
