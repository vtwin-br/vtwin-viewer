import {
  bytesToLatin1,
  detectIfcSchema,
  latin1ToBytes,
  prepareIfcTextForOpen,
  type IfcSchemaKind,
} from "./stepText";
import { buildStepIndex, serializeStepIndex, type StepIndexWire } from "./stepIndex";

export interface PrepareWorkerResult {
  bytes: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
  index: StepIndexWire;
  schema: IfcSchemaKind;
}

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const input = new Uint8Array(event.data);
    const originalText = bytesToLatin1(input);
    const schema = detectIfcSchema(originalText);
    const index = serializeStepIndex(buildStepIndex(originalText));
    const preparedText = prepareIfcTextForOpen(originalText);
    const prepared = preparedText === originalText ? input : latin1ToBytes(preparedText);
    const result: PrepareWorkerResult = {
      bytes: prepared.buffer as ArrayBuffer,
      byteOffset: prepared.byteOffset,
      byteLength: prepared.byteLength,
      index,
      schema,
    };
    self.postMessage(result, { transfer: [result.bytes] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ error: message });
  }
};
