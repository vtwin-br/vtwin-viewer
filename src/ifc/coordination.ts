import { emptySchedule } from "../schedule/range";
import { hasGeographicAnchor } from "./georef";
import { hashIfcBytes } from "./fragCache";
import {
  buildCoordinationIfc,
  COORDINATION_FILE_NAME,
  COORDINATION_MODEL_ID,
} from "./coordinationIfc";
import { IfcSession } from "./ifcSession";
import { firstIdOfType, buildStepIndex } from "./stepIndex";
import { saveIfcBytes } from "./stepStore";
import { bytesToLatin1 } from "./stepText";

export { COORDINATION_FILE_NAME, COORDINATION_MODEL_ID, buildCoordinationIfc };

export function createCoordinationSession(projectName: string): IfcSession {
  const bytes = buildCoordinationIfc(projectName);
  const text = bytesToLatin1(bytes);
  const index = buildStepIndex(text);
  const schedule = emptySchedule();
  const label = projectName.trim() || "Coordenação";
  schedule.name = label;
  schedule.workPlanName = label;
  schedule.projectId = firstIdOfType(index, "IFCPROJECT");
  return new IfcSession(bytes, COORDINATION_FILE_NAME, schedule, {
    index,
    schema: "IFC4",
  });
}

export async function persistCoordinationSession(session: IfcSession): Promise<string> {
  session.markPlanningForExport();
  const bytes =
    session.dirty || session.schedule.roots.length > 0
      ? await session.exportBytes()
      : session.stepTextBytes();
  const hash = await hashIfcBytes(bytes);
  await saveIfcBytes(hash, bytes);
  session.attachStore(hash);
  return hash;
}

/** Copia o grafo 4D/5D mais rico das disciplinas para a COORD vazia. */
export function seedCoordinationFromDisciplines(coord: IfcSession, sources: IfcSession[]): void {
  if (coord.schedule.roots.length) return;
  const withTasks = sources
    .filter((s) => s.schedule.roots.length)
    .sort((a, b) => b.schedule.byId.size - a.schedule.byId.size);
  const richest = withTasks[0];
  if (richest) {
    coord.adoptPlanningFrom(richest.schedule, { keepExternalProducts: true });
  }
  if (!hasGeographicAnchor(coord.schedule.georef)) {
    const geo = sources.find((s) => hasGeographicAnchor(s.schedule.georef))?.schedule.georef;
    if (geo) coord.schedule.georef = { ...geo };
  }
  if (!coord.getSiteLimit()) {
    const site = sources.find((s) => s.getSiteLimit())?.getSiteLimit();
    if (site) coord.setSiteLimit(site);
  }
}
