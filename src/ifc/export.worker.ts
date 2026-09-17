import { IfcSession, type IfcSessionExportSnapshot } from "./ifcSession";
import { serializeStepIndex } from "./stepIndex";
import * as WebIFC from "web-ifc";

interface ExportWorkerRequest {
  source: ArrayBuffer;
  snapshot: IfcSessionExportSnapshot;
}

self.onmessage = async (event: MessageEvent<ExportWorkerRequest>) => {
  try {
    const session = IfcSession.fromExportSnapshot(
      new Uint8Array(event.data.source),
      event.data.snapshot,
    );
    const bytes = await session.exportBytesOnCurrentThread();
    if (event.data.snapshot.wasmPath) {
      await validateWithWebIfc(bytes, event.data.snapshot.wasmPath);
    }
    const result = {
      bytes: bytes.buffer as ArrayBuffer,
      index: serializeStepIndex(session.stepIndex),
    };
    self.postMessage(result, { transfer: [result.bytes] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ error: message });
  }
};

async function validateWithWebIfc(bytes: Uint8Array, wasmPath: string): Promise<void> {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath(wasmPath, true);
  await api.Init();
  let modelId: number | null = null;
  try {
    modelId = api.OpenModel(bytes);
    if (!Number.isInteger(modelId) || modelId < 0) {
      throw new Error("web-ifc rejeitou o modelo.");
    }
    const projects = api.GetLineIDsWithType(modelId, WebIFC.IFCPROJECT);
    if (projects.size() === 0) throw new Error("O IFC exportado não contém IfcProject.");
  } catch (error) {
    throw new Error(
      `O IFC exportado não passou na validação web-ifc: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (modelId != null) api.CloseModel(modelId);
  }
}
