import { IfcSession } from "../src/ifc/ifcSession";
import { emptySchedule } from "../src/schedule/range";
import { buildStepIndex } from "../src/ifc/stepIndex";
import { packVtwin, unpackVtwin } from "../src/project/pack";
import * as WebIFC from "web-ifc";
import { resolve } from "node:path";
import { detectIfcSchema } from "../src/ifc/stepText";
import { phaseQuantities, sitePhases } from "../src/site/phases";

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
#10=IFCWALL('1111111111111111111111',$,'Parede',$,$,$,$,$,$);
#11=IFCBUILDINGSTOREY('2222222222222222222222',$,'Piso',$,$,$,$,$,$,$);
#12=IFCRELCONTAINEDINSPATIALSTRUCTURE('3333333333333333333333',$,$,$,(#10),#11);
#13=IFCWALL('4444444444444444444444',$,'Parede 2',$,$,$,$,$,$);
#14=IFCBUILDING('5555555555555555555555',$,'Edificio',$,$,$,$,$,$,$,$);
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
await session.upsertProperty("1111111111111111111111", "Pset_WallCommon", "Reference", "W1");
await session.addClassification("1111111111111111111111", {
  identification: "EF_25_10",
  name: "Parede",
  sourceName: "Uniclass",
});
session.addDocumentReference({
  name: "Memorial",
  location: "memorial.pdf",
  identification: "DOC-1",
  description: "PDF de apoio",
});
await session.upsertTable("Quantidades", ["Item", "Qtd"], [["Estaca", "12"]]);
await session.moveSpatial("1111111111111111111111", "5555555555555555555555");
await session.createSearchSet("Paredes", "Tipo=IfcWall");
session.addInterference({
  name: "Paredes sobrepostas",
  relatingGuid: "1111111111111111111111",
  relatedGuid: "4444444444444444444444",
});

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

const placed = session.placeSiteAsset({ libraryKey: "grua", x: 10, y: 4, z: 1, yaw: 0, taskId: first.id });
session.placeSiteAsset({ libraryKey: "vedacao", x: 0, y: 0, z: 1, taskId: second.id });
const phase = sitePhases(session.schedule).find((task) => task.id === first.id);
const qty = phase ? phaseQuantities(session.schedule, session.listSiteAssets(), phase) : [];
if (!qty.some((line) => line.key === "grua" && line.count === 1)) {
  throw new Error("A quantidade da grua não entrou na fase.");
}

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
if (!output.includes("IFCPROPERTYSET") || !output.includes("Pset_WallCommon") || !output.includes("IFCTEXT('W1')")) {
  throw new Error("O IfcPropertySet novo não foi exportado.");
}
if (!output.includes("IFCCLASSIFICATIONREFERENCE") || !output.includes("'EF_25_10'") || !output.includes("IFCCLASSIFICATION")) {
  throw new Error("A IfcClassificationReference não foi exportada.");
}
if (!output.includes("IFCDOCUMENTREFERENCE") || !output.includes("'memorial.pdf'") || !output.includes("IFCRELASSOCIATESDOCUMENT")) {
  throw new Error("O IfcDocumentReference não foi exportado.");
}
if (!output.includes("IFCTABLE") || !output.includes("IFCTABLECOLUMN") || !output.includes("'Quantidades'")) {
  throw new Error("A IfcTable não foi exportada.");
}
if (!output.includes("VISTA4D_SEARCH") || !output.includes("Pset_Vista4dSearch") || !output.includes("'Tipo=IfcWall'")) {
  throw new Error("O search set (IfcGroup + consulta) não foi exportado.");
}
if (!output.includes("IFCRELINTERFERESELEMENTS") || !output.includes("'Paredes sobrepostas'")) {
  throw new Error("A IfcRelInterferesElements não foi exportada.");
}
if (!output.includes("#10") || !/#\d+=IFCRELCONTAINEDINSPATIALSTRUCTURE\([^)]*#10,#14\)/.test(output) && !output.includes("#14")) {
  throw new Error("A mudança de contenção espacial não foi exportada.");
}
if (!output.includes("VISTA4D_SITE_ASSET") || !output.includes("IFCEXTRUDEDAREASOLID") || !output.includes("Qto_Vista4dSiteAsset")) {
  throw new Error("O elemento de canteiro não foi exportado.");
}
if (!output.includes("IFCQUANTITYCOUNT") || !output.includes("IFCQUANTITYLENGTH") || !output.includes("'grua'") || !output.includes("'vedacao'")) {
  throw new Error("As quantidades do canteiro não foram exportadas.");
}
if (!output.includes(`#${placed.proxyId}=IFCBUILDINGELEMENTPROXY`)) {
  throw new Error("O proxy da grua não ficou com o expressId ligado à tarefa.");
}
if (!output.includes(`(#${first.id}),$,#${placed.proxyId})`)) {
  throw new Error("A grua não ficou em IfcRelAssignsToProduct da IfcTask.");
}
if (!new RegExp(`IFCRELCONTAINEDINSPATIALSTRUCTURE\\([^;]*'Canteiro'[^;]*\\(#${placed.proxyId}\\)`).test(output)) {
  throw new Error("A grua não ficou na estrutura espacial.");
}
const again = new IfcSession(output, "out.ifc", emptySchedule());
const reloaded = await again.hydrateSiteAssets();
const crane = reloaded.find((asset) => asset.libraryKey === "grua");
const fence = reloaded.find((asset) => asset.libraryKey === "vedacao");
if (!crane || Math.abs(crane.x - 10) > 1e-4 || crane.count !== 1) {
  throw new Error("A grua não voltou a ser lida do STEP.");
}
if (!fence || fence.length !== 12) {
  throw new Error("A vedação não voltou com o comprimento.");
}
const moved = /IFCRELCONTAINEDINSPATIALSTRUCTURE\([^;]*#10[^;]*#14\)/.test(output);
if (!moved) throw new Error("A parede não passou a estar contida no IfcBuilding.");
if (!output.endsWith("END-ISO-10303-21;\n")) {
  throw new Error("A estrutura STEP final ficou inválida.");
}

const mesh = await packVtwin(
  "Cliente",
  [
    {
      id: "disc-1",
      fileName: "disciplina.ifc",
      schema: "IFC4",
      hash: "abc123",
      visible: true,
      extra: { x: 0, y: 0, z: 0, yaw: 0 },
      ifc: sourceBytes,
      frag: new Uint8Array([1, 2, 3, 4]),
      schedule: emptySchedule(),
      index: buildStepIndex(source),
      role: "discipline",
    },
  ],
  { meshOnly: true },
);
const unpacked = await unpackVtwin(mesh);
if (!unpacked.manifest.meshOnly) throw new Error("O pacote só malha não marcou meshOnly.");
if (unpacked.models[0]?.ifc.byteLength) throw new Error("O pacote só malha ainda traz o STEP.");
if (unpacked.models[0]?.frag?.byteLength !== 4) throw new Error("O pacote só malha perdeu o .frag.");
if (!unpacked.models[0]?.index) throw new Error("O pacote só malha perdeu o índice.");

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
