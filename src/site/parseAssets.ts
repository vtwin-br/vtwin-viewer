import { idsOfType, type StepIndex } from "../ifc/stepIndex";
import { findEntity, parseIfcString, parseStepSetIds } from "../ifc/stepText";
import { libraryItem } from "./library";
import { QTO_SITE_ASSET, VISTA4D_SITE_ASSET, type SiteAsset } from "./types";

const SKIP_WALK = new Set([
  "IFCGEOMETRICREPRESENTATIONCONTEXT",
  "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
  "IFCOWNERHISTORY",
  "IFCPROJECT",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
  "IFCTASK",
  "IFCRELASSIGNSTOPRODUCT",
  "IFCRELASSIGNSTOPROCESS",
]);

/** Lê os proxies VISTA4D_SITE_ASSET já gravados no STEP. */
export function parseSiteAssets(text: string, index: StepIndex): SiteAsset[] {
  const out: SiteAsset[] = [];
  for (const id of idsOfType(index, "IFCBUILDINGELEMENTPROXY")) {
    const ent = findEntity(text, id, index);
    if (!ent) continue;
    const objectType = parseIfcString(ent.args[4]);
    if (objectType !== VISTA4D_SITE_ASSET) continue;
    const libraryKey = parseIfcString(ent.args[7]) || parseIfcString(ent.args[2]);
    const item = libraryItem(libraryKey);
    const placementId = parseStepSetIds(ent.args[5])[0];
    const placed = placementId != null ? readPlacement(text, index, placementId) : null;
    const quantities = readQuantities(text, index, id);
    const cluster = new Set<number>([id]);
    if (placementId != null) walk(text, index, placementId, cluster, 0);
    const shapeId = parseStepSetIds(ent.args[6])[0];
    if (shapeId != null) walk(text, index, shapeId, cluster, 0);
    for (const relId of idsOfType(index, "IFCRELDEFINESBYPROPERTIES")) {
      const rel = findEntity(text, relId, index);
      if (!rel || !parseStepSetIds(rel.args[4]).includes(id)) continue;
      walk(text, index, relId, cluster, 0);
    }
    for (const relId of idsOfType(index, "IFCRELCONTAINEDINSPATIALSTRUCTURE")) {
      const rel = findEntity(text, relId, index);
      if (!rel) continue;
      const members = parseStepSetIds(rel.args[4]);
      if (members.length === 1 && members[0] === id) cluster.add(relId);
    }
    out.push({
      proxyId: id,
      globalId: parseIfcString(ent.args[0]),
      libraryKey,
      name: item?.name || parseIfcString(ent.args[2]) || libraryKey,
      x: placed?.x ?? 0,
      y: placed?.y ?? 0,
      z: placed?.z ?? 0,
      yaw: placed?.yaw ?? 0,
      count: quantities.count,
      length: quantities.length,
      volume: quantities.volume,
      clusterIds: [...cluster],
      isNew: false,
      dirty: false,
    });
  }
  return out;
}

function readPlacement(
  text: string,
  index: StepIndex,
  placementId: number,
): { x: number; y: number; z: number; yaw: number } | null {
  const local = findEntity(text, placementId, index);
  if (!local) return null;
  const axisId = parseStepSetIds(local.args[1])[0];
  const axis = axisId != null ? findEntity(text, axisId, index) : null;
  const pointId = axis ? parseStepSetIds(axis.args[0])[0] : undefined;
  const point = pointId != null ? findEntity(text, pointId, index) : null;
  const coords = point ? parseTuple(point.args[0]) : null;
  if (!coords || coords.length < 3) return null;
  const refId = axis ? parseStepSetIds(axis.args[2])[0] : undefined;
  const ref = refId != null ? findEntity(text, refId, index) : null;
  const refCoords = ref ? parseTuple(ref.args[0]) : null;
  const yaw = refCoords && refCoords.length >= 2 ? Math.atan2(refCoords[1]!, refCoords[0]!) : 0;
  return { x: coords[0]!, y: coords[1]!, z: coords[2]!, yaw };
}

function readQuantities(text: string, index: StepIndex, proxyId: number): { count: number; length: number; volume: number } {
  const totals = { count: 0, length: 0, volume: 0 };
  for (const relId of idsOfType(index, "IFCRELDEFINESBYPROPERTIES")) {
    const rel = findEntity(text, relId, index);
    if (!rel || !parseStepSetIds(rel.args[4]).includes(proxyId)) continue;
    const setId = parseStepSetIds(rel.args[5])[0];
    const set = setId != null ? findEntity(text, setId, index) : null;
    if (!set || set.type !== "IFCELEMENTQUANTITY") continue;
    if (parseIfcString(set.args[2]) !== QTO_SITE_ASSET) continue;
    for (const qid of parseStepSetIds(set.args[5])) {
      const quantity = findEntity(text, qid, index);
      if (!quantity) continue;
      const value = parseMeasure(quantity.args[3]);
      if (quantity.type === "IFCQUANTITYCOUNT") totals.count += value;
      else if (quantity.type === "IFCQUANTITYLENGTH") totals.length += value;
      else if (quantity.type === "IFCQUANTITYVOLUME") totals.volume += value;
    }
  }
  return totals;
}

function walk(text: string, index: StepIndex, id: number, into: Set<number>, depth: number): void {
  if (into.has(id) || depth > 8) return;
  const ent = findEntity(text, id, index);
  if (!ent || SKIP_WALK.has(ent.type)) return;
  into.add(id);
  for (const arg of ent.args) {
    for (const ref of parseStepSetIds(arg)) walk(text, index, ref, into, depth + 1);
  }
}

function parseTuple(arg: string | undefined): number[] | null {
  if (!arg) return null;
  const body = arg.replace(/[()]/g, "");
  const nums = body.split(",").map((part) => Number(part.trim()));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

function parseMeasure(arg: string | undefined): number {
  if (!arg || arg === "$") return 0;
  const n = Number(arg.trim());
  return Number.isFinite(n) ? n : 0;
}
