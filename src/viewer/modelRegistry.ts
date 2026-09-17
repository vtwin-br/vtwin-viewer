import type { FragmentsModel } from "@thatopen/fragments";

/** Runtime gráfico descartável, indexado pelo ID estável do modelo BIM. */
export class ViewportModelRegistry {
  private readonly models = new Map<string, FragmentsModel>();

  get size(): number {
    return this.models.size;
  }

  get(modelId: string): FragmentsModel | null {
    return this.models.get(modelId) ?? null;
  }

  attach(modelId: string, model: FragmentsModel): void {
    this.models.set(modelId, model);
  }

  detach(modelId: string): FragmentsModel | null {
    const model = this.models.get(modelId) ?? null;
    this.models.delete(modelId);
    return model;
  }

  values(modelIds?: Iterable<string>): FragmentsModel[] {
    if (!modelIds) return [...this.models.values()];
    const out: FragmentsModel[] = [];
    for (const modelId of modelIds) {
      const model = this.models.get(modelId);
      if (model) out.push(model);
    }
    return out;
  }

  clear(): void {
    this.models.clear();
  }
}
