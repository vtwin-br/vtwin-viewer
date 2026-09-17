import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as FRAGS from "@thatopen/fragments";
import { configureOpenBimSemanticProfile } from "../src/ifc/semanticProfile";

const input = process.argv[2] || "public/4D.ifc";
const path = resolve(input);
const bytes = new Uint8Array(readFileSync(path));
const importer = new FRAGS.IfcImporter();
importer.wasm.path = `${resolve("node_modules/web-ifc").replace(/\\/g, "/")}/`;
importer.wasm.absolute = true;
configureOpenBimSemanticProfile(importer);

let lastProgress = -1;
const started = performance.now();
const frag = await importer.process({
  bytes,
  progressCallback: (progress, data) => {
    const percent = Math.floor(progress * 100);
    if (percent === lastProgress && data.state === "inProgress") return;
    lastProgress = percent;
    console.log(
      `PROGRESS ${percent}% ${data.process} ${data.state}${
        data.class ? ` ${data.class}` : ""
      }`,
    );
  },
});

console.log(
  JSON.stringify(
    {
      file: path,
      sourceMiB: round(bytes.byteLength / 1024 ** 2),
      fragMiB: round(frag.byteLength / 1024 ** 2),
      durationSeconds: round((performance.now() - started) / 1000),
      heapMiB: round(process.memoryUsage().heapUsed / 1024 ** 2),
      rssMiB: round(process.memoryUsage().rss / 1024 ** 2),
    },
    null,
    2,
  ),
);
process.exit(0);

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
