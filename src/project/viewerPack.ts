import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { PlanPoint } from "../planning/sitePlan";
import type { PdfPair } from "../planning/pdfFrame";

export interface AnimKey {
  t: number;
  rx?: number;
  ry?: number;
  rz?: number;
  mastHeight?: number;
  jibLength?: number;
  hook?: number;
  pathT?: number;
}

export const CAMERAS_PATH = "view/cameras.json";
export const MARKUPS_PATH = "view/markups.json";
export const KEYFRAMES_PATH = "animation/keyframes.json";
export const POURS_PATH = "animation/pours.json";
export const SLIDES_PATH = "view/slides.json";
export const BCF_PATH = "bcf/topics.bcfzip";

export const CAMERAS_FORMAT = "vtwin-cameras";
export const MARKUPS_FORMAT = "vtwin-markups";
export const KEYFRAMES_FORMAT = "vtwin-keyframes";
export const POURS_FORMAT = "vtwin-pours";
export const SLIDES_FORMAT = "vtwin-slides";
export const PACK_DOC_VERSION = 1;

export interface SavedCamera {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
}

export interface CameraDoc {
  format: typeof CAMERAS_FORMAT;
  version: typeof PACK_DOC_VERSION;
  cameras: SavedCamera[];
}

export type MarkupKind = "hatch" | "polygon" | "pin" | "textbox" | "balloon";
export type HatchPattern = "diagonal" | "cross" | "horizontal" | "solid";

export interface MarkupItem {
  id: string;
  kind: MarkupKind;
  modelId?: string;
  text: string;
  color: string;
  x?: number;
  y?: number;
  z?: number;
  points?: PlanPoint[];
  pattern?: HatchPattern;
  width?: number;
  height?: number;
  scale?: number;
  closed?: boolean;
}

export interface PdfOverlay {
  id: string;
  modelId?: string;
  name: string;
  sheet: number;
  pageCount: number;
  opacity: number;
  removeWhite: boolean;
  color: string;
  /** PDF em base64, sem prefixo. */
  pdf: string;
  pairs: PdfPair[];
  origin?: PlanPoint;
  width?: number;
  aspect?: number;
}

export interface MarkupDoc {
  format: typeof MARKUPS_FORMAT;
  version: typeof PACK_DOC_VERSION;
  items: MarkupItem[];
  pdfs: PdfOverlay[];
}

export interface AnimTrack {
  id: string;
  targetId: string;
  keys: AnimKey[];
}

export interface KeyframeDoc {
  format: typeof KEYFRAMES_FORMAT;
  version: typeof PACK_DOC_VERSION;
  tracks: AnimTrack[];
}

export interface PourItem {
  id: string;
  guid: string;
  modelId?: string;
  sections: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface PourDoc {
  format: typeof POURS_FORMAT;
  version: typeof PACK_DOC_VERSION;
  items: PourItem[];
}

export interface SlideShot {
  id: string;
  name: string;
  comment: string;
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  /** JPEG em base64, sem prefixo. Pode ficar vazio num comentário só de texto. */
  image: string;
}

export interface SlideDoc {
  format: typeof SLIDES_FORMAT;
  version: typeof PACK_DOC_VERSION;
  slides: SlideShot[];
}

export interface ViewerSidecar {
  cameras: CameraDoc;
  markups: MarkupDoc;
  keyframes: KeyframeDoc;
  pours: PourDoc;
  slides: SlideDoc;
  bcf: Uint8Array;
}

export function emptyCameraDoc(): CameraDoc {
  return { format: CAMERAS_FORMAT, version: PACK_DOC_VERSION, cameras: [] };
}

export function emptyMarkupDoc(): MarkupDoc {
  return { format: MARKUPS_FORMAT, version: PACK_DOC_VERSION, items: [], pdfs: [] };
}

export function emptyKeyframeDoc(): KeyframeDoc {
  return { format: KEYFRAMES_FORMAT, version: PACK_DOC_VERSION, tracks: [] };
}

export function emptyBcfZip(): Uint8Array {
  return zipSync({
    "bcf.version": strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1"/>\n`),
  });
}

export function emptyPourDoc(): PourDoc {
  return { format: POURS_FORMAT, version: PACK_DOC_VERSION, items: [] };
}

export function emptySlideDoc(): SlideDoc {
  return { format: SLIDES_FORMAT, version: PACK_DOC_VERSION, slides: [] };
}

export function emptySidecar(): ViewerSidecar {
  return {
    cameras: emptyCameraDoc(),
    markups: emptyMarkupDoc(),
    keyframes: emptyKeyframeDoc(),
    pours: emptyPourDoc(),
    slides: emptySlideDoc(),
    bcf: emptyBcfZip(),
  };
}

export function sidecarHasContent(side: ViewerSidecar): boolean {
  return (
    side.cameras.cameras.length > 0 ||
    side.markups.items.length > 0 ||
    side.markups.pdfs.length > 0 ||
    side.keyframes.tracks.length > 0 ||
    side.pours.items.length > 0 ||
    side.slides.slides.length > 0
  );
}

export function cloneSidecar(side: ViewerSidecar): ViewerSidecar {
  return {
    cameras: parseCameraDoc(JSON.parse(JSON.stringify(side.cameras))),
    markups: parseMarkupDoc(JSON.parse(JSON.stringify(side.markups))),
    keyframes: parseKeyframeDoc(JSON.parse(JSON.stringify(side.keyframes))),
    pours: parsePourDoc(JSON.parse(JSON.stringify(side.pours))),
    slides: parseSlideDoc(JSON.parse(JSON.stringify(side.slides))),
    bcf: side.bcf.slice(),
  };
}

export function sidecarFiles(side: ViewerSidecar): Record<string, Uint8Array> {
  return {
    [CAMERAS_PATH]: strToU8(JSON.stringify(side.cameras, null, 2)),
    [MARKUPS_PATH]: strToU8(JSON.stringify(side.markups, null, 2)),
    [KEYFRAMES_PATH]: strToU8(JSON.stringify(side.keyframes, null, 2)),
    [POURS_PATH]: strToU8(JSON.stringify(side.pours, null, 2)),
    [SLIDES_PATH]: strToU8(JSON.stringify(side.slides, null, 2)),
    [BCF_PATH]: side.bcf.byteLength ? side.bcf : emptyBcfZip(),
  };
}

export function readSidecar(files: Record<string, Uint8Array>): ViewerSidecar {
  const side = emptySidecar();
  const cameras = files[CAMERAS_PATH];
  const markups = files[MARKUPS_PATH];
  const keys = files[KEYFRAMES_PATH];
  const pours = files[POURS_PATH];
  const slides = files[SLIDES_PATH];
  const bcf = files[BCF_PATH];
  if (cameras) side.cameras = parseCameraDoc(JSON.parse(strFromU8(cameras)));
  if (markups) side.markups = parseMarkupDoc(JSON.parse(strFromU8(markups)));
  if (keys) side.keyframes = parseKeyframeDoc(JSON.parse(strFromU8(keys)));
  if (pours) side.pours = parsePourDoc(JSON.parse(strFromU8(pours)));
  if (slides) side.slides = parseSlideDoc(JSON.parse(strFromU8(slides)));
  if (bcf?.byteLength) side.bcf = bcf;
  return side;
}

export function bcfHasVersion(bytes: Uint8Array): boolean {
  try {
    const files = unzipSync(bytes);
    return Boolean(files["bcf.version"]?.byteLength);
  } catch {
    return false;
  }
}

export function parseCameraDoc(raw: unknown): CameraDoc {
  const doc = emptyCameraDoc();
  if (!raw || typeof raw !== "object") return doc;
  const j = raw as Partial<CameraDoc>;
  if (j.format !== CAMERAS_FORMAT || j.version !== PACK_DOC_VERSION) return doc;
  for (const item of asArray(j.cameras)) {
    if (!item || typeof item !== "object") continue;
    const cam = item as Partial<SavedCamera>;
    if (typeof cam.id !== "string" || !cam.id) continue;
    const nums = [cam.x, cam.y, cam.z, cam.tx, cam.ty, cam.tz].map(Number);
    if (!nums.every(Number.isFinite)) continue;
    doc.cameras.push({
      id: cam.id,
      name: typeof cam.name === "string" && cam.name.trim() ? cam.name.trim() : "Vista",
      x: nums[0]!,
      y: nums[1]!,
      z: nums[2]!,
      tx: nums[3]!,
      ty: nums[4]!,
      tz: nums[5]!,
    });
  }
  return doc;
}

export function parseMarkupDoc(raw: unknown): MarkupDoc {
  const doc = emptyMarkupDoc();
  if (!raw || typeof raw !== "object") return doc;
  const j = raw as Partial<MarkupDoc>;
  if (j.format !== MARKUPS_FORMAT || j.version !== PACK_DOC_VERSION) return doc;
  for (const item of asArray(j.items)) {
    const markup = readMarkup(item);
    if (markup) doc.items.push(markup);
  }
  for (const item of asArray(j.pdfs)) {
    const pdf = readPdf(item);
    if (pdf) doc.pdfs.push(pdf);
  }
  return doc;
}

export function parsePourDoc(raw: unknown): PourDoc {
  const doc = emptyPourDoc();
  if (!raw || typeof raw !== "object") return doc;
  const j = raw as Partial<PourDoc>;
  if (j.format !== POURS_FORMAT || j.version !== PACK_DOC_VERSION) return doc;
  for (const item of asArray(j.items)) {
    if (!item || typeof item !== "object") continue;
    const pour = item as Partial<PourItem>;
    if (typeof pour.id !== "string" || !pour.id || typeof pour.guid !== "string" || !pour.guid) continue;
    const nums = [pour.minX, pour.minY, pour.minZ, pour.maxX, pour.maxY, pour.maxZ].map(Number);
    if (!nums.every(Number.isFinite)) continue;
    const sections = Math.max(1, Math.round(Number(pour.sections) || 1));
    doc.items.push({
      id: pour.id,
      guid: pour.guid,
      modelId: typeof pour.modelId === "string" ? pour.modelId : undefined,
      sections,
      minX: nums[0]!,
      minY: nums[1]!,
      minZ: nums[2]!,
      maxX: nums[3]!,
      maxY: nums[4]!,
      maxZ: nums[5]!,
    });
  }
  return doc;
}

export function parseSlideDoc(raw: unknown): SlideDoc {
  const doc = emptySlideDoc();
  if (!raw || typeof raw !== "object") return doc;
  const j = raw as Partial<SlideDoc>;
  if (j.format !== SLIDES_FORMAT || j.version !== PACK_DOC_VERSION) return doc;
  for (const item of asArray(j.slides)) {
    if (!item || typeof item !== "object") continue;
    const slide = item as Partial<SlideShot>;
    if (typeof slide.id !== "string" || !slide.id) continue;
    const nums = [slide.x, slide.y, slide.z, slide.tx, slide.ty, slide.tz].map(Number);
    if (!nums.every(Number.isFinite)) continue;
    doc.slides.push({
      id: slide.id,
      name: typeof slide.name === "string" && slide.name.trim() ? slide.name.trim() : "Slide",
      comment: typeof slide.comment === "string" ? slide.comment : "",
      x: nums[0]!,
      y: nums[1]!,
      z: nums[2]!,
      tx: nums[3]!,
      ty: nums[4]!,
      tz: nums[5]!,
      image: typeof slide.image === "string" ? slide.image : "",
    });
  }
  return doc;
}

export function parseKeyframeDoc(raw: unknown): KeyframeDoc {
  const doc = emptyKeyframeDoc();
  if (!raw || typeof raw !== "object") return doc;
  const j = raw as Partial<KeyframeDoc>;
  if (j.format !== KEYFRAMES_FORMAT || j.version !== PACK_DOC_VERSION) return doc;
  for (const item of asArray(j.tracks)) {
    if (!item || typeof item !== "object") continue;
    const track = item as Partial<AnimTrack>;
    if (typeof track.id !== "string" || !track.id || typeof track.targetId !== "string" || !track.targetId) continue;
    const keys: AnimKey[] = [];
    for (const key of asArray(track.keys)) {
      const parsed = readKey(key);
      if (parsed) keys.push(parsed);
    }
    doc.tracks.push({ id: track.id, targetId: track.targetId, keys });
  }
  return doc;
}

function readMarkup(raw: unknown): MarkupItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<MarkupItem>;
  if (typeof item.id !== "string" || !item.id) return null;
  if (item.kind !== "hatch" && item.kind !== "polygon" && item.kind !== "pin" && item.kind !== "textbox" && item.kind !== "balloon") {
    return null;
  }
  const points = asArray(item.points).map(readPoint).filter((point): point is PlanPoint => point != null);
  return {
    id: item.id,
    kind: item.kind,
    modelId: typeof item.modelId === "string" ? item.modelId : undefined,
    text: typeof item.text === "string" ? item.text : "",
    color: readColor(item.color) ?? defaultMarkupColor(item.kind),
    x: finite(item.x),
    y: finite(item.y),
    z: finite(item.z),
    points: points.length ? points : undefined,
    pattern: readPattern(item.pattern),
    width: finite(item.width),
    height: finite(item.height),
    scale: finite(item.scale),
    closed: item.closed === false ? false : item.kind === "hatch" || item.kind === "polygon" ? true : undefined,
  };
}

function readPdf(raw: unknown): PdfOverlay | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<PdfOverlay>;
  if (typeof item.id !== "string" || !item.id || typeof item.pdf !== "string") return null;
  const pairs: PdfPair[] = [];
  for (const pair of asArray(item.pairs)) {
    if (!pair || typeof pair !== "object") continue;
    const row = pair as Partial<PdfPair>;
    const drawing = row.drawing;
    const model = readPoint(row.model);
    if (!drawing || !model) continue;
    const u = Number(drawing.u);
    const v = Number(drawing.v);
    if (![u, v].every(Number.isFinite)) continue;
    pairs.push({ drawing: { u, v }, model });
  }
  const origin = readPoint(item.origin);
  return {
    id: item.id,
    modelId: typeof item.modelId === "string" ? item.modelId : undefined,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "PDF",
    sheet: Math.max(0, Math.floor(Number(item.sheet) || 0)),
    pageCount: Math.max(1, Math.floor(Number(item.pageCount) || 1)),
    opacity: clamp(Number(item.opacity), 0.05, 1, 0.85),
    removeWhite: item.removeWhite === true,
    color: readColor(item.color) ?? "#ffffff",
    pdf: item.pdf,
    pairs,
    origin: origin ?? undefined,
    width: finite(item.width),
    aspect: finite(item.aspect),
  };
}

function readKey(raw: unknown): AnimKey | null {
  if (!raw || typeof raw !== "object") return null;
  const key = raw as Partial<AnimKey>;
  const t = Number(key.t);
  if (!Number.isFinite(t)) return null;
  return {
    t: Math.min(1, Math.max(0, t)),
    rx: finite(key.rx),
    ry: finite(key.ry),
    rz: finite(key.rz),
    mastHeight: finite(key.mastHeight),
    jibLength: finite(key.jibLength),
    hook: finite(key.hook),
    pathT: finite(key.pathT),
  };
}

function readPoint(raw: unknown): PlanPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const point = raw as Partial<PlanPoint>;
  const x = Number(point.x);
  const y = Number(point.y);
  const z = Number(point.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function readPattern(raw: unknown): HatchPattern | undefined {
  if (raw === "diagonal" || raw === "cross" || raw === "horizontal" || raw === "solid") return raw;
  return undefined;
}

function defaultMarkupColor(kind: MarkupKind): string {
  if (kind === "hatch" || kind === "polygon") return "#8aa4ad";
  if (kind === "textbox") return "#071820";
  return "#163540";
}

export function readColor(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
}

function finite(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function clamp(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
