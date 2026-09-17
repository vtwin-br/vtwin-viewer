import * as FRAGS from "@thatopen/fragments";
import * as WebIFC from "web-ifc";

const ABSTRACT_CLASSES = [
  "IFCWORKPLAN",
  "IFCWORKSCHEDULE",
  "IFCTASK",
  "IFCTASKTIME",
  "IFCSCHEDULETIMECONTROL",
  "IFCGROUP",
  "IFCCOSTSCHEDULE",
  "IFCCOSTITEM",
  "IFCCOSTVALUE",
  "IFCMONETARYUNIT",
  "IFCDOCUMENTINFORMATION",
  "IFCDOCUMENTREFERENCE",
  "IFCCLASSIFICATION",
  "IFCCLASSIFICATIONREFERENCE",
] as const;

/** Relações cujo item STEP também é necessário para o snapshot 4D/5D. */
const RELATION_ENTITY_CLASSES = [
  "IFCRELNESTS",
  "IFCRELASSIGNSTOCONTROL",
  "IFCRELASSIGNSTASKS",
  "IFCRELASSIGNSTOPRODUCT",
  "IFCRELASSIGNSTOPROCESS",
  "IFCRELASSIGNSTOGROUP",
  "IFCRELSEQUENCE",
  "IFCRELDECLARES",
  "IFCRELAGGREGATES",
] as const;

/** Grafo navegável, sem serializar cada relação como entidade abstrata. */
const RELATION_CLASSES = [
  ...RELATION_ENTITY_CLASSES,
  "IFCRELDEFINESBYPROPERTIES",
  "IFCRELDEFINESBYTYPE",
  "IFCRELASSOCIATESCLASSIFICATION",
  "IFCRELASSOCIATESMATERIAL",
  "IFCRELASSOCIATESDOCUMENT",
  "IFCRELCONTAINEDINSPATIALSTRUCTURE",
] as const;

/**
 * Perfil semântico mínimo da aplicação. Evita o custo de addAllAttributes /
 * addAllRelations, mas preserva o grafo usado por propriedades, hierarquia,
 * classificação e 4D/5D.
 */
export function configureOpenBimSemanticProfile(importer: FRAGS.IfcImporter): void {
  for (const name of [...ABSTRACT_CLASSES, ...RELATION_ENTITY_CLASSES]) {
    const type = webIfcType(name);
    if (type != null) importer.classes.abstract.add(type);
  }
  for (const name of RELATION_CLASSES) {
    const type = webIfcType(name);
    if (type == null) continue;
    const relation = FRAGS.ifcRelationsMap.get(type);
    if (relation) importer.relations.set(type, relation);
  }
  importer.includeRelationNames = true;
  importer.includeUniqueAttributes = true;
}

function webIfcType(name: string): number | undefined {
  const value = (WebIFC as unknown as Record<string, unknown>)[name];
  return typeof value === "number" ? value : undefined;
}
