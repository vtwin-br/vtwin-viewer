import { idsOfType, type StepIndex } from "./stepIndex";
import { findEntity, parseStepSetIds, serializeEntity, type IfcSchemaKind, type StepEntity } from "./stepText";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface SurfaceStyleEdit {
  lines: string[];
  replacements: Array<{ start: number; end: number; text: string }>;
}

export function formatHexColor(rgb: Rgb): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

export function parseHexColor(value: string): Rgb | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return null;
  const hex = match[1]!;
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

export function readSurfaceColors(text: string, index: StepIndex): Map<string, Rgb> {
  const colourByItem = new Map<number, Rgb>();
  for (const id of idsOfType(index, "IFCSTYLEDITEM")) {
    const styled = findEntity(text, id, index);
    if (!styled) continue;
    const itemId = firstRef(styled.args[0]);
    const rgb = colourOfStyled(text, index, styled).rgb;
    if (itemId != null && rgb) colourByItem.set(itemId, rgb);
  }
  const out = new Map<string, Rgb>();
  for (const [guid, productId] of index.guidToId) {
    for (const itemId of representationItems(text, index, productId)) {
      const rgb = colourByItem.get(itemId);
      if (!rgb) continue;
      out.set(guid, rgb);
      break;
    }
  }
  return out;
}

export function emitSurfaceStyles(
  text: string,
  index: StepIndex,
  colors: Array<[string, Rgb]>,
  schema: IfcSchemaKind,
  alloc: () => number,
): SurfaceStyleEdit {
  const lines: string[] = [];
  const replacements: SurfaceStyleEdit["replacements"] = [];
  const replaced = new Set<number>();
  const styledItems = new Map<number, StepEntity>();
  for (const id of idsOfType(index, "IFCSTYLEDITEM")) {
    const ent = findEntity(text, id, index);
    const itemId = ent ? firstRef(ent.args[0]) : null;
    if (ent && itemId != null && !styledItems.has(itemId)) styledItems.set(itemId, ent);
  }
  for (const [guid, rgb] of colors) {
    const productId = index.guidToId.get(guid);
    if (productId == null) continue;
    const items = representationItems(text, index, productId);
    if (!items.length) continue;
    for (const itemId of items) {
      const styled = styledItems.get(itemId);
      if (styled) {
        const found = colourOfStyled(text, index, styled);
        if (found.colourId != null && !replaced.has(found.colourId)) {
          const colour = findEntity(text, found.colourId, index);
          if (colour) {
            replaced.add(found.colourId);
            replacements.push({
              start: colour.start,
              end: colour.end,
              text: serializeEntity(colour.expressId, "IFCCOLOURRGB", ["$", real(rgb.r), real(rgb.g), real(rgb.b)]),
            });
          }
        }
        continue;
      }
      const colourId = alloc();
      const renderingId = alloc();
      const styleId = alloc();
      lines.push(serializeEntity(colourId, "IFCCOLOURRGB", ["$", real(rgb.r), real(rgb.g), real(rgb.b)]));
      lines.push(
        serializeEntity(renderingId, "IFCSURFACESTYLERENDERING", [
          `#${colourId}`,
          "0.",
          "$",
          "$",
          "$",
          "$",
          "$",
          "$",
          ".NOTDEFINED.",
        ]),
      );
      lines.push(serializeEntity(styleId, "IFCSURFACESTYLE", ["'Cor'", ".BOTH.", `(#${renderingId})`]));
      if (schema === "IFC2X3") {
        const assignId = alloc();
        lines.push(serializeEntity(assignId, "IFCPRESENTATIONSTYLEASSIGNMENT", [`(#${styleId})`]));
        lines.push(serializeEntity(alloc(), "IFCSTYLEDITEM", [`#${itemId}`, `(#${assignId})`, "$"]));
      } else {
        lines.push(serializeEntity(alloc(), "IFCSTYLEDITEM", [`#${itemId}`, `(#${styleId})`, "$"]));
      }
    }
  }
  return { lines, replacements };
}

function representationItems(text: string, index: StepIndex, productId: number): number[] {
  const product = findEntity(text, productId, index);
  const repId = product ? firstRef(product.args[6]) : null;
  if (repId == null) return [];
  return expandShape(text, index, repId, 0);
}

function expandShape(text: string, index: StepIndex, id: number, depth: number): number[] {
  if (depth > 8) return [];
  const ent = findEntity(text, id, index);
  if (!ent) return [];
  const type = ent.type.toUpperCase();
  if (type === "IFCPRODUCTDEFINITIONSHAPE") {
    return parseStepSetIds(ent.args[2]).flatMap((child) => expandShape(text, index, child, depth + 1));
  }
  if (type === "IFCSHAPEREPRESENTATION" || type === "IFCREPRESENTATION" || type === "IFCTOPOLOGYREPRESENTATION") {
    return parseStepSetIds(ent.args[3]).flatMap((child) => expandItem(text, index, child, depth + 1));
  }
  if (type === "IFCREPRESENTATIONMAP") {
    const mapped = firstRef(ent.args[1]);
    return mapped == null ? [] : expandShape(text, index, mapped, depth + 1);
  }
  return expandItem(text, index, id, depth);
}

function expandItem(text: string, index: StepIndex, id: number, depth: number): number[] {
  const ent = findEntity(text, id, index);
  if (!ent) return [];
  const type = ent.type.toUpperCase();
  if (type === "IFCMAPPEDITEM") {
    const source = firstRef(ent.args[0]);
    const nested = source == null ? [] : expandShape(text, index, source, depth + 1);
    return nested.length ? nested : [id];
  }
  if (type === "IFCBOOLEANRESULT" || type === "IFCBOOLEANCLIPPINGRESULT") {
    const first = firstRef(ent.args[1]);
    return first == null ? [id] : expandItem(text, index, first, depth + 1);
  }
  return [id];
}

function colourOfStyled(
  text: string,
  index: StepIndex,
  styled: StepEntity,
): { rgb: Rgb | null; colourId: number | null } {
  for (const styleId of parseStepSetIds(styled.args[1])) {
    const found = colourOfStyle(text, index, styleId, 0);
    if (found.rgb || found.colourId != null) return found;
  }
  return { rgb: null, colourId: null };
}

function colourOfStyle(
  text: string,
  index: StepIndex,
  id: number,
  depth: number,
): { rgb: Rgb | null; colourId: number | null } {
  if (depth > 6) return { rgb: null, colourId: null };
  const ent = findEntity(text, id, index);
  if (!ent) return { rgb: null, colourId: null };
  const type = ent.type.toUpperCase();
  if (type === "IFCPRESENTATIONSTYLEASSIGNMENT") {
    for (const child of parseStepSetIds(ent.args[0])) {
      const found = colourOfStyle(text, index, child, depth + 1);
      if (found.rgb || found.colourId != null) return found;
    }
  }
  if (type === "IFCSURFACESTYLE") {
    for (const child of parseStepSetIds(ent.args[2])) {
      const found = colourOfStyle(text, index, child, depth + 1);
      if (found.rgb || found.colourId != null) return found;
    }
  }
  if (type === "IFCSURFACESTYLERENDERING" || type === "IFCSURFACESTYLESHADING") {
    const colourId = firstRef(ent.args[0]);
    if (colourId == null) return { rgb: rgbOfInline(ent.args[0]), colourId: null };
    const colour = findEntity(text, colourId, index);
    return { rgb: colour ? rgbOfEntity(colour) : null, colourId };
  }
  if (type === "IFCCOLOURRGB") return { rgb: rgbOfEntity(ent), colourId: ent.expressId };
  return { rgb: null, colourId: null };
}

function rgbOfEntity(ent: StepEntity): Rgb | null {
  const r = Number(ent.args[1]);
  const g = Number(ent.args[2]);
  const b = Number(ent.args[3]);
  if (![r, g, b].every(Number.isFinite)) return null;
  return { r, g, b };
}

function rgbOfInline(arg: string | undefined): Rgb | null {
  if (!arg) return null;
  const match = /IFCCOLOURRGB\([^,]*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/i.exec(arg);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function firstRef(arg: string | undefined): number | null {
  if (!arg) return null;
  const match = /#(\d+)/.exec(arg);
  return match ? Number(match[1]) : null;
}

function real(value: number): string {
  const rounded = Math.round(Math.min(1, Math.max(0, value)) * 1e6) / 1e6;
  return Number.isInteger(rounded) ? `${rounded}.` : String(rounded);
}
