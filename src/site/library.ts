export interface LibraryItem {
  key: string;
  name: string;
  /** O que o planejador lê no cartão, sem abrir propriedades. */
  hint: string;
  /** Metros no eixo X do IFC. */
  width: number;
  /** Metros no eixo Y do IFC. */
  depth: number;
  /** Metros no eixo Z do IFC. */
  height: number;
  count: number;
  length: number;
  volume: number;
  color: number;
}

export const SITE_LIBRARY: LibraryItem[] = [
  { key: "grua", name: "Grua", hint: "1 un", width: 2, depth: 2, height: 18, count: 1, length: 0, volume: 0, color: 0xf59e0b },
  { key: "camiao", name: "Camião", hint: "1 un", width: 8, depth: 2.5, height: 3.2, count: 1, length: 0, volume: 0, color: 0x2563eb },
  { key: "betoneira", name: "Betoneira", hint: "1 un", width: 7.2, depth: 2.5, height: 3.6, count: 1, length: 0, volume: 0, color: 0xe2e8f0 },
  { key: "contentor", name: "Contentor", hint: "33 m³", width: 6.06, depth: 2.44, height: 2.59, count: 1, length: 0, volume: 33, color: 0xb45309 },
  { key: "escritorio", name: "Escritório", hint: "1 un", width: 6, depth: 3, height: 2.8, count: 1, length: 0, volume: 0, color: 0xf8fafc },
  { key: "gerador", name: "Gerador", hint: "1 un", width: 2.4, depth: 1.2, height: 1.8, count: 1, length: 0, volume: 0, color: 0x334155 },
  { key: "vedacao", name: "Vedação", hint: "12 m", width: 12, depth: 0.15, height: 2, count: 0, length: 12, volume: 0, color: 0x64748b },
  { key: "andaime", name: "Andaime", hint: "1 un", width: 4, depth: 1.2, height: 6, count: 1, length: 0, volume: 0, color: 0xfbbf24 },
];

export function libraryItem(key: string): LibraryItem | undefined {
  return SITE_LIBRARY.find((item) => item.key === key);
}
