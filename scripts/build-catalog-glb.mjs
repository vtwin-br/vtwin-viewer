/**
 * Gera os GLB do catálogo com primitivas (caixa, cilindro, cone).
 * Sem malhas de terceiros. Correr: node scripts/build-catalog-glb.mjs
 *
 * O guindaste fica modelado com mastro 18 m e lança 12 m.
 * Nós estáveis, para um GLB do Blender ocupar o mesmo slot:
 *   tower-crane, mast, crown, jib, trolley, counterjib
 *   dump-truck
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const MAST_H = 18;
const JIB_L = 12;
const MAST_BASE_Y = 0.45;

const outDir = resolve("public/models");
mkdirSync(outDir, { recursive: true });

const yellow = mat("safety-yellow", 0xf0b429, 0.35, 0.46);
const yellowDark = mat("safety-yellow-deep", 0xc48a12, 0.3, 0.55);
const charcoal = mat("charcoal", 0x243038, 0.55, 0.42);
const concrete = mat("concrete", 0x9a948c, 0.02, 0.9);
const ballast = mat("ballast", 0x3e4850, 0.18, 0.72);
const glass = mat("glass", 0x173044, 0.08, 0.06);
const rubber = mat("rubber", 0x161616, 0, 0.94);
const steel = mat("steel", 0xc5cdd1, 0.78, 0.32);
const bedIn = mat("bed-inside", 0x4a4034, 0.12, 0.78);
const lamp = mat("lamp", 0xf7f1dc, 0.05, 0.28);

const materials = [];
const matIndex = new Map();
function mat(name, hex, metal, rough) {
  return { name, hex, metal, rough };
}
function materialIndex(m) {
  if (matIndex.has(m.name)) return matIndex.get(m.name);
  const i = materials.length;
  const [r, g, b] = srgb(m.hex);
  materials.push({
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: [round4(r), round4(g), round4(b), 1],
      metallicFactor: m.metal,
      roughnessFactor: m.rough,
    },
  });
  matIndex.set(m.name, i);
  return i;
}

function srgb(hex) {
  return [hex >> 16, (hex >> 8) & 255, hex & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}
function cyl(radiusTop, radiusBottom, height, x, y, z, rotX = 0, rotY = 0, rotZ = 0, segments = 16) {
  const g = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
  if (rotX) g.rotateX(rotX);
  if (rotY) g.rotateY(rotY);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  return g;
}
function cone(radius, height, x, y, z, segments = 12) {
  const g = new THREE.ConeGeometry(radius, height, segments);
  g.translate(x, y + height / 2, z);
  return g;
}
function brace(ax, ay, az, bx, by, bz, thickness) {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const len = dir.length();
  if (len < 0.05) return null;
  const g = new THREE.BoxGeometry(thickness, len, thickness);
  const mid = new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

class Bucket {
  constructor() {
    this.lists = new Map();
  }
  add(material, geometry) {
    if (!geometry) return;
    geometry.deleteAttribute("uv");
    const list = this.lists.get(material) ?? [];
    list.push(geometry);
    this.lists.set(material, list);
  }
}

function buildTowerCrane() {
  const base = new Bucket();
  base.add(concrete, box(4.6, 0.4, 4.6, 0, 0.2, 0));
  for (const [x, z] of [
    [1.55, 1.55],
    [1.55, -1.55],
    [-1.55, 1.55],
    [-1.55, -1.55],
  ]) {
    base.add(ballast, box(1.2, 0.72, 1.2, x, 0.76, z));
  }
  base.add(charcoal, box(1.7, 0.18, 1.7, 0, 0.49, 0));

  const mast = new Bucket();
  const half = 0.68;
  const leg = 0.2;
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      mast.add(yellow, box(leg, MAST_H, leg, x, MAST_H / 2, z));
    }
  }
  const bays = 6;
  const bay = MAST_H / bays;
  for (let i = 0; i <= bays; i++) {
    const y = i * bay;
    const band = i === bays ? 0.12 : 0.08;
    mast.add(yellowDark, box(half * 2, band, 0.08, 0, y, half));
    mast.add(yellowDark, box(half * 2, band, 0.08, 0, y, -half));
    mast.add(yellowDark, box(0.08, band, half * 2, half, y, 0));
    mast.add(yellowDark, box(0.08, band, half * 2, -half, y, 0));
  }
  for (let i = 0; i < bays; i++) {
    const y0 = i * bay;
    const y1 = (i + 1) * bay;
    const zig = i % 2 === 0;
    const faces = [
      [half, half, -half, half],
      [half, -half, -half, -half],
      [half, half, half, -half],
      [-half, half, -half, -half],
    ];
    for (const [x0, z0, x1, z1] of faces) {
      const a = zig ? [x0, y0, z0, x1, y1, z1] : [x1, y0, z1, x0, y1, z0];
      mast.add(charcoal, brace(a[0], a[1], a[2], a[3], a[4], a[5], 0.06));
    }
  }

  const crown = new Bucket();
  crown.add(steel, cyl(1.15, 1.15, 0.28, 0, 0.14, 0));
  crown.add(yellow, cyl(0.95, 0.95, 0.22, 0, 0.36, 0));
  crown.add(yellow, box(1.7, 1.55, 1.45, 0.15, 1.25, 1.25));
  crown.add(glass, box(0.08, 0.7, 1.15, 0.98, 1.45, 1.25));
  crown.add(glass, box(1.15, 0.42, 0.06, 0.15, 1.7, 1.96));
  crown.add(charcoal, box(2.1, 1.15, 1.35, -1.35, 0.95, -0.15));
  crown.add(yellow, box(0.28, 2.4, 0.28, 0, 1.7, 0));
  crown.add(yellowDark, cone(0.22, 0.7, 0, 2.9, 0));
  crown.add(steel, cyl(0.08, 0.08, 1.4, 0.55, 2.5, 0, 0, 0, Math.PI / 2.6, 8));
  crown.add(steel, cyl(0.08, 0.08, 1.4, -0.55, 2.5, 0, 0, 0, -Math.PI / 2.6, 8));

  const jib = new Bucket();
  const chord = 0.14;
  jib.add(yellow, box(JIB_L, chord, chord, JIB_L / 2, 1.15, 0));
  jib.add(yellow, box(JIB_L, chord, chord, JIB_L / 2, 0.16, 0.42));
  jib.add(yellow, box(JIB_L, chord, chord, JIB_L / 2, 0.16, -0.42));
  const posts = 6;
  for (let i = 0; i <= posts; i++) {
    const x = (JIB_L * i) / posts;
    jib.add(yellowDark, box(0.07, 1.05, 0.07, x, 0.62, 0.42));
    jib.add(yellowDark, box(0.07, 1.05, 0.07, x, 0.62, -0.42));
    jib.add(yellowDark, box(0.07, 0.07, 0.84, x, 0.16, 0));
    if (i < posts) {
      const x2 = (JIB_L * (i + 1)) / posts;
      jib.add(charcoal, brace(x, 0.16, 0.42, x2, 1.15, 0, 0.05));
      jib.add(charcoal, brace(x, 0.16, -0.42, x2, 1.15, 0, 0.05));
    }
  }
  jib.add(yellow, box(0.18, 0.35, 0.95, JIB_L, 0.35, 0));

  const counter = new Bucket();
  const counterLen = 5.4;
  counter.add(yellow, box(counterLen, chord, chord, -counterLen / 2, 1.05, 0));
  counter.add(yellow, box(counterLen, chord, chord, -counterLen / 2, 0.2, 0.38));
  counter.add(yellow, box(counterLen, chord, chord, -counterLen / 2, 0.2, -0.38));
  for (let i = 1; i <= 3; i++) {
    const x = (-counterLen * i) / 4;
    counter.add(yellowDark, box(0.07, 0.9, 0.07, x, 0.6, 0));
  }
  counter.add(ballast, box(1.15, 0.55, 1.05, -4.55, 0.55, 0));
  counter.add(ballast, box(1.05, 0.45, 0.95, -4.55, 1.05, 0));
  counter.add(charcoal, box(0.9, 0.28, 0.8, -4.55, 1.4, 0));

  const trolley = new Bucket();
  trolley.add(charcoal, box(0.7, 0.28, 0.95, 0, 0.05, 0));
  trolley.add(steel, box(0.22, 0.55, 0.22, 0, -0.35, 0));
  trolley.add(charcoal, cyl(0.04, 0.04, 1.35, 0, -1.15, 0, 0, 0, 0, 8));
  trolley.add(yellowDark, box(0.36, 0.28, 0.36, 0, -1.9, 0));
  trolley.add(steel, cone(0.08, 0.28, 0, -2.18, 0));

  const rootChildren = [
    meshNode("base", base),
    meshNode("mast", mast, [0, MAST_BASE_Y, 0]),
    meshNode("crown", crown, [0, MAST_BASE_Y + MAST_H, 0], [
      meshNode("jib", jib),
      meshNode("counterjib", counter),
      meshNode("trolley", trolley, [JIB_L - 1.6, -0.05, 0]),
    ]),
  ];
  return meshNode("tower-crane", new Bucket(), undefined, rootChildren);
}

function buildDumpTruck() {
  const body = new Bucket();
  body.add(charcoal, box(6.6, 0.28, 0.12, -0.15, 0.78, 0.72));
  body.add(charcoal, box(6.6, 0.28, 0.12, -0.15, 0.78, -0.72));
  body.add(charcoal, box(6.9, 0.16, 1.7, -0.1, 0.68, 0));
  body.add(charcoal, box(0.16, 0.45, 2.2, 3.72, 0.72, 0));
  body.add(lamp, box(0.08, 0.16, 0.28, 3.78, 0.78, 0.7));
  body.add(lamp, box(0.08, 0.16, 0.28, 3.78, 0.78, -0.7));
  body.add(charcoal, box(0.12, 0.55, 1.7, 3.55, 1.15, 0));

  body.add(yellow, box(1.15, 0.72, 2.15, 2.85, 1.28, 0));
  body.add(yellow, box(1.85, 1.55, 2.2, 1.55, 1.85, 0));
  body.add(yellow, box(1.7, 0.12, 2.05, 1.55, 2.68, 0));
  body.add(glass, box(0.08, 0.72, 1.9, 2.46, 2.05, 0));
  body.add(glass, box(0.9, 0.48, 0.06, 1.7, 2.15, 1.12));
  body.add(glass, box(0.9, 0.48, 0.06, 1.7, 2.15, -1.12));
  body.add(charcoal, box(0.18, 0.28, 0.34, 2.15, 2.15, 1.28));
  body.add(charcoal, box(0.18, 0.28, 0.34, 2.15, 2.15, -1.28));
  body.add(steel, cyl(0.07, 0.07, 1.15, 0.85, 2.15, 0.95, 0, 0, 0, 8));

  body.add(charcoal, cyl(0.28, 0.28, 1.5, -0.4, 0.95, -1.15, 0, 0, Math.PI / 2, 12));

  const hingeX = -3.35;
  const hingeY = 1.22;
  const tilt = (16 * Math.PI) / 180;
  const bed = (w, h, d, x, y, z, material) => {
    const g = box(w, h, d, x, y, z);
    g.rotateZ(tilt);
    g.translate(hingeX, hingeY, 0);
    body.add(material, g);
  };
  bed(4.15, 0.1, 2.15, 2.05, 0.08, 0, bedIn);
  bed(0.1, 0.85, 2.15, 0.08, 0.5, 0, yellow);
  bed(4.05, 0.85, 0.08, 2.1, 0.5, 1.04, yellow);
  bed(4.05, 0.85, 0.08, 2.1, 0.5, -1.04, yellow);
  bed(0.08, 0.8, 2.05, 4.08, 0.48, 0, yellowDark);
  body.add(charcoal, cyl(0.07, 0.07, 1.7, -1.15, 1.15, 0.55, 0, 0, -0.7, 8));

  const wheels = new Bucket();
  const rims = new Bucket();
  const axles = [2.45, -1.15, -2.35];
  for (const [index, x] of axles.entries()) {
    const dual = index > 0;
    const zs = dual ? [0.78, 1.12, -0.78, -1.12] : [0.95, -0.95];
    for (const z of zs) {
      wheels.add(rubber, cyl(0.56, 0.56, dual ? 0.3 : 0.36, x, 0.56, z, Math.PI / 2));
      rims.add(steel, cyl(0.28, 0.28, dual ? 0.32 : 0.38, x, 0.56, z, Math.PI / 2));
    }
  }

  return meshNode("dump-truck", new Bucket(), undefined, [
    meshNode("body", body),
    meshNode("wheels", wheels),
    meshNode("rims", rims),
  ]);
}

const binParts = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];
const meshes = [];
const nodes = [];

function align(n) {
  const pad = (n - (byteLength % n)) % n;
  if (!pad) return;
  binParts.push(Buffer.alloc(pad));
  byteLength += pad;
}

function writeBytes(arrayBufferView) {
  align(4);
  const offset = byteLength;
  const buf = Buffer.from(arrayBufferView.buffer, arrayBufferView.byteOffset, arrayBufferView.byteLength);
  binParts.push(buf);
  byteLength += buf.length;
  const view = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
  return view;
}

function primitive(geometry, material) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const index = geometry.index;
  if (!nor) geometry.computeVertexNormals();
  const position = geometry.attributes.position.array;
  const normal = geometry.attributes.normal.array;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    min = min.map((v, k) => Math.min(v, position[i + k]));
    max = max.map((v, k) => Math.max(v, position[i + k]));
  }
  const posView = writeBytes(position);
  const posAcc = accessors.length;
  accessors.push({
    bufferView: posView,
    componentType: 5126,
    count: pos.count,
    type: "VEC3",
    min: min.map(round4),
    max: max.map(round4),
  });
  const norView = writeBytes(normal);
  const norAcc = accessors.length;
  accessors.push({ bufferView: norView, componentType: 5126, count: geometry.attributes.normal.count, type: "VEC3" });
  const indexArray = index ? index.array : null;
  let indicesAcc = null;
  if (indexArray) {
    const src = indexArray instanceof Uint32Array || indexArray.length > 65535 ? Uint32Array.from(indexArray) : Uint16Array.from(indexArray);
    const idxView = writeBytes(src);
    indicesAcc = accessors.length;
    accessors.push({
      bufferView: idxView,
      componentType: src instanceof Uint32Array ? 5125 : 5123,
      count: src.length,
      type: "SCALAR",
    });
  }
  const prim = { attributes: { POSITION: posAcc, NORMAL: norAcc }, material };
  if (indicesAcc != null) prim.indices = indicesAcc;
  return prim;
}

function meshFrom(bucket) {
  const primitives = [];
  for (const [material, geoms] of bucket.lists) {
    const cleaned = geoms.filter(Boolean);
    if (!cleaned.length) continue;
    const merged = cleaned.length === 1 ? cleaned[0] : mergeGeometries(cleaned, false);
    primitives.push(primitive(merged, materialIndex(material)));
  }
  if (!primitives.length) return null;
  const index = meshes.length;
  meshes.push({ primitives });
  return index;
}

function meshNode(name, bucket, translation, children = []) {
  const mesh = bucket ? meshFrom(bucket) : null;
  const node = { name };
  if (mesh != null) node.mesh = mesh;
  if (translation) node.translation = translation.map(round4);
  if (children.length) node.children = children;
  const index = nodes.length;
  nodes.push(node);
  return index;
}

function finish(rootIndex) {
  const json = {
    asset: { version: "2.0", generator: "vtwin-catalog-primitives" },
    scene: 0,
    scenes: [{ nodes: [rootIndex] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const bin = Buffer.concat(binParts);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binChunk.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonChunk, bh, binChunk]);
}

function writeModel(file, root) {
  const bytes = finish(root);
  const path = resolve(outDir, file);
  writeFileSync(path, bytes);
  const names = nodes.map((node) => node.name).filter(Boolean);
  console.log(`${file} ${(bytes.length / 1024).toFixed(0)} KiB · ${names.join(", ")}`);
  reset();
  return names;
}

function reset() {
  binParts.length = 0;
  byteLength = 0;
  bufferViews.length = 0;
  accessors.length = 0;
  meshes.length = 0;
  nodes.length = 0;
  materials.length = 0;
  matIndex.clear();
}

const craneNames = writeModel("tower-crane.glb", buildTowerCrane());
const truckNames = writeModel("dump-truck.glb", buildDumpTruck());

for (const name of ["tower-crane", "mast", "crown", "jib", "trolley", "counterjib"]) {
  if (!craneNames.includes(name)) throw new Error(`O guindaste perdeu o nó ${name}.`);
}
if (!truckNames.includes("dump-truck")) throw new Error("O camião perdeu o nó dump-truck.");
console.log("GLB do catálogo gravados em", outDir);
