/** Famílias IFC usadas na árvore, no filtro de tipos e no assistente 4D. */

export const FAMILY_ORDER = [
  "IFCWALL",
  "IFCSLAB",
  "IFCROOF",
  "IFCBEAM",
  "IFCCOLUMN",
  "IFCDOOR",
  "IFCWINDOW",
  "IFCCURTAINWALL",
  "IFCSTAIR",
  "IFCRAMP",
  "IFCRAILING",
  "IFCCOVERING",
  "IFCMEMBER",
  "IFCPLATE",
  "IFCFOOTING",
  "IFCPILE",
  "IFCBUILDINGELEMENTPROXY",
  "IFCFURNISHINGELEMENT",
  "IFCFLOWTERMINAL",
  "IFCFLOWSEGMENT",
  "IFCFLOWFITTING",
  "IFCPIPESEGMENT",
  "IFCDUCTSEGMENT",
  "IFCCABLECARRIERSEGMENT",
] as const;

export const FAMILY_LABELS: Record<string, string> = {
  IFCWALL: "Parede",
  IFCSLAB: "Laje",
  IFCROOF: "Cobertura",
  IFCBEAM: "Viga",
  IFCCOLUMN: "Pilar",
  IFCDOOR: "Porta",
  IFCWINDOW: "Janela",
  IFCCURTAINWALL: "Fachada cortina",
  IFCSTAIR: "Escada",
  IFCRAMP: "Rampa",
  IFCRAILING: "Guarda-corpo",
  IFCCOVERING: "Revestimento",
  IFCMEMBER: "Perfil",
  IFCPLATE: "Chapa",
  IFCFOOTING: "Fundação",
  IFCPILE: "Estaca",
  IFCBUILDINGELEMENTPROXY: "Proxy",
  IFCFURNISHINGELEMENT: "Mobiliário",
  IFCFLOWTERMINAL: "Terminal MEP",
  IFCFLOWSEGMENT: "Troço MEP",
  IFCFLOWFITTING: "Ligação MEP",
  IFCPIPESEGMENT: "Tubo",
  IFCDUCTSEGMENT: "Conduta",
  IFCCABLECARRIERSEGMENT: "Caminho de cabos",
};

export function normalizeIfcClass(cat: string): string {
  const body = cat.trim().replace(/^IFC/i, "");
  return body ? `IFC${body.toUpperCase()}` : "";
}

export function isSpatialCategory(cat: string | null): boolean {
  if (!cat) return false;
  const u = normalizeIfcClass(cat);
  return (
    u === "IFCFILE" ||
    u === "IFCPROJECT" ||
    u === "IFCSITE" ||
    u === "IFCBUILDING" ||
    u === "IFCBUILDINGSTOREY" ||
    u === "IFCSPACE" ||
    u === "IFCSPATIALZONE" ||
    u === "IFCFACILITY" ||
    u === "IFCBRIDGE" ||
    u === "IFCRAILWAY" ||
    u === "IFCROAD" ||
    u === "IFCMARINEFACILITY" ||
    u === "IFCEXTERNALSPATIALELEMENT" ||
    u === "IFCEXTERNALSPATIALSTRUCTUREELEMENT" ||
    u.endsWith("STOREY")
  );
}

export function isIfcStorey(cat: string | null): boolean {
  if (!cat) return false;
  const u = normalizeIfcClass(cat);
  return u === "IFCBUILDINGSTOREY" || u.endsWith("STOREY");
}

export function productFamily(cat: string | null): string | null {
  if (!cat || isSpatialCategory(cat)) return null;
  const n = normalizeIfcClass(cat);
  if (!n || n === "IFCFILE") return null;
  if (n.endsWith("TYPE") || n.startsWith("IFCREL") || n.startsWith("IFCPROPERTY") || n.startsWith("IFCMATERIAL")) {
    return null;
  }
  if (
    n.startsWith("IFCOPENING") ||
    n.startsWith("IFCGRID") ||
    n.startsWith("IFCANNOTATION") ||
    n.startsWith("IFCVIRTUAL") ||
    n.startsWith("IFCVOIDING") ||
    n.startsWith("IFCTASK") ||
    n.startsWith("IFCWORK") ||
    n.startsWith("IFCCOST")
  ) {
    return null;
  }
  if (n.startsWith("IFCWALL")) return "IFCWALL";
  if (n.startsWith("IFCSLAB") || n === "IFCFLOOR") return "IFCSLAB";
  if (n.startsWith("IFCBEAM")) return "IFCBEAM";
  if (n.startsWith("IFCCOLUMN")) return "IFCCOLUMN";
  if (n.startsWith("IFCDOOR")) return "IFCDOOR";
  if (n.startsWith("IFCWINDOW")) return "IFCWINDOW";
  if (n.startsWith("IFCSTAIR")) return "IFCSTAIR";
  if (n.startsWith("IFCRAMP")) return "IFCRAMP";
  if (n.startsWith("IFCROOF")) return "IFCROOF";
  if (n.startsWith("IFCCOVERING")) return "IFCCOVERING";
  if (n.startsWith("IFCRAILING")) return "IFCRAILING";
  if (n.startsWith("IFCMEMBER")) return "IFCMEMBER";
  if (n.startsWith("IFCPLATE")) return "IFCPLATE";
  if (n.startsWith("IFCPILE")) return "IFCPILE";
  if (n.startsWith("IFCFOOTING")) return "IFCFOOTING";
  if (n.startsWith("IFCCURTAINWALL")) return "IFCCURTAINWALL";
  if (n.startsWith("IFCFURNISHING")) return "IFCFURNISHINGELEMENT";
  if (n.startsWith("IFCPIPE")) return "IFCPIPESEGMENT";
  if (n.startsWith("IFCDUCT")) return "IFCDUCTSEGMENT";
  if (n.startsWith("IFCCABLECARRIER")) return "IFCCABLECARRIERSEGMENT";
  if (n.startsWith("IFCFLOWTERMINAL")) return "IFCFLOWTERMINAL";
  if (n.startsWith("IFCFLOWSEGMENT")) return "IFCFLOWSEGMENT";
  if (n.startsWith("IFCFLOWFITTING")) return "IFCFLOWFITTING";
  if (n.startsWith("IFCBUILDINGELEMENTPROXY")) return "IFCBUILDINGELEMENTPROXY";
  return n;
}

export function categoryLabel(cat: string | null): string {
  if (!cat) return "Elemento";
  return cat.replace(/^IFC/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? categoryLabel(family);
}

export function familyRank(family: string): number {
  const i = (FAMILY_ORDER as readonly string[]).indexOf(family);
  return i < 0 ? FAMILY_ORDER.length + 1 : i;
}
