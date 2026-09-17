import { createIfcGuid, ifcString, latin1ToBytes } from "./stepText";

export const COORDINATION_FILE_NAME = "COORD.ifc";
export const COORDINATION_MODEL_ID = "vtwin-coord";

/**
 * IFC4 mínimo: Project + Site, sem geometria de obra.
 * Serve de dono do WorkPlan / custo / canteiro na federação.
 */
export function buildCoordinationIfc(projectName: string): Uint8Array {
  const name = projectName.trim() || "Coordenação";
  const stamp = isoStamp(new Date());
  const g = () => ifcString(createIfcGuid());
  const n = ifcString(name);
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('COORD.ifc','${stamp}',('vtwin'),('vtwin'),'vtwin','vtwin','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,$,'vtwin',$,$,$,$,$);
#2=IFCORGANIZATION($,'vtwin',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'0.1','vtwin','vtwin');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#8=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#9=IFCUNITASSIGNMENT((#6,#7,#8));
#10=IFCDIRECTION((1.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#12,#11,#10);
#14=IFCDIRECTION((0.,1.));
#15=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#13,#14);
#16=IFCPROJECT(${g()},#5,${n},'IFC de coordenação vtwin',$,$,$,(#15),#9);
#17=IFCLOCALPLACEMENT($,#13);
#18=IFCSITE(${g()},#5,'Sítio','Canteiro',$,#17,$,$,.ELEMENT.,$,$,$,$,$);
#19=IFCRELAGGREGATES(${g()},#5,$,$,#16,(#18));
ENDSEC;
END-ISO-10303-21;
`;
  return latin1ToBytes(text);
}

function isoStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
