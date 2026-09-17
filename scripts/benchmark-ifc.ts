import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareIfcOnMain } from "../src/ifc/prepareIfc";

const input = process.argv[2] || "public/4D.ifc";
const path = resolve(input);
const before = process.memoryUsage().heapUsed;
const bytes = new Uint8Array(readFileSync(path));
const started = performance.now();
const prepared = prepareIfcOnMain(bytes);
const durationMs = performance.now() - started;
const after = process.memoryUsage().heapUsed;

console.log(
  JSON.stringify(
    {
      file: path,
      sourceMiB: round(bytes.byteLength / 1024 ** 2),
      preparedMiB: round(prepared.bytes.byteLength / 1024 ** 2),
      schema: prepared.schema,
      entities: prepared.index.offset.size,
      prepareMs: round(durationMs),
      heapDeltaMiB: round((after - before) / 1024 ** 2),
    },
    null,
    2,
  ),
);

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
