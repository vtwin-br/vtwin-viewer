import {
  bytesToLatin1,
  detectIfcSchema,
  latin1ToBytes,
  prepareIfcTextForOpen,
  type IfcSchemaKind,
} from "./stepText";
import {
  buildStepIndex,
  deserializeStepIndex,
  emptyStepIndex,
  type StepIndex,
  type StepIndexWire,
} from "./stepIndex";

export interface PreparedIfc {
  bytes: Uint8Array;
  index: StepIndex;
  schema: IfcSchemaKind;
}

interface WorkerOk {
  bytes: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
  index: StepIndexWire;
  schema: IfcSchemaKind;
  error?: undefined;
}

interface WorkerErr {
  error: string;
}

/**
 * Prepara os bytes usados pelo web-ifc e cria o índice do IFC original fora da
 * main thread. Quando `transferOwnership` é true, o ArrayBuffer de entrada é
 * transferido para evitar outra cópia do IFC inteiro.
 */
export async function prepareIfcOffthread(
  buffer: Uint8Array,
  opts: { transferOwnership?: boolean } = {},
): Promise<PreparedIfc> {
  let transferred = false;
  try {
    const wholeBuffer =
      buffer.buffer instanceof ArrayBuffer &&
      buffer.byteOffset === 0 &&
      buffer.byteLength === buffer.buffer.byteLength;
    const payload =
      opts.transferOwnership && wholeBuffer
        ? buffer.buffer
        : buffer.slice().buffer;
    const worker = new Worker(new URL("./prepare.worker.ts", import.meta.url), { type: "module" });
    const result = await new Promise<WorkerOk>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        worker.terminate();
        reject(new Error("prepare-timeout"));
      }, 180_000);
      worker.onmessage = (ev: MessageEvent<WorkerOk | WorkerErr>) => {
        window.clearTimeout(timer);
        worker.terminate();
        const data = ev.data;
        if (!data || ("error" in data && (data as WorkerErr).error)) {
          reject(new Error((data as WorkerErr).error || "prepare-failed"));
          return;
        }
        resolve(data as WorkerOk);
      };
      worker.onerror = (err) => {
        window.clearTimeout(timer);
        worker.terminate();
        reject(err);
      };
      worker.postMessage(payload, [payload]);
      transferred = opts.transferOwnership === true && wholeBuffer;
    });
    const index = deserializeStepIndex(result.index) ?? emptyStepIndex();
    return {
      bytes: new Uint8Array(result.bytes, result.byteOffset, result.byteLength),
      index,
      schema: result.schema,
    };
  } catch (err) {
    console.warn("Worker de prepare IFC indisponível:", err);
    if (transferred) {
      throw new Error("O worker de preparação falhou depois de receber o IFC.", { cause: err });
    }
    return prepareIfcOnMain(buffer);
  }
}

export function prepareIfcOnMain(buffer: Uint8Array): PreparedIfc {
  const originalText = bytesToLatin1(buffer);
  const schema = detectIfcSchema(originalText);
  const preparedText = prepareIfcTextForOpen(originalText);
  return {
    bytes: preparedText === originalText ? buffer : latin1ToBytes(preparedText),
    index: buildStepIndex(originalText),
    schema,
  };
}
