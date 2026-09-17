import type { ElementRef, ViewportElementRef } from "./elementRef";

export interface BimModelRecord {
  id: string;
  fileName: string;
  displayName: string;
  visible: boolean;
  hash?: string;
}

export interface BimModelRepository<T extends BimModelRecord = BimModelRecord> {
  readonly all: T[];
  readonly visible: T[];
  readonly active: T | null;
  get(id: string): T | undefined;
  setVisible(id: string, visible: boolean): T | undefined;
}

export interface ElementSemanticData {
  ref: ElementRef;
  attributes: Record<string, unknown>;
}

export interface IfcSemanticStore {
  get(ref: ElementRef): Promise<ElementSemanticData | null>;
  getMany(refs: ElementRef[]): Promise<ElementSemanticData[]>;
}

export interface GeometryBackend {
  resolve(refs: ElementRef[]): Promise<ViewportElementRef[]>;
  setVisible(refs: ElementRef[], visible: boolean): Promise<void>;
  select(refs: ElementRef[]): Promise<void>;
}
