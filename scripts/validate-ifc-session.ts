import { IfcSession } from "../src/ifc/ifcSession";
import { emptySchedule } from "../src/schedule/range";
import * as WebIFC from "web-ifc";
import { resolve } from "node:path";
import { detectIfcSchema } from "../src/ifc/stepText";

const projectGuid = "0000000000000000000000";
if (detectIfcSchema("FILE_SCHEMA(('IFC2X3'));") !== "IFC2X3") throw new Error("Adaptador IFC2X3 inválido.");
if (detectIfcSchema("FILE_SCHEMA(('IFC4'));") !== "IFC4") throw new Error("Adaptador IFC4 inválido.");
if (detectIfcSchema("FILE_SCHEMA(('IFC4X3_ADD2'));") !== "IFC4X3") throw new Error("Adaptador IFC4.3 inválido.");
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('validation.ifc','2026-09-14T00:00:00',(),(),$,$,$);
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${projectGuid}',$,'Projeto',$,$,$,$,$,$);
#2=IFCPROPERTYSINGLEVALUE('Codigo',$,IFCLABEL('A'),$);
ENDSEC;
END-ISO-10303-21;
`;

const session = new IfcSession(source, "validation.ifc", emptySchedule());
session.setElementName(projectGuid, "Projeto alterado");
session.setPropertySingleValue(2, "B");

session.ensureWorkSchedule("Cronograma");
const start = new Date(2026, 0, 1);
const first = session.createTask({ name: "Fundacao", start, end: new Date(2026, 0, 10) });
const second = session.createTask({ name: "Estrutura", start: new Date(2026, 0, 10), end: new Date(2026, 0, 20) });
session.linkSequence(first.id, second.id, "FS", 2);
session.setSiteLimit({
  globalId: "",
  name: "Canteiro",
  points: [
    { x: 0, y: 0, z: 1 },
    { x: 12, y: 0, z: 1 },
    { x: 12, y: 9, z: 1 },
    { x: 0, y: 9, z: 1 },
  ],
  clipBelow: 40,
  clipAbove: 80,
  clipBuffer: 4,
  showPlateau: true,
});

const sourceBytes = new Uint8Array(source.length);
for (let index = 0; index < source.length; index++) sourceBytes[index] = source.charCodeAt(index);
const snapshot = structuredClone(session.createExportSnapshot());
const workerSession = IfcSession.fromExportSnapshot(sourceBytes, snapshot);
const bytes = await workerSession.exportBytesOnCurrentThread();
let output = "";
for (let index = 0; index < bytes.length; index++) {
  output += String.fromCharCode(bytes[index]!);
}

if (!output.includes("'Projeto alterado'")) {
  throw new Error("A alteração de IfcRoot.Name não foi exportada.");
}
if (!output.includes("IFCLABEL('B')")) {
  throw new Error("A alteração de IfcPropertySingleValue não foi exportada.");
}
if (!output.includes("IFCRELSEQUENCE")) {
  throw new Error("A ligação IfcRelSequence não foi exportada.");
}
if (!output.includes("IFCLAGTIME")) {
  throw new Error("A folga IfcLagTime não foi exportada.");
}
if (!output.includes(".FINISH_START.")) {
  throw new Error("O SequenceType FS não foi exportado.");
}
if (!output.includes("IFCANNOTATION") || !output.includes("VISTA4D_SITE_LIMIT")) {
  throw new Error("O limite de canteiro (IfcAnnotation) não foi exportado.");
}
if (!output.includes("Pset_Vista4dSiteLimit") || !output.includes("IFCPOLYLINE")) {
  throw new Error("A polilinha / Pset do canteiro não foi exportada.");
}
if (!output.endsWith("END-ISO-10303-21;\n")) {
  throw new Error("A estrutura STEP final ficou inválida.");
}

const api = new WebIFC.IfcAPI();
api.SetWasmPath(`${resolve("node_modules/web-ifc").replace(/\\/g, "/")}/`, true);
await api.Init();
const modelId = api.OpenModel(bytes);
try {
  const project = api.GetLine(modelId, 1) as { Name?: { value?: string } };
  if (project?.Name?.value !== "Projeto alterado") {
    throw new Error("O IFC reaberto não preservou a alteração do projeto.");
  }
  const property = api.GetLine(modelId, 2) as {
    NominalValue?: { value?: string };
  };
  if (property?.NominalValue?.value !== "B") {
    throw new Error("O IFC reaberto não preservou a propriedade.");
  }
} finally {
  api.CloseModel(modelId);
}

console.log("IfcSession: round-trip semântico validado.");
