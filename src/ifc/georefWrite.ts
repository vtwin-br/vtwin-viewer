import {
  applyReplacements,
  findEntity,
  insertBeforeLastEndsec,
  serializeEntity,
} from "./stepText";
import {
  composeSitePlacement,
  decimalToCompound,
  extraIsIdentity,
  ifcReal,
  type IfcGeoref,
  type ModelExtraTransform,
} from "./georef";

export interface GeoAnchorWrite {
  lat: number;
  lon: number;
  elevation: number;
}

/**
 * Grava âncora geográfica em IfcSite e o extra de mover/rotacionar
 * em IfcSite.ObjectPlacement (IfcLocalPlacement / IfcAxis2Placement3D).
 */
export function patchIfcGeoref(
  text: string,
  nextExpressId: number,
  georef: IfcGeoref,
  extra: ModelExtraTransform,
  geo: GeoAnchorWrite | null,
  geoChanged: boolean,
): { text: string; nextExpressId: number } {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const newLines: string[] = [];
  let next = nextExpressId;
  let siteArgs: string[] | null = null;
  let siteEnt = georef.siteId != null ? findEntity(text, georef.siteId) : null;
  if (siteEnt) siteArgs = [...siteEnt.args];

  if (geoChanged && geo && siteArgs && siteArgs.length >= 12) {
    siteArgs[9] = decimalToCompound(geo.lat);
    siteArgs[10] = decimalToCompound(geo.lon);
    siteArgs[11] = ifcReal(geo.elevation);
  }

  if (geoChanged && geo && georef.mapConversionId != null) {
    const mc = findEntity(text, georef.mapConversionId);
    if (mc && mc.args.length >= 5) {
      const args = [...mc.args];
      args[4] = ifcReal(geo.elevation);
      replacements.push({
        start: mc.start,
        end: mc.end,
        text: serializeEntity(mc.expressId, mc.type, args),
      });
    }
  }

  let extraTouchedSite = false;
  if (!extraIsIdentity(extra) && georef.siteId != null && siteArgs) {
    const before = siteArgs[5];
    next = writeSitePlacement(text, georef, extra, replacements, newLines, next, siteArgs);
    extraTouchedSite = siteArgs[5] !== before;
  }

  if (siteEnt && siteArgs && (geoChanged || extraTouchedSite)) {
    replacements.push({
      start: siteEnt.start,
      end: siteEnt.end,
      text: serializeEntity(siteEnt.expressId, siteEnt.type, siteArgs),
    });
  }

  let out = applyReplacements(text, replacements);
  out = insertBeforeLastEndsec(out, newLines);
  return { text: out, nextExpressId: next };
}

function writeSitePlacement(
  text: string,
  georef: IfcGeoref,
  extra: ModelExtraTransform,
  replacements: Array<{ start: number; end: number; text: string }>,
  newLines: string[],
  next: number,
  siteArgs: string[],
): number {
  const composed = composeSitePlacement(georef.placement, extra);
  const loc = `(${ifcReal(composed.location.x)},${ifcReal(composed.location.y)},${ifcReal(composed.location.z)})`;
  const ref = composed.refDirection;
  const rotated = Math.hypot(ref.x - 1, ref.y, ref.z) > 1e-8;
  const place = georef.placement;

  let locId = place?.locationId;
  if (locId != null) {
    const pt = findEntity(text, locId);
    if (pt) {
      replacements.push({
        start: pt.start,
        end: pt.end,
        text: serializeEntity(pt.expressId, "IFCCARTESIANPOINT", [loc]),
      });
    }
  } else {
    locId = next++;
    newLines.push(serializeEntity(locId, "IFCCARTESIANPOINT", [loc]));
  }

  let axisDir = "$";
  let refDir = "$";
  if (rotated) {
    const zId = next++;
    const xId = next++;
    newLines.push(serializeEntity(zId, "IFCDIRECTION", ["(0.,0.,1.)"]));
    newLines.push(
      serializeEntity(xId, "IFCDIRECTION", [`(${ifcReal(ref.x)},${ifcReal(ref.y)},${ifcReal(ref.z)})`]),
    );
    axisDir = `#${zId}`;
    refDir = `#${xId}`;
  }

  if (place?.axisId != null && rotated) {
    const axis = findEntity(text, place.axisId);
    if (axis && axis.args.length >= 3) {
      const args = [...axis.args];
      args[0] = `#${locId}`;
      args[1] = axisDir;
      args[2] = refDir;
      replacements.push({
        start: axis.start,
        end: axis.end,
        text: serializeEntity(axis.expressId, axis.type, args),
      });
      return next;
    }
  }

  if (place?.placementId == null || place?.axisId == null) {
    const axisId = next++;
    const placementId = next++;
    newLines.push(serializeEntity(axisId, "IFCAXIS2PLACEMENT3D", [`#${locId}`, axisDir, refDir]));
    newLines.push(serializeEntity(placementId, "IFCLOCALPLACEMENT", ["$", `#${axisId}`]));
    if (siteArgs.length >= 6) siteArgs[5] = `#${placementId}`;
  }

  return next;
}
