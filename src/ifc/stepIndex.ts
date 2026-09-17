/** Índice O(1) sobre o STEP: offset por ExpressID, GlobalId e tipo. */

export interface StepIndex {
  /** expressId → índice do `#` no texto. */
  offset: Map<number, number>;
  guidToId: Map<string, number>;
  /** Tipo em maiúsculas → lista de expressIds (ordem de aparição). */
  typeIds: Map<string, number[]>;
  maxId: number;
}

export interface StepIndexWire {
  offset: number[];
  guids: Array<[string, number]>;
  types: Array<[string, number[]]>;
  maxId: number;
}

export function emptyStepIndex(): StepIndex {
  return { offset: new Map(), guidToId: new Map(), typeIds: new Map(), maxId: 0 };
}

export function buildStepIndex(text: string): StepIndex {
  const offset = new Map<number, number>();
  const guidToId = new Map<string, number>();
  const typeIds = new Map<string, number[]>();
  let maxId = 0;
  const re = /#(\d+)\s*=\s*([A-Z][A-Z0-9]*)\s*\(\s*(?:'([0-9A-Za-z_$]{22})')?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const id = Number(m[1]);
    const type = m[2]!.toUpperCase();
    offset.set(id, m.index);
    if (id > maxId) maxId = id;
    const list = typeIds.get(type);
    if (list) list.push(id);
    else typeIds.set(type, [id]);
    const guid = m[3];
    if (guid && !guidToId.has(guid)) guidToId.set(guid, id);
  }
  return { offset, guidToId, typeIds, maxId };
}

export function serializeStepIndex(index: StepIndex): StepIndexWire {
  const offset: number[] = [];
  for (const [id, start] of index.offset) {
    offset.push(id, start);
  }
  return {
    offset,
    guids: [...index.guidToId],
    types: [...index.typeIds],
    maxId: index.maxId,
  };
}

export function deserializeStepIndex(wire: StepIndexWire | null | undefined): StepIndex | null {
  if (!wire || !Array.isArray(wire.offset)) return null;
  const offset = new Map<number, number>();
  for (let i = 0; i + 1 < wire.offset.length; i += 2) {
    offset.set(wire.offset[i]!, wire.offset[i + 1]!);
  }
  return {
    offset,
    guidToId: new Map(wire.guids ?? []),
    typeIds: new Map(wire.types ?? []),
    maxId: wire.maxId ?? 0,
  };
}

export function firstIdOfType(index: StepIndex, type: string): number | undefined {
  return index.typeIds.get(type.toUpperCase())?.[0];
}

export function idsOfType(index: StepIndex, type: string): number[] {
  return index.typeIds.get(type.toUpperCase()) ?? [];
}
