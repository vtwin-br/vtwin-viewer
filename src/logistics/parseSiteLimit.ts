import { findEntity, parseIfcString, parseStepSetIds, type StepEntity } from "../ifc/stepText";
import { idsOfType, type StepIndex } from "../ifc/stepIndex";
import {
  VISTA4D_SITE_LIMIT_PSET,
  VISTA4D_SITE_LIMIT_TYPE,
  type IfcPoint,
  type SiteLimit,
} from "./types";
import { dropClosingDuplicate } from "./polygon";

/**
 * Lê a IfcAnnotation `VISTA4D_SITE_LIMIT` e a polilinha / Pset associados.
 */
export function parseSiteLimitFromStep(text: string, index: StepIndex): SiteLimit | null {
  for (const id of idsOfType(index, "IFCANNOTATION")) {
    const ent = findEntity(text, id, index);
    if (!ent) continue;
    if (parseIfcString(ent.args[4]).toUpperCase() !== VISTA4D_SITE_LIMIT_TYPE) continue;
    const parsed = readAnnotation(text, index, ent);
    if (parsed) return parsed;
  }
  return null;
}

function readAnnotation(text: string, index: StepIndex, ent: StepEntity): SiteLimit | null {
  const representationId = firstRef(ent.args[6]);
  const points = representationId != null ? readPoints(text, index, representationId) : [];
  if (points.length < 3) return null;

  const cluster = new Set<number>([ent.expressId]);
  collectRepresentationCluster(text, index, representationId, cluster);
  const placementId = firstRef(ent.args[5]);
  if (placementId != null) collectOwnedPlacement(text, index, placementId, cluster);

  const pset = findBoundPset(text, index, ent.expressId, cluster);
  const contained = findContainedRel(text, index, ent.expressId);
  if (contained) cluster.add(contained);

  const clip = pset ?? { clipBelow: 40, clipAbove: 80, clipBuffer: 1.5, showPlateau: true };

  return {
    globalId: parseIfcString(ent.args[0]),
    name: parseIfcString(ent.args[2]) || "Canteiro",
    points: dropClosingDuplicate(points),
    clipBelow: clip.clipBelow,
    clipAbove: clip.clipAbove,
    clipBuffer: clip.clipBuffer,
    showPlateau: clip.showPlateau,
    annotationId: ent.expressId,
    clusterIds: [...cluster],
  };
}

function readPoints(text: string, index: StepIndex, id: number, depth = 0): IfcPoint[] {
  if (depth > 8) return [];
  const ent = findEntity(text, id, index);
  if (!ent) return [];
  const type = ent.type.toUpperCase();
  if (type === "IFCCARTESIANPOINT") {
    const p = parseTuple(ent.args[0]);
    return p ? [p] : [];
  }
  if (type === "IFCCARTESIANPOINTLIST3D" || type === "IFCCARTESIANPOINTLIST2D") {
    return parsePointList(ent.args[0] ?? "");
  }
  if (type === "IFCPOLYLINE") {
    return parseStepSetIds(ent.args[0]).flatMap((pid) => readPoints(text, index, pid, depth + 1));
  }
  const childArg =
    type === "IFCPRODUCTDEFINITIONSHAPE"
      ? ent.args[2]
      : type === "IFCSHAPEREPRESENTATION"
        ? ent.args[3]
        : type === "IFCGEOMETRICCURVESET" || type === "IFCGEOMETRICSET"
          ? ent.args[0]
          : type === "IFCINDEXEDPOLYCURVE"
            ? ent.args[0]
            : undefined;
  if (childArg == null) return [];
  return parseStepSetIds(childArg).flatMap((ref) => readPoints(text, index, ref, depth + 1));
}

function collectRepresentationCluster(
  text: string,
  index: StepIndex,
  id: number | undefined,
  out: Set<number>,
  depth = 0,
): void {
  if (id == null || out.has(id) || depth > 10) return;
  const ent = findEntity(text, id, index);
  if (!ent) return;
  const type = ent.type.toUpperCase();
  if (
    type === "IFCSITE" ||
    type === "IFCPROJECT" ||
    type === "IFCBUILDING" ||
    type.startsWith("IFCGEOMETRICREPRESENTATION")
  ) {
    return;
  }
  out.add(id);
  if (type === "IFCCARTESIANPOINT" || type === "IFCDIRECTION") return;
  const childArg =
    type === "IFCPRODUCTDEFINITIONSHAPE"
      ? ent.args[2]
      : type === "IFCSHAPEREPRESENTATION"
        ? ent.args[3]
        : type === "IFCGEOMETRICCURVESET" || type === "IFCGEOMETRICSET" || type === "IFCPOLYLINE"
          ? ent.args[0]
          : type === "IFCINDEXEDPOLYCURVE"
            ? ent.args[0]
            : undefined;
  if (childArg == null) return;
  for (const ref of parseStepSetIds(childArg)) {
    collectRepresentationCluster(text, index, ref, out, depth + 1);
  }
}

function collectOwnedPlacement(
  text: string,
  index: StepIndex,
  placementId: number,
  out: Set<number>,
): void {
  const place = findEntity(text, placementId, index);
  if (!place || place.type.toUpperCase() !== "IFCLOCALPLACEMENT") return;
  const parent = firstRef(place.args[0]);
  if (parent != null) return;
  out.add(placementId);
  const axisId = firstRef(place.args[1]);
  if (axisId == null) return;
  const axis = findEntity(text, axisId, index);
  if (!axis) return;
  out.add(axisId);
  for (const ref of axis.args.flatMap((a) => parseStepSetIds(a))) {
    const leaf = findEntity(text, ref, index);
    if (!leaf) continue;
    const t = leaf.type.toUpperCase();
    if (t === "IFCCARTESIANPOINT" || t === "IFCDIRECTION") out.add(ref);
  }
}

function findBoundPset(
  text: string,
  index: StepIndex,
  annotationId: number,
  cluster: Set<number>,
): {
  clipBelow: number;
  clipAbove: number;
  clipBuffer: number;
  showPlateau: boolean;
} | null {
  for (const id of idsOfType(index, "IFCRELDEFINESBYPROPERTIES")) {
    const rel = findEntity(text, id, index);
    if (!rel) continue;
    const related = parseStepSetIds(rel.args[4]);
    if (!related.includes(annotationId)) continue;
    const psetId = firstRef(rel.args[5]);
    cluster.add(id);
    if (psetId == null) continue;
    const pset = findEntity(text, psetId, index);
    if (!pset) continue;
    cluster.add(psetId);
    const name = parseIfcString(pset.args[2]);
    if (name !== VISTA4D_SITE_LIMIT_PSET && name.toLowerCase() !== VISTA4D_SITE_LIMIT_PSET.toLowerCase()) {
      continue;
    }
    const clip = {
      clipBelow: 40,
      clipAbove: 80,
      clipBuffer: 1.5,
      showPlateau: true,
    };
    for (const pid of parseStepSetIds(pset.args[4])) {
      cluster.add(pid);
      const prop = findEntity(text, pid, index);
      if (!prop) continue;
      const key = parseIfcString(prop.args[0]);
      const raw = prop.args[2] ?? "";
      if (key === "ClipBelow") clip.clipBelow = parseMeasure(raw, clip.clipBelow);
      else if (key === "ClipAbove") clip.clipAbove = parseMeasure(raw, clip.clipAbove);
      else if (key === "ClipBuffer") clip.clipBuffer = parseMeasure(raw, clip.clipBuffer);
      else if (key === "ShowPlateau") clip.showPlateau = !/\.F\.|FALSE/i.test(raw);
    }
    return clip;
  }
  return null;
}

function findContainedRel(text: string, index: StepIndex, annotationId: number): number | undefined {
  for (const id of idsOfType(index, "IFCRELCONTAINEDINSPATIALSTRUCTURE")) {
    const rel = findEntity(text, id, index);
    if (!rel) continue;
    const related = parseStepSetIds(rel.args[4]);
    if (related.length === 1 && related[0] === annotationId) return id;
  }
  return undefined;
}

function firstRef(arg?: string): number | undefined {
  return parseStepSetIds(arg)[0];
}

function parseTuple(arg?: string): IfcPoint | null {
  if (!arg) return null;
  const nums = [...arg.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].map((m) => Number(m[0]));
  if (nums.length < 2 || nums.some((n) => !Number.isFinite(n))) return null;
  return { x: nums[0]!, y: nums[1]!, z: nums[2] ?? 0 };
}

function parsePointList(raw: string): IfcPoint[] {
  const inner = raw.trim().replace(/^\(/, "").replace(/\)$/, "");
  const tuples = inner.match(/\([^()]+\)/g) ?? [];
  const pts: IfcPoint[] = [];
  for (const t of tuples) {
    const p = parseTuple(t);
    if (p) pts.push(p);
  }
  return pts;
}

function parseMeasure(raw: string, fallback: number): number {
  const m = raw.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
