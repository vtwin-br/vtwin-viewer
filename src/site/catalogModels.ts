/**
 * Slots estáveis do catálogo de obra. O GLB é só o visual.
 * Trocar o modelo do Blender é substituir o ficheiro no mesmo caminho.
 *
 * O guindaste está modelado com mastro de 18 m e lança de 12 m.
 * O viewer mexe nestes nós, sem gravar a malha:
 *   mast (escala Y), crown (sobe com o mastro), jib (escala X), trolley (acompanha a ponta)
 */
export const TOWER_CRANE_ID = "tower-crane";
export const DUMP_TRUCK_ID = "dump-truck";

export interface CatalogSlot {
  id: string;
  file: string;
  kind: "crane" | "truck";
}

export const CATALOG_SLOTS: Record<string, CatalogSlot> = {
  [TOWER_CRANE_ID]: { id: TOWER_CRANE_ID, file: "tower-crane.glb", kind: "crane" },
  [DUMP_TRUCK_ID]: { id: DUMP_TRUCK_ID, file: "dump-truck.glb", kind: "truck" },
};

export function catalogSlot(id: string | undefined, fallback: string): CatalogSlot {
  return CATALOG_SLOTS[id || ""] ?? CATALOG_SLOTS[fallback] ?? CATALOG_SLOTS[TOWER_CRANE_ID]!;
}

export function catalogUrl(file: string): string {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");
  return `${base}models/${file}`;
}
