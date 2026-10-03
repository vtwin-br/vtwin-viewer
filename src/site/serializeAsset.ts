import { ifcReal } from "../ifc/georef";
import { firstIdOfType, type StepIndex } from "../ifc/stepIndex";
import {
  createIfcGuid,
  ifcOptionalString,
  ifcString,
  serializeEntity,
  type IfcSchemaKind,
} from "../ifc/stepText";
import { libraryItem } from "./library";
import { QTO_SITE_ASSET, VISTA4D_SITE_ASSET, type SiteAsset } from "./types";

export function siteAssetNeedsContext(index: StepIndex): boolean {
  return (
    firstIdOfType(index, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT") == null &&
    firstIdOfType(index, "IFCGEOMETRICREPRESENTATIONCONTEXT") == null
  );
}

export function siteAssetHasContainer(index: StepIndex): boolean {
  return (
    firstIdOfType(index, "IFCSITE") != null ||
    firstIdOfType(index, "IFCBUILDING") != null ||
    firstIdOfType(index, "IFCBUILDINGSTOREY") != null
  );
}

/** Reserva ids na mesma ordem em que `serializeSiteAsset` os consome. */
export function planSiteAssetIds(
  alloc: () => number,
  options: { needsContext: boolean; quantities: number; hasContainer: boolean },
): { proxyId: number; clusterIds: number[] } {
  const clusterIds: number[] = [];
  const take = () => {
    const id = alloc();
    clusterIds.push(id);
    return id;
  };
  if (options.needsContext) for (let i = 0; i < 3; i++) take();
  for (let i = 0; i < 5 + 9; i++) take();
  const proxyId = take();
  for (let i = 0; i < options.quantities; i++) take();
  if (options.quantities > 0) {
    take();
    take();
  }
  if (options.hasContainer) take();
  return { proxyId, clusterIds };
}

/** IfcBuildingElementProxy + caixa extrudida + IfcElementQuantity. */
export function serializeSiteAsset(asset: SiteAsset, schema: IfcSchemaKind, ownerHistory: string, index: StepIndex): string[] {
  const item = libraryItem(asset.libraryKey);
  const width = item?.width ?? 1;
  const depth = item?.depth ?? 1;
  const height = item?.height ?? 1;
  let cursor = 0;
  const take = (): number => {
    const id = asset.clusterIds[cursor];
    if (id == null) throw new Error("Cluster do elemento de canteiro incompleto.");
    cursor += 1;
    return id;
  };

  const lines: string[] = [];
  let contextId = firstIdOfType(index, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT");
  if (contextId == null) contextId = firstIdOfType(index, "IFCGEOMETRICREPRESENTATIONCONTEXT");
  if (contextId == null) {
    const originId = take();
    const axisId = take();
    contextId = take();
    lines.push(serializeEntity(originId, "IFCCARTESIANPOINT", ["(0.,0.,0.)"]));
    lines.push(serializeEntity(axisId, "IFCAXIS2PLACEMENT3D", [`#${originId}`, "$", "$"]));
    lines.push(
      serializeEntity(contextId, "IFCGEOMETRICREPRESENTATIONCONTEXT", [
        "$",
        ifcString("Model"),
        "3",
        "1.E-05",
        `#${axisId}`,
        "$",
      ]),
    );
  }

  const placePoint = take();
  const placeAxis = take();
  const placeRef = take();
  const place3d = take();
  const placement = take();
  lines.push(serializeEntity(placePoint, "IFCCARTESIANPOINT", [tuple3(asset.x, asset.y, asset.z)]));
  lines.push(serializeEntity(placeAxis, "IFCDIRECTION", ["(0.,0.,1.)"]));
  lines.push(serializeEntity(placeRef, "IFCDIRECTION", [tuple3(Math.cos(asset.yaw), Math.sin(asset.yaw), 0)]));
  lines.push(serializeEntity(place3d, "IFCAXIS2PLACEMENT3D", [`#${placePoint}`, `#${placeAxis}`, `#${placeRef}`]));
  lines.push(serializeEntity(placement, "IFCLOCALPLACEMENT", ["$", `#${place3d}`]));

  const profilePoint = take();
  const profileAxis = take();
  const profile = take();
  const solidPoint = take();
  const solidAxis = take();
  const direction = take();
  const solid = take();
  const shapeRep = take();
  const productShape = take();
  lines.push(serializeEntity(profilePoint, "IFCCARTESIANPOINT", ["(0.,0.)"]));
  lines.push(serializeEntity(profileAxis, "IFCAXIS2PLACEMENT2D", [`#${profilePoint}`, "$"]));
  lines.push(
    serializeEntity(profile, "IFCRECTANGLEPROFILEDEF", [
      ".AREA.",
      "$",
      `#${profileAxis}`,
      ifcReal(width),
      ifcReal(depth),
    ]),
  );
  lines.push(serializeEntity(solidPoint, "IFCCARTESIANPOINT", ["(0.,0.,0.)"]));
  lines.push(serializeEntity(solidAxis, "IFCAXIS2PLACEMENT3D", [`#${solidPoint}`, "$", "$"]));
  lines.push(serializeEntity(direction, "IFCDIRECTION", ["(0.,0.,1.)"]));
  lines.push(
    serializeEntity(solid, "IFCEXTRUDEDAREASOLID", [`#${profile}`, `#${solidAxis}`, `#${direction}`, ifcReal(height)]),
  );
  lines.push(
    serializeEntity(shapeRep, "IFCSHAPEREPRESENTATION", [
      `#${contextId}`,
      ifcString("Body"),
      ifcString("SweptSolid"),
      `(#${solid})`,
    ]),
  );
  lines.push(serializeEntity(productShape, "IFCPRODUCTDEFINITIONSHAPE", ["$", "$", `(#${shapeRep})`]));

  const proxyId = take();
  if (proxyId !== asset.proxyId) throw new Error("O id do proxy de canteiro não bate com o cluster.");
  const proxyArgs = [
    ifcString(asset.globalId),
    ownerHistory,
    ifcOptionalString(asset.name),
    ifcString("Elemento de canteiro"),
    ifcString(VISTA4D_SITE_ASSET),
    `#${placement}`,
    `#${productShape}`,
    ifcString(asset.libraryKey),
  ];
  if (schema !== "IFC2X3") proxyArgs.push(".NOTDEFINED.");
  lines.push(serializeEntity(proxyId, "IFCBUILDINGELEMENTPROXY", proxyArgs));

  const quantityIds: number[] = [];
  const pushQuantity = (type: string, name: string, value: number) => {
    if (!(value > 0)) return;
    const id = take();
    quantityIds.push(id);
    const args = [ifcString(name), "$", "$", ifcReal(value)];
    if (schema !== "IFC2X3") args.push("$");
    lines.push(serializeEntity(id, type, args));
  };
  pushQuantity("IFCQUANTITYCOUNT", "Count", asset.count);
  pushQuantity("IFCQUANTITYLENGTH", "Length", asset.length);
  pushQuantity("IFCQUANTITYVOLUME", "Volume", asset.volume);
  if (quantityIds.length) {
    const setId = take();
    const relId = take();
    lines.push(
      serializeEntity(setId, "IFCELEMENTQUANTITY", [
        ifcString(createIfcGuid()),
        ownerHistory,
        ifcString(QTO_SITE_ASSET),
        ifcString("Quantidades do elemento de canteiro"),
        "$",
        `(${quantityIds.map((id) => `#${id}`).join(",")})`,
      ]),
    );
    lines.push(
      serializeEntity(relId, "IFCRELDEFINESBYPROPERTIES", [
        ifcString(createIfcGuid()),
        ownerHistory,
        "$",
        "$",
        `(#${proxyId})`,
        `#${setId}`,
      ]),
    );
  }

  const siteId =
    firstIdOfType(index, "IFCSITE") ??
    firstIdOfType(index, "IFCBUILDING") ??
    firstIdOfType(index, "IFCBUILDINGSTOREY");
  if (siteId != null) {
    const relId = take();
    lines.push(
      serializeEntity(relId, "IFCRELCONTAINEDINSPATIALSTRUCTURE", [
        ifcString(createIfcGuid()),
        ownerHistory,
        ifcString("Canteiro"),
        "$",
        `(#${proxyId})`,
        `#${siteId}`,
      ]),
    );
  }

  if (cursor !== asset.clusterIds.length) {
    throw new Error("O cluster do elemento de canteiro não foi consumido por inteiro.");
  }
  return lines;
}

function tuple3(x: number, y: number, z: number): string {
  return `(${ifcReal(x)},${ifcReal(y)},${ifcReal(z)})`;
}
