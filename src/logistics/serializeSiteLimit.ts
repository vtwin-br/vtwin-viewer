import { createIfcGuid, ifcOptionalString, ifcString, serializeEntity, stepSet } from "../ifc/stepText";
import { ifcReal } from "../ifc/georef";
import { firstIdOfType, type StepIndex } from "../ifc/stepIndex";
import {
  VISTA4D_SITE_LIMIT_PSET,
  VISTA4D_SITE_LIMIT_TYPE,
  type IfcPoint,
  type SiteLimit,
} from "./types";
import { dropClosingDuplicate } from "./polygon";

export interface SiteLimitSerializeInput {
  limit: SiteLimit;
  ownerHistory: string;
  index: StepIndex;
  nextExpressId: number;
}

export interface SiteLimitSerializeResult {
  lines: string[];
  nextExpressId: number;
  clusterIds: number[];
  annotationId: number;
  globalId: string;
}

/** IfcAnnotation + IfcPolyline fechada + Pset de recorte, no sistema do projeto. */
export function serializeSiteLimit(input: SiteLimitSerializeInput): SiteLimitSerializeResult {
  const pts = dropClosingDuplicate(input.limit.points);
  if (pts.length < 3) {
    throw new Error("O limite do canteiro precisa de pelo menos 3 vértices.");
  }
  let next = input.nextExpressId;
  const lines: string[] = [];
  const clusterIds: number[] = [];
  const alloc = (): number => {
    const id = next++;
    clusterIds.push(id);
    return id;
  };
  const allocShared = (): number => next++;

  let contextId = firstIdOfType(input.index, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT");
  if (contextId == null) contextId = firstIdOfType(input.index, "IFCGEOMETRICREPRESENTATIONCONTEXT");
  if (contextId == null) {
    const originId = allocShared();
    const axisId = allocShared();
    contextId = allocShared();
    lines.push(serializeEntity(originId, "IFCCARTESIANPOINT", ["(0.,0.,0.)"]));
    lines.push(serializeEntity(axisId, "IFCAXIS2PLACEMENT3D", [`#${originId}`, "$", "$"]));
    lines.push(
      serializeEntity(contextId, "IFCGEOMETRICREPRESENTATIONCONTEXT", [
        "$",
        ifcString("Model"),
        "3",
        "1.0E-5",
        `#${axisId}`,
        "$",
      ]),
    );
  }

  const closed = [...pts, pts[0]!];
  const pointIds: number[] = [];
  for (const p of closed) {
    const id = alloc();
    pointIds.push(id);
    lines.push(serializeEntity(id, "IFCCARTESIANPOINT", [tuple3(p)]));
  }
  const polylineId = alloc();
  lines.push(serializeEntity(polylineId, "IFCPOLYLINE", [stepSet(pointIds)]));
  const setId = alloc();
  lines.push(serializeEntity(setId, "IFCGEOMETRICCURVESET", [`(#${polylineId})`]));
  const shapeRepId = alloc();
  lines.push(
    serializeEntity(shapeRepId, "IFCSHAPEREPRESENTATION", [
      `#${contextId}`,
      ifcString("Annotation"),
      ifcString("GeometricCurveSet"),
      `(#${setId})`,
    ]),
  );
  const prodShapeId = alloc();
  lines.push(serializeEntity(prodShapeId, "IFCPRODUCTDEFINITIONSHAPE", ["$", "$", `(#${shapeRepId})`]));

  const placeOriginId = alloc();
  const placeAxisId = alloc();
  const placementId = alloc();
  lines.push(serializeEntity(placeOriginId, "IFCCARTESIANPOINT", ["(0.,0.,0.)"]));
  lines.push(serializeEntity(placeAxisId, "IFCAXIS2PLACEMENT3D", [`#${placeOriginId}`, "$", "$"]));
  lines.push(serializeEntity(placementId, "IFCLOCALPLACEMENT", ["$", `#${placeAxisId}`]));

  const annotationId = alloc();
  const globalId = input.limit.globalId || createIfcGuid();
  lines.push(
    serializeEntity(annotationId, "IFCANNOTATION", [
      ifcString(globalId),
      input.ownerHistory,
      ifcOptionalString(input.limit.name || "Canteiro"),
      ifcString("Limite de intervenção do canteiro"),
      ifcString(VISTA4D_SITE_LIMIT_TYPE),
      `#${placementId}`,
      `#${prodShapeId}`,
    ]),
  );

  const pBelow = alloc();
  const pAbove = alloc();
  const pBuffer = alloc();
  const pPlateau = alloc();
  const psetId = alloc();
  const relPsetId = alloc();
  lines.push(lengthProp(pBelow, "ClipBelow", input.limit.clipBelow));
  lines.push(lengthProp(pAbove, "ClipAbove", input.limit.clipAbove));
  lines.push(lengthProp(pBuffer, "ClipBuffer", input.limit.clipBuffer));
  lines.push(
    serializeEntity(pPlateau, "IFCPROPERTYSINGLEVALUE", [
      ifcString("ShowPlateau"),
      "$",
      `IFCBOOLEAN(${input.limit.showPlateau ? ".T." : ".F."})`,
      "$",
    ]),
  );
  lines.push(
    serializeEntity(psetId, "IFCPROPERTYSET", [
      ifcString(createIfcGuid()),
      input.ownerHistory,
      ifcString(VISTA4D_SITE_LIMIT_PSET),
      ifcString("Recorte do contexto Google e platô de terraplenagem"),
      `(#${pBelow},#${pAbove},#${pBuffer},#${pPlateau})`,
    ]),
  );
  lines.push(
    serializeEntity(relPsetId, "IFCRELDEFINESBYPROPERTIES", [
      ifcString(createIfcGuid()),
      input.ownerHistory,
      "$",
      "$",
      `(#${annotationId})`,
      `#${psetId}`,
    ]),
  );

  const siteId = firstIdOfType(input.index, "IFCSITE");
  if (siteId != null) {
    const relContainedId = alloc();
    lines.push(
      serializeEntity(relContainedId, "IFCRELCONTAINEDINSPATIALSTRUCTURE", [
        ifcString(createIfcGuid()),
        input.ownerHistory,
        ifcString("Canteiro"),
        "$",
        `(#${annotationId})`,
        `#${siteId}`,
      ]),
    );
  }

  return { lines, nextExpressId: next, clusterIds, annotationId, globalId };
}

function tuple3(p: IfcPoint): string {
  return `(${ifcReal(p.x)},${ifcReal(p.y)},${ifcReal(p.z)})`;
}

function lengthProp(id: number, name: string, value: number): string {
  return serializeEntity(id, "IFCPROPERTYSINGLEVALUE", [
    ifcString(name),
    "$",
    `IFCLENGTHMEASURE(${ifcReal(value)})`,
    "$",
  ]);
}
