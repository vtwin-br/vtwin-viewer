import type { ModelExtraTransform } from "./georef";
import type { GeoAnchorWrite } from "./georefWrite";
import type { SiteLimit } from "../logistics/types";
import { cloneSiteLimit } from "../logistics/types";

export type IfcSemanticChange =
  | { kind: "task:update"; taskId: number; fields: string[] }
  | { kind: "task:create"; taskId: number }
  | { kind: "task:delete"; taskId: number }
  | { kind: "task:reparent"; taskId: number; parentId?: number }
  | { kind: "schedule:rename"; name: string }
  | { kind: "element:rename"; expressId: number; globalId: string; name: string }
  | {
      kind: "property:update";
      propertyId: number;
      value: string | number | boolean | null;
    }
  | { kind: "product:assign"; taskId: number; globalId: string; assigned: boolean }
  | { kind: "group:create"; groupId: number }
  | { kind: "group:update"; groupId: number; fields: string[] }
  | { kind: "group:delete"; groupId: number }
  | { kind: "group:assign"; taskId: number; groupId: number; assigned: boolean }
  | { kind: "georef:anchor"; value: GeoAnchorWrite }
  | { kind: "georef:transform"; value: ModelExtraTransform }
  | { kind: "siteLimit:set"; value: SiteLimit }
  | { kind: "siteLimit:clear" }
  | { kind: "sequence:link"; predId: number; succId: number }
  | { kind: "sequence:unlink"; predId: number; succId: number }
  | { kind: "sequence:update"; predId: number; succId: number };

export interface IfcChangeSetSnapshot {
  revision: number;
  changes: IfcSemanticChange[];
}

/**
 * Registro neutro das alterações feitas pela aplicação. O exportador STEP
 * continua schema-aware; este log permite manter o domínio desacoplado do
 * renderer e, no futuro, reproduzir os mesmos comandos em outro serializador.
 */
export class IfcChangeSet {
  private revisionValue = 0;
  private readonly entries: IfcSemanticChange[] = [];

  get revision(): number {
    return this.revisionValue;
  }

  get size(): number {
    return this.entries.length;
  }

  append(change: IfcSemanticChange): void {
    const last = this.entries[this.entries.length - 1];
    if (last && canCoalesce(last, change)) {
      this.entries[this.entries.length - 1] = mergeChange(last, change);
      this.revisionValue += 1;
      return;
    }
    this.entries.push(cloneChange(change));
    this.revisionValue += 1;
  }

  snapshot(): IfcChangeSetSnapshot {
    return {
      revision: this.revisionValue,
      changes: this.entries.map(cloneChange),
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.revisionValue = 0;
  }
}

function cloneChange<T extends IfcSemanticChange>(change: T): T {
  if ("fields" in change) return { ...change, fields: [...change.fields] };
  if (change.kind === "georef:anchor" || change.kind === "georef:transform") {
    return { ...change, value: { ...change.value } } as T;
  }
  if (change.kind === "siteLimit:set") {
    return { ...change, value: cloneSiteLimit(change.value) } as T;
  }
  return { ...change };
}

function canCoalesce(a: IfcSemanticChange, b: IfcSemanticChange): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "georef:anchor" || a.kind === "georef:transform") return true;
  if (a.kind === "siteLimit:set" || a.kind === "siteLimit:clear") return a.kind === b.kind;
  if (a.kind === "task:update" && b.kind === "task:update") return a.taskId === b.taskId;
  if (a.kind === "group:update" && b.kind === "group:update") return a.groupId === b.groupId;
  return false;
}

function mergeChange(a: IfcSemanticChange, b: IfcSemanticChange): IfcSemanticChange {
  if (a.kind === "task:update" && b.kind === "task:update") {
    return { ...b, fields: [...new Set([...a.fields, ...b.fields])] };
  }
  if (a.kind === "group:update" && b.kind === "group:update") {
    return { ...b, fields: [...new Set([...a.fields, ...b.fields])] };
  }
  return cloneChange(b);
}
