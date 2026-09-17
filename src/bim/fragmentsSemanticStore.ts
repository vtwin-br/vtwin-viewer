import type { FragmentsModel } from "@thatopen/fragments";
import type { ElementSemanticData, IfcSemanticStore } from "./contracts";
import type { ElementRef } from "./elementRef";

export type FragmentModelResolver = (modelId: string) => FragmentsModel | null | undefined;

/**
 * Leitura semântica lazy sobre o artefato Fragments. O IFC original continua
 * canônico; este adaptador serve propriedades e relações sem abrir o STEP.
 */
export class FragmentsSemanticStore implements IfcSemanticStore {
  constructor(private readonly resolveModel: FragmentModelResolver) {}

  async get(ref: ElementRef): Promise<ElementSemanticData | null> {
    const [item] = await this.getMany([ref]);
    return item ?? null;
  }

  async getMany(refs: ElementRef[]): Promise<ElementSemanticData[]> {
    const byModel = new Map<string, ElementRef[]>();
    for (const ref of refs) {
      const list = byModel.get(ref.modelId) ?? [];
      list.push(ref);
      byModel.set(ref.modelId, list);
    }

    const out: ElementSemanticData[] = [];
    for (const [modelId, modelRefs] of byModel) {
      const model = this.resolveModel(modelId);
      if (!model) continue;
      const localIds = await model.getLocalIdsByGuids(modelRefs.map((ref) => ref.globalId));
      const pairs = modelRefs
        .map((ref, index) => ({ ref, localId: localIds[index] }))
        .filter((pair): pair is { ref: ElementRef; localId: number } => typeof pair.localId === "number");
      if (!pairs.length) continue;
      const rows = await model.getItemsData(
        pairs.map((pair) => pair.localId),
        {
          attributesDefault: false,
          attributes: ["GlobalId", "Name", "Description", "ObjectType", "PredefinedType"],
          relations: {
            IsDefinedBy: { attributes: true, relations: true },
            DefinesOccurrence: { attributes: false, relations: false },
            IsTypedBy: { attributes: true, relations: true },
            HasAssociations: { attributes: true, relations: true },
          },
        },
      );
      for (let index = 0; index < pairs.length; index++) {
        const pair = pairs[index]!;
        out.push({
          ref: { ...pair.ref },
          attributes: (rows[index] ?? {}) as Record<string, unknown>,
        });
      }
    }
    return out;
  }
}
