import { IfcSession } from "../src/ifc/ifcSession";
import { emptySchedule } from "../src/schedule/range";
import { buildStepIndex } from "../src/ifc/stepIndex";
import { packVtwin, unpackVtwin } from "../src/project/pack";
import * as WebIFC from "web-ifc";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectIfcSchema } from "../src/ifc/stepText";
import {
  addPlanningLine,
  cutVolume,
  DEFAULT_JIB_LENGTH,
  DEFAULT_MAST_HEIGHT,
  DEFAULT_TERRAIN_DEPTH,
  DEFAULT_TERRAIN_SLOPE,
  emptySitePlan,
  parseSitePlan,
  pathLength,
  sitePlanToJson,
} from "../src/planning/sitePlan";
import { excavationVolume, offsetPolygon } from "../src/planning/polygon";
import { frameFromPairs } from "../src/planning/pdfFrame";
import { pointAlong, sampleKeys } from "../src/planning/playback";
import { bcfHasVersion, emptySidecar } from "../src/project/viewerPack";
import { slidesToPdf } from "../src/project/slidesPdf";

function glbNodeNames(file: string): string[] {
  const buf = readFileSync(file);
  if (buf.toString("utf8", 0, 4) !== "glTF") throw new Error(`${file} não é GLB.`);
  const len = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + len).toString("utf8")) as { nodes?: { name?: string }[] };
  return (json.nodes ?? []).map((node) => node.name ?? "").filter(Boolean);
}

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
#10=IFCWALL('1111111111111111111111',$,'Parede',$,$,$,#34,$,$);
#11=IFCBUILDINGSTOREY('2222222222222222222222',$,'Piso',$,$,$,$,$,$,$);
#12=IFCRELCONTAINEDINSPATIALSTRUCTURE('3333333333333333333333',$,$,$,(#10),#11);
#13=IFCWALL('4444444444444444444444',$,'Parede 2',$,$,$,$,$,$);
#14=IFCBUILDING('5555555555555555555555',$,'Edificio',$,$,$,$,$,$,$,$);
#90=IFCBUILDINGELEMENTPROXY('6666666666666666666666',$,'Grua','Guindaste','VISTA4D_SITE_ASSET',$,$,'grua',$);
#91=IFCRELASSIGNSTOPRODUCT('7777777777777777777777',$,$,$,(#1),$,#90);
#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCCARTESIANPOINT((1.,0.,0.));
#32=IFCPOLYLINE((#30,#31));
#33=IFCSHAPEREPRESENTATION($,'Body','Curve',(#32));
#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
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

session.setSurfaceColor("1111111111111111111111", { r: 0.2, g: 0.4, b: 0.8 });
session.setSurfaceColor("1111111111111111111111", { r: 0.1, g: 0.2, b: 0.3 });

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
if (output.includes("VISTA4D_SITE_ASSET") || output.includes("Qto_Vista4dSiteAsset") || output.includes("'Guindaste'")) {
  throw new Error("O export IFC ainda contém planejamento de obra.");
}
if (!output.includes("/* site-asset #90 IFCBUILDINGELEMENTPROXY */")) {
  throw new Error("O proxy de canteiro antigo não foi retirado do STEP.");
}
if (!output.includes("/* site-asset #91 IFCRELASSIGNSTOPRODUCT */")) {
  throw new Error("A ligação do guindaste à IfcTask não foi retirada do STEP.");
}
const again = new IfcSession(output, "out.ifc", emptySchedule());
const reloaded = await again.hydrateSiteAssets();
if (reloaded.length) throw new Error("O STEP reaberto ainda tem equipamento de canteiro.");
const moved = /IFCRELCONTAINEDINSPATIALSTRUCTURE\([^;]*#10[^;]*#14\)/.test(output);
if (!moved) throw new Error("A parede não passou a estar contida no IfcBuilding.");
if (!output.endsWith("END-ISO-10303-21;\n")) {
  throw new Error("A estrutura STEP final ficou inválida.");
}
const colourCount = output.match(/IFCCOLOURRGB\(/g)?.length ?? 0;
if (colourCount !== 1 || !output.includes("IFCCOLOURRGB($,0.1,0.2,0.3)") || !output.includes("IFCSURFACESTYLE") || !output.includes("IFCSTYLEDITEM")) {
  throw new Error("A cor de apresentação do elemento não ficou única no IFC exportado.");
}

const plan = emptySitePlan();
const line = addPlanningLine(plan, "Guindaste", new Date(2022, 11, 5), new Date(2023, 0, 20));
plan.cranes.push({
  id: "crane-1",
  x: 10,
  y: 4,
  z: 1,
  yaw: 0.5,
  rx: 0.25,
  mastHeight: DEFAULT_MAST_HEIGHT,
  jibLength: DEFAULT_JIB_LENGTH,
  lineId: line.id,
});
plan.trucks.push({
  id: "truck-1",
  catalogId: "dump-truck",
  x: 2,
  y: 0,
  z: 3,
  yaw: 1.2,
  pathId: "path-1",
  duration: 12,
  lineId: line.id,
});
plan.paths.push({
  id: "path-1",
  points: [
    { x: 0, y: 0, z: 0 },
    { x: 8, y: 0, z: 0 },
    { x: 8, y: 6, z: 0 },
  ],
  lineId: line.id,
});
plan.terrains.push({
  id: "terrain-1",
  contour: [
    { x: 0, y: 0, z: 1 },
    { x: 12, y: 0, z: 1 },
    { x: 12, y: 9, z: 1 },
    { x: 0, y: 9, z: 1 },
  ],
  operation: "cut",
  depth: DEFAULT_TERRAIN_DEPTH,
  slope: DEFAULT_TERRAIN_SLOPE,
  color: "#ab12cd",
  slopeColor: "#c4a882",
  lineId: line.id,
});
plan.fences.push({ id: "fence-1", x: 1, y: 2, z: 0, yaw: 0.3, length: 10, panels: 5, lineId: line.id });
plan.drills.push({ id: "drill-1", x: 4, y: 1, z: 0, yaw: 0.2, depth: 7, lineId: line.id });
plan.masses.push({
  id: "mass-1",
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  width: 4,
  depth: 3,
  height: 2,
  sections: 3,
  grow: true,
  lineId: line.id,
});
plan.notes.push({ id: "note-1", x: 3, y: 2, z: 1, text: "Nota de obra", lineId: line.id });
const planAgain = parseSitePlan(sitePlanToJson(plan));
if (planAgain.cranes[0]?.yaw !== 0.5 || planAgain.cranes[0]?.rx !== 0.25 || planAgain.cranes[0]?.catalogId !== "tower-crane" || planAgain.lines[0]?.origin !== "planning") {
  throw new Error("O JSON de planejamento não preservou os parâmetros.");
}
if (planAgain.trucks[0]?.pathId !== "path-1" || planAgain.trucks[0]?.duration !== 12) {
  throw new Error("O JSON de planejamento não preservou o caminho do camião.");
}
if (planAgain.terrains[0]?.color !== "#ab12cd" || planAgain.terrains[0]?.slopeColor !== "#c4a882" || planAgain.fences[0]?.panels !== 5 || planAgain.drills[0]?.depth !== 7 || planAgain.masses[0]?.sections !== 3) {
  throw new Error("O JSON de planejamento não preservou cerca, perfuratriz, volume ou cores do terreno.");
}
if (!(cutVolume(planAgain.terrains[0]!) > 100)) throw new Error("O volume de corte não saiu do polígono.");
if (planAgain.trucks[0]?.catalogId !== "dump-truck" || planAgain.trucks[0]?.yaw !== 1.2) {
  throw new Error("O JSON de planejamento não preservou o camião.");
}
if (Math.abs(pathLength(planAgain.paths[0]!) - 14) > 1e-6) {
  throw new Error("O caminho não preservou a polilinha.");
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
  { meshOnly: true, sitePlan: plan },
);
const unpacked = await unpackVtwin(mesh);
if (!unpacked.manifest.meshOnly) throw new Error("O pacote só malha não marcou meshOnly.");
if (unpacked.models[0]?.ifc.byteLength) throw new Error("O pacote só malha ainda traz o STEP.");
if (unpacked.models[0]?.frag?.byteLength !== 4) throw new Error("O pacote só malha perdeu o .frag.");
if (!unpacked.models[0]?.index) throw new Error("O pacote só malha perdeu o índice.");
const saved = unpacked.sitePlan;
const crane = saved.cranes[0];
const terrain = saved.terrains[0];
const note = saved.notes[0];
if (!crane || crane.x !== 10 || crane.mastHeight !== DEFAULT_MAST_HEIGHT || crane.jibLength !== DEFAULT_JIB_LENGTH || crane.yaw !== 0.5 || crane.catalogId !== "tower-crane") {
  throw new Error("O .vtwin não restaurou o guindaste.");
}
if (saved.trucks[0]?.catalogId !== "dump-truck" || saved.trucks[0]?.x !== 2 || saved.trucks[0]?.yaw !== 1.2) {
  throw new Error("O .vtwin não restaurou o camião.");
}
if (!saved.paths[0] || saved.paths[0].points.length !== 3) throw new Error("O .vtwin não restaurou o caminho.");
if (!terrain || terrain.operation !== "cut" || terrain.depth !== DEFAULT_TERRAIN_DEPTH || terrain.slope !== DEFAULT_TERRAIN_SLOPE || terrain.contour.length !== 4) {
  throw new Error("O .vtwin não restaurou o terreno.");
}
if (!note || note.text !== "Nota de obra" || note.x !== 3) throw new Error("O .vtwin não restaurou a anotação.");
if (saved.lines[0]?.origin !== "planning" || saved.lines[0]?.start !== "2022-12-05") {
  throw new Error("O .vtwin não restaurou a linha de planejamento.");
}

const sidecar = emptySidecar();
sidecar.markups.items.push({
  id: "hatch-1",
  kind: "hatch",
  text: "Hachura norte",
  color: "#8aa4ad",
  points: [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 3, z: 0 },
  ],
  pattern: "diagonal",
  closed: true,
});
sidecar.markups.items.push({ id: "pin-1", kind: "pin", text: "Pin norte", color: "#163540", x: 1, y: 2, z: 0 });
sidecar.markups.pdfs.push({
  id: "pdf-1",
  name: "Planta",
  sheet: 0,
  pageCount: 1,
  opacity: 0.6,
  removeWhite: true,
  color: "#ffffff",
  pdf: "JVBERi0xLjEK",
  pairs: [
    { drawing: { u: 0, v: 0 }, model: { x: 0, y: 0, z: 0 } },
    { drawing: { u: 1, v: 0 }, model: { x: 10, y: 0, z: 0 } },
  ],
  origin: { x: 0, y: 0, z: 0 },
  width: 10,
  aspect: 1,
});
sidecar.keyframes.tracks.push({
  id: "track-1",
  targetId: "truck-1",
  keys: [{ t: 0, pathT: 0 }, { t: 1, pathT: 1 }],
});
sidecar.cameras.cameras.push({ id: "cam-1", name: "Vista obra", x: 1, y: 8, z: 12, tx: 0, ty: 0, tz: 0 });
sidecar.slides.slides.push({ id: "slide-1", name: "Slide 1", comment: "Comentario de obra", x: 1, y: 8, z: 12, tx: 0, ty: 0, tz: 0, image: "" });
sidecar.pours.items.push({
  id: "pour-1",
  guid: "1111111111111111111111",
  sections: 3,
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 6,
  maxY: 0.3,
  maxZ: 4,
});

const full = await packVtwin(
  "Obra",
  [
    {
      id: "disc-1",
      fileName: "disciplina.ifc",
      schema: "IFC4",
      hash: "abc123",
      visible: true,
      extra: { x: 0, y: 0, z: 0, yaw: 0 },
      ifc: bytes,
      frag: new Uint8Array([1, 2, 3, 4]),
      schedule: emptySchedule(),
      index: buildStepIndex(output),
      role: "discipline",
    },
  ],
  { sitePlan: plan, sidecar },
);
const fullOpen = await unpackVtwin(full);
let packedIfc = "";
const packedBytes = fullOpen.models[0]?.ifc ?? new Uint8Array();
for (let index = 0; index < packedBytes.length; index++) packedIfc += String.fromCharCode(packedBytes[index]!);
if (
  packedIfc.includes("VISTA4D_SITE_ASSET") ||
  packedIfc.includes("Nota de obra") ||
  packedIfc.includes("'Guindaste'") ||
  packedIfc.includes("dump-truck") ||
  packedIfc.includes("tower-crane") ||
  packedIfc.includes("Hachura norte") ||
  packedIfc.includes("vtwin-keyframes") ||
  packedIfc.includes("JVBERi0xLjEK") ||
  packedIfc.includes("Comentario de obra")
) {
  throw new Error("O IFC dentro do .vtwin ainda contém planejamento de obra.");
}
if (fullOpen.sidecar.markups.items[0]?.text !== "Hachura norte" || fullOpen.sidecar.markups.items[1]?.kind !== "pin") {
  throw new Error("O .vtwin não restaurou as notas.");
}
if (fullOpen.sidecar.markups.pdfs[0]?.opacity !== 0.6 || fullOpen.sidecar.keyframes.tracks[0]?.keys[1]?.pathT !== 1) {
  throw new Error("O .vtwin não restaurou o PDF ou a animação.");
}
if (fullOpen.sidecar.slides.slides[0]?.comment !== "Comentario de obra" || fullOpen.sidecar.pours.items[0]?.sections !== 3) {
  throw new Error("O .vtwin não restaurou o slide ou a concretagem.");
}
if (!bcfHasVersion(fullOpen.sidecar.bcf)) throw new Error("O zip BCF do pacote não tem versão.");
const grown = offsetPolygon(
  [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
  1,
);
const xs = grown.map((point) => point.x);
if (Math.min(...xs) >= 0 || Math.max(...xs) <= 10) throw new Error("O talude não afastou o polígono.");
if (!(excavationVolume(
  [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
  2,
  45,
) > 200)) {
  throw new Error("O volume de corte ficou curto.");
}
const frame = frameFromPairs(
  { drawing: { u: 0, v: 0 }, model: { x: 0, y: 0, z: 0 } },
  { drawing: { u: 1, v: 0 }, model: { x: 10, y: 0, z: 0 } },
  1,
);
if (!frame || Math.abs(frame.width - 10) > 1e-6 || Math.abs(frame.yaw) > 1e-6) throw new Error("O alinhamento do PDF falhou.");
const sampled = sampleKeys(
  [
    { t: 0, pathT: 0 },
    { t: 1, pathT: 1 },
  ],
  0.5,
);
if (!sampled || Math.abs((sampled.pathT ?? 0) - 0.5) > 1e-6) throw new Error("O keyframe não interpolou.");
const along = pointAlong(
  [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ],
  0.5,
);
if (Math.abs(along.point.x - 5) > 1e-6) throw new Error("O camião não caiu a meio do caminho.");
const pdfBytes = slidesToPdf([{ name: "Slide", comment: "Nota", image: "" }]);
if (pdfBytes[0] !== 0x25 || pdfBytes[1] !== 0x50) throw new Error("O PDF dos slides não abriu.");
const craneNodes = glbNodeNames(resolve("public/models/tower-crane.glb"));
for (const name of ["tower-crane", "mast", "crown", "jib", "trolley"]) {
  if (!craneNodes.includes(name)) throw new Error(`public/models/tower-crane.glb perdeu o nó ${name}.`);
}
const truckNodes = glbNodeNames(resolve("public/models/dump-truck.glb"));
if (!truckNodes.includes("dump-truck")) throw new Error("public/models/dump-truck.glb perdeu o nó dump-truck.");
if (fullOpen.sitePlan.notes[0]?.text !== "Nota de obra") {
  throw new Error("Reabrir o .vtwin perdeu a anotação.");
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
