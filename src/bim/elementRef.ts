/**
 * Identidade persistente de uma entidade IFC na federação.
 * `expressId` é um detalhe do ficheiro de origem e pode mudar numa reescrita.
 */
export interface ElementRef {
  modelId: string;
  globalId: string;
  expressId?: number;
}

/** Identidade resolvida apenas enquanto o modelo está no viewport Fragments. */
export interface ViewportElementRef extends ElementRef {
  localId: number;
}

export function elementRefKey(ref: ElementRef): string {
  return `${ref.modelId}\0${ref.globalId}`;
}

export function sameElement(a: ElementRef, b: ElementRef): boolean {
  return a.modelId === b.modelId && a.globalId === b.globalId;
}
