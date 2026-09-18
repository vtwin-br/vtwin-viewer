import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import type { SimulationStateBuckets } from "../schedule/simulation";
import { bucketsFingerprint } from "../schedule/simulation";
import type { ViewportElementRef } from "../bim/elementRef";
import { requestFragmentsUpdate } from "./fragmentsUpdate";
import { recordMetric } from "./perfStats";

const COLOR_ACTIVE = new THREE.Color(0xf59e0b);
const COLOR_SELECTION = new THREE.Color(0x38bdf8);
const COLOR_GHOST = new THREE.Color(0xd8dee6);
const GHOST_OPACITY = 0.055;

function activeMaterial(): FRAGS.MaterialDefinition {
  return {
    color: COLOR_ACTIVE,
    opacity: 1,
    transparent: false,
    renderedFaces: FRAGS.RenderedFaces.TWO,
  };
}

function selectionMaterial(): FRAGS.MaterialDefinition {
  return {
    color: COLOR_SELECTION,
    opacity: 1,
    transparent: false,
    renderedFaces: FRAGS.RenderedFaces.TWO,
    depthWrite: true,
  };
}

/** Cinza neutro e quase invisível — o elemento selecionado fica a ler-se sozinho. */
function ghostMaterial(): FRAGS.MaterialDefinition {
  return {
    color: COLOR_GHOST,
    opacity: GHOST_OPACITY,
    transparent: true,
    renderedFaces: FRAGS.RenderedFaces.TWO,
    depthWrite: false,
    _explicitProps: ["color", "opacity", "transparent", "depthWrite"],
  };
}

interface HighlightLayer {
  modelId: string;
  model: FRAGS.FragmentsModel;
  visible: boolean;
  guidToLocal: Map<string, number>;
  localToGuid: Map<number, string>;
  allGuids: string[];
  guidSet: Set<string>;
  allGeomIds: number[];
  /** IfcSpace, aberturas, grelhas, etc. — ocultos na 4D se não tiverem tarefa. */
  contextHideIds: number[];
  readyDone: boolean;
  currentHidden: Set<number>;
  currentActive: Set<number>;
  currentSelection: Set<number>;
  /** Itens translúcidos pelo isolamento (não 4D). */
  currentGhost: Set<number>;
  readyTask?: Promise<void>;
}

export type GuidHit = ViewportElementRef;

export interface ModelSelection {
  modelId: string;
  model: FRAGS.FragmentsModel;
  localIds: number[];
}

/**
 * Visibilidade 4D em um ou mais FragmentsModel:
 *   - Pré-play / início parado: modelo completo; só volumes espaciais sem
 *     tarefa (IfcSpace, ambientes) ficam ocultos.
 *   - Play / pause a meio: só produtos ligados a uma IfcTask COM datas.
 *     pending oculto, active amarelo, done cor original.
 *     Sem data ou sem ligação ao cronograma ficam ocultos.
 * Isolamento deixa o resto cinza e quase transparente (seleção opaca).
 */
export class ScheduleHighlighter {
  private fragments: OBC.FragmentsManager;
  private layers = new Map<string, HighlightLayer>();
  private workingGuids: string[] = [];
  private lastApplyKey = "";

  constructor(fragments: OBC.FragmentsManager) {
    this.fragments = fragments;
  }

  invalidateApply(): void {
    this.lastApplyKey = "";
  }

  async addModel(modelId: string, model: FRAGS.FragmentsModel, allGuids: Iterable<string>): Promise<void> {
    const prev = this.layers.get(modelId);
    if (prev) await this.removeModel(modelId);
    const guids = [...new Set(allGuids)];
    this.layers.set(modelId, {
      modelId,
      model,
      visible: true,
      guidToLocal: new Map(),
      localToGuid: new Map(),
      allGuids: guids,
      guidSet: new Set(guids),
      allGeomIds: [],
      contextHideIds: [],
      readyDone: false,
      currentHidden: new Set(),
      currentActive: new Set(),
      currentSelection: new Set(),
      currentGhost: new Set(),
    });
    this.lastApplyKey = "";
    await this.ready(modelId);
  }

  async removeModel(modelId: string): Promise<void> {
    const layer = this.layers.get(modelId);
    if (!layer) return;
    this.layers.delete(modelId);
    this.lastApplyKey = "";
    try {
      await requestFragmentsUpdate(this.fragments, true);
    } catch {
      /* modelo já libertado */
    }
  }

  async setModelVisible(modelId: string, visible: boolean): Promise<void> {
    const layer = this.layers.get(modelId);
    if (!layer) return;
    layer.visible = visible;
    layer.model.object.visible = visible;
    if (!visible) {
      this.workingGuids = this.workingGuids.filter((g) => this.guidModelId(g) !== modelId);
    }
    this.lastApplyKey = "";
    await requestFragmentsUpdate(this.fragments, true);
  }

  visibleModels(): Array<{ id: string; model: FRAGS.FragmentsModel }> {
    return [...this.layers.values()].filter((l) => l.visible).map((l) => ({ id: l.modelId, model: l.model }));
  }

  geomIdsOf(modelId: string): number[] | undefined {
    const layer = this.layers.get(modelId);
    return layer?.readyDone ? layer.allGeomIds : undefined;
  }

  getModel(): FRAGS.FragmentsModel | null {
    return this.visibleLayers()[0]?.model ?? null;
  }

  async ready(modelId?: string): Promise<void> {
    const started = performance.now();
    const list = modelId ? [this.layers.get(modelId)].filter((l): l is HighlightLayer => !!l) : [...this.layers.values()];
    let prepared = 0;
    for (const layer of list) {
      if (layer.readyDone) continue;
      layer.readyTask ??= this.prepareLayer(layer);
      await layer.readyTask;
      prepared += 1;
    }
    if (prepared) {
      recordMetric("vista:highlighter:ready", performance.now() - started, {
        models: prepared,
      });
    }
  }

  private async prepareLayer(layer: HighlightLayer): Promise<void> {
    try {
      if (layer.allGuids.length > 0) {
        const localIds = await layer.model.getLocalIdsByGuids(layer.allGuids);
        for (let i = 0; i < layer.allGuids.length; i++) {
          const guid = layer.allGuids[i]!;
          const local = localIds[i];
          if (typeof local === "number") {
            layer.guidToLocal.set(guid, local);
            layer.localToGuid.set(local, guid);
          }
        }
      }
      layer.allGeomIds = await layer.model.getItemsIdsWithGeometry();
      layer.contextHideIds = await collectContextHideIds(layer.model, layer.allGeomIds);
      layer.readyDone = true;
    } catch (err) {
      layer.readyTask = undefined;
      throw err;
    }
  }

  /**
   * @param previewAll true no início, sem play — modelo visível, sem cor de execução.
   *   Com a simulação a correr (ou o cursor fora do dia 0), só entram produtos
   *   com data: pending oculto, active/done visíveis.
   * @returns false se o estado 4D já estava aplicado (nada a fazer).
   */
  async apply(
    buckets: SimulationStateBuckets,
    opts: { previewAll: boolean } = { previewAll: false },
  ): Promise<boolean> {
    const started = performance.now();
    await this.ready();
    const key = opts.previewAll ? "preview" : bucketsFingerprint(buckets);
    if (key === this.lastApplyKey) return false;

    const layers = this.visibleLayers();
    await this.ensureGuidsMapped([...buckets.active, ...buckets.done, ...buckets.pending]);

    for (const layer of layers) {
      await this.clearGhostLayer(layer);

      const nextActive = opts.previewAll
        ? new Set<number>()
        : new Set(this.guidsToLocals(layer, buckets.active));
      const nextHidden = new Set<number>();
      if (opts.previewAll) {
        const scheduled = new Set(
          this.guidsToLocals(layer, [...buckets.active, ...buckets.done, ...buckets.pending]),
        );
        for (const id of layer.contextHideIds) {
          if (!scheduled.has(id)) nextHidden.add(id);
        }
      } else {
        const visibleNow = new Set(nextActive);
        for (const id of this.guidsToLocals(layer, buckets.done)) visibleNow.add(id);
        for (const id of layer.allGeomIds) {
          if (!visibleNow.has(id)) nextHidden.add(id);
        }
      }

      const activeToReset = diff(layer.currentActive, nextActive);
      if (activeToReset.length > 0) await layer.model.resetHighlight(activeToReset);
      const activeToAdd = diff(nextActive, layer.currentActive);
      if (activeToAdd.length > 0) await layer.model.highlight(activeToAdd, activeMaterial());

      const toHide = diff(nextHidden, layer.currentHidden);
      const toShow = diff(layer.currentHidden, nextHidden);
      if (toHide.length > 0) await this.setVisibleMany(layer, toHide, false);
      if (toShow.length > 0) await this.setVisibleMany(layer, toShow, true);

      layer.currentActive = nextActive;
      layer.currentHidden = nextHidden;

      if (layer.currentSelection.size > 0) {
        await layer.model.highlight([...layer.currentSelection], selectionMaterial());
      }
    }

    this.lastApplyKey = key;
    await requestFragmentsUpdate(this.fragments);
    recordMetric("vista:highlighter:apply", performance.now() - started, {
      preview: opts.previewAll,
      models: layers.length,
      pending: buckets.pending.size,
      active: buckets.active.size,
      done: buckets.done.size,
    });
    return true;
  }

  async revealAll(): Promise<void> {
    await this.ready();
    for (const layer of this.visibleLayers()) await this.showFullLayer(layer);
    this.lastApplyKey = "reveal-all";
    await requestFragmentsUpdate(this.fragments);
  }

  private async showFullLayer(layer: HighlightLayer): Promise<void> {
    await this.clearGhostLayer(layer);
    if (layer.currentActive.size > 0) {
      await layer.model.resetHighlight([...layer.currentActive]);
      layer.currentActive.clear();
    }
    if (layer.currentHidden.size > 0) {
      await this.setVisibleMany(layer, [...layer.currentHidden], true);
      layer.currentHidden.clear();
    }
    if (layer.currentSelection.size > 0) {
      await layer.model.highlight([...layer.currentSelection], selectionMaterial());
    }
  }

  private async setVisibleMany(layer: HighlightLayer, ids: number[], visible: boolean): Promise<void> {
    await this.forChunks(ids, (slice) => layer.model.setVisible(slice, visible));
  }

  private async forChunks(ids: number[], fn: (slice: number[]) => Promise<void>): Promise<void> {
    const chunk = 4000;
    for (let i = 0; i < ids.length; i += chunk) {
      await fn(ids.slice(i, i + chunk));
    }
  }

  getWorkingGuids(): string[] {
    return [...this.workingGuids];
  }

  async setWorkingSelection(guids: Iterable<string>): Promise<void> {
    const list = [...new Set(guids)];
    this.workingGuids = list;
    await this.selectByGuids(list, { isolate: this.isIsolating() && list.length > 0 });
  }

  selectionLocalIds(): number[] {
    const out: number[] = [];
    for (const layer of this.visibleLayers()) out.push(...layer.currentSelection);
    return out;
  }

  selectionItems(): ModelSelection[] {
    return this.visibleLayers()
      .filter((l) => l.currentSelection.size > 0)
      .map((l) => ({ modelId: l.modelId, model: l.model, localIds: [...l.currentSelection] }));
  }

  isIsolating(): boolean {
    return this.visibleLayers().some((l) => l.currentGhost.size > 0);
  }

  async isolateGuids(guids: Iterable<string>): Promise<number[]> {
    const list = [...new Set(guids)];
    this.workingGuids = list;
    await this.selectByGuids(list, { isolate: list.length > 0 });
    return this.selectionLocalIds();
  }

  /** Destaca localIds do Fragments e devolve os GlobalId resolvidos (para vincular). */
  async isolateLocalIds(groups: Array<{ modelId: string; localIds: number[] }>): Promise<string[]> {
    await this.ready();
    const guids: string[] = [];
    for (const group of groups) {
      if (!group.localIds.length) continue;
      guids.push(...(await this.guidsFromLocalIds([...new Set(group.localIds)], group.modelId)));
    }
    const unique = [...new Set(guids)];
    if (unique.length) {
      await this.isolateGuids(unique);
      return unique;
    }
    await this.selectByLocalIds(groups, true);
    return this.getWorkingGuids();
  }

  async clearIsolation(): Promise<void> {
    for (const layer of this.visibleLayers()) await this.clearGhostLayer(layer);
    await requestFragmentsUpdate(this.fragments);
  }

  async toggleWorkingGuid(guid: string): Promise<string[]> {
    const set = new Set(this.workingGuids);
    if (set.has(guid)) set.delete(guid);
    else set.add(guid);
    await this.setWorkingSelection(set);
    return this.getWorkingGuids();
  }

  async addWorkingGuids(guids: Iterable<string>): Promise<string[]> {
    const set = new Set(this.workingGuids);
    for (const g of guids) set.add(g);
    await this.setWorkingSelection(set);
    return this.getWorkingGuids();
  }

  async removeWorkingGuids(guids: Iterable<string>): Promise<string[]> {
    const drop = new Set(guids);
    await this.setWorkingSelection(this.workingGuids.filter((g) => !drop.has(g)));
    return this.getWorkingGuids();
  }

  async guidsFromLocalIds(localIds: number[], modelId?: string): Promise<string[]> {
    await this.ready();
    const layers = modelId
      ? [this.layers.get(modelId)].filter((l): l is HighlightLayer => !!l)
      : this.visibleLayers();
    const out: string[] = [];
    for (const layer of layers) {
      const missing: number[] = [];
      for (const id of localIds) {
        const known = layer.localToGuid.get(id);
        if (known) out.push(known);
        else missing.push(id);
      }
      if (!missing.length) continue;
      const found = await layer.model.getGuidsByLocalIds(missing);
      for (let i = 0; i < missing.length; i++) {
        const guid = found[i];
        if (!guid) continue;
        this.registerGuid(guid, missing[i]!, layer.modelId);
        out.push(guid);
      }
    }
    return [...new Set(out)];
  }

  private async selectByLocalIds(
    groups: Array<{ modelId: string; localIds: number[] }>,
    isolate: boolean,
  ): Promise<void> {
    await this.ready();
    const byModel = new Map(groups.map((g) => [g.modelId, [...new Set(g.localIds)]]));
    for (const layer of this.visibleLayers()) {
      if (layer.currentSelection.size > 0) {
        const prev = [...layer.currentSelection];
        await layer.model.resetHighlight(prev);
        const stillActive = prev.filter((id) => layer.currentActive.has(id));
        if (stillActive.length > 0) await layer.model.highlight(stillActive, activeMaterial());
        layer.currentSelection.clear();
      }
      const wanted = byModel.get(layer.modelId) ?? [];
      const geom = new Set(layer.allGeomIds);
      const newSel = geom.size ? wanted.filter((id) => geom.has(id)) : wanted;
      if (newSel.length > 0) {
        await layer.model.highlight(newSel, selectionMaterial());
        layer.currentSelection = new Set(newSel);
      }
      if (isolate && newSel.length > 0) {
        await this.setGhostExcept(layer, newSel);
        await layer.model.highlight(newSel, selectionMaterial());
      } else if (layer.currentGhost.size > 0) {
        await this.clearGhostLayer(layer);
        if (newSel.length > 0) await layer.model.highlight(newSel, selectionMaterial());
      }
    }
    await requestFragmentsUpdate(this.fragments);
  }

  async selectByGuids(guids: Iterable<string>, opts: { isolate?: boolean } = {}): Promise<void> {
    await this.ready();
    await this.ensureGuidsMapped(guids);
    this.workingGuids = [...new Set(guids)];
    const isolate = !!opts.isolate && this.workingGuids.length > 0;

    for (const layer of this.visibleLayers()) {
      if (layer.currentSelection.size > 0) {
        const prev = [...layer.currentSelection];
        await layer.model.resetHighlight(prev);
        const stillActive = prev.filter((id) => layer.currentActive.has(id));
        if (stillActive.length > 0) await layer.model.highlight(stillActive, activeMaterial());
        layer.currentSelection.clear();
      }

      const newSel = this.guidsToLocals(layer, this.workingGuids);
      if (newSel.length > 0) {
        await layer.model.highlight(newSel, selectionMaterial());
        layer.currentSelection = new Set(newSel);
      }

      if (isolate) {
        await this.setGhostExcept(layer, newSel);
        if (newSel.length > 0) await layer.model.highlight(newSel, selectionMaterial());
      } else if (layer.currentGhost.size > 0) {
        await this.clearGhostLayer(layer);
        if (newSel.length > 0) await layer.model.highlight(newSel, selectionMaterial());
      }
    }

    await requestFragmentsUpdate(this.fragments);
  }

  async clearSelection(): Promise<void> {
    this.workingGuids = [];
    for (const layer of this.visibleLayers()) {
      await this.clearGhostLayer(layer);
      if (layer.currentSelection.size === 0) continue;
      const prev = [...layer.currentSelection];
      layer.currentSelection.clear();
      await layer.model.resetHighlight(prev);
      const stillActive = prev.filter((id) => layer.currentActive.has(id));
      if (stillActive.length > 0) await layer.model.highlight(stillActive, activeMaterial());
    }
    await requestFragmentsUpdate(this.fragments);
  }

  private async setGhostExcept(layer: HighlightLayer, keep: number[]): Promise<void> {
    const keepSet = new Set(keep);
    const next = new Set<number>();
    for (const id of layer.allGeomIds) {
      if (keepSet.has(id) || layer.currentHidden.has(id)) continue;
      next.add(id);
    }
    const toRestore = diff(layer.currentGhost, next);
    const toGhost = diff(next, layer.currentGhost);
    if (toRestore.length) await this.restoreGhosted(layer, toRestore);
    if (toGhost.length) await this.ghostMany(layer, toGhost);
    layer.currentGhost = next;
  }

  private async clearGhostLayer(layer: HighlightLayer): Promise<void> {
    if (layer.currentGhost.size === 0) return;
    const ids = [...layer.currentGhost];
    layer.currentGhost.clear();
    await this.restoreGhosted(layer, ids);
  }

  private async ghostMany(layer: HighlightLayer, ids: number[]): Promise<void> {
    const material = ghostMaterial();
    await this.forChunks(ids, (slice) => layer.model.highlight(slice, material));
  }

  private async restoreGhosted(layer: HighlightLayer, ids: number[]): Promise<void> {
    const visible = ids.filter((id) => !layer.currentHidden.has(id));
    if (!visible.length) return;
    await this.forChunks(visible, (slice) => layer.model.resetHighlight(slice));
    const stillActive = visible.filter((id) => layer.currentActive.has(id) && !layer.currentSelection.has(id));
    if (stillActive.length) await layer.model.highlight(stillActive, activeMaterial());
    const stillSelected = visible.filter((id) => layer.currentSelection.has(id));
    if (stillSelected.length) await layer.model.highlight(stillSelected, selectionMaterial());
  }

  async pickGuid(
    camera: THREE.Camera,
    event: PointerEvent | MouseEvent,
    dom: HTMLElement,
  ): Promise<string | null> {
    const hit = await this.pickHit(camera, event, dom);
    return hit?.globalId ?? null;
  }

  async pickHit(
    camera: THREE.Camera,
    event: PointerEvent | MouseEvent,
    dom: HTMLElement,
  ): Promise<GuidHit | null> {
    await this.ready();
    const mouse = new THREE.Vector2(event.clientX, event.clientY);
    let best: { hit: GuidHit; dist: number } | null = null;
    const camPos = camera.position;

    for (const layer of this.visibleLayers()) {
      const result = await layer.model.raycast({
        camera: camera as THREE.PerspectiveCamera | THREE.OrthographicCamera,
        mouse,
        dom: dom as HTMLCanvasElement,
      });
      if (!result) continue;
      const localId = result.localId;
      const rec = result as { distance?: number; point?: THREE.Vector3 };
      const dist =
        typeof rec.distance === "number"
          ? rec.distance
          : rec.point
            ? camPos.distanceTo(rec.point)
            : Number.POSITIVE_INFINITY;
      const known = layer.localToGuid.get(localId);
      let guid = known ?? null;
      if (!guid) {
        const fromIndex = await layer.model.getGuidsByLocalIds([localId]);
        guid = fromIndex?.[0] ?? null;
      }
      if (!guid) guid = await this.guidFromItemData(layer, localId);
      if (!guid) continue;
      this.registerGuid(guid, localId, layer.modelId);
      if (!best || dist < best.dist) {
        best = { hit: { globalId: guid, localId, modelId: layer.modelId }, dist };
      }
    }
    return best?.hit ?? null;
  }

  localIdOf(guid: string, modelId?: string): number | undefined {
    if (modelId) return this.layers.get(modelId)?.guidToLocal.get(guid);
    for (const layer of this.visibleLayers()) {
      const id = layer.guidToLocal.get(guid);
      if (typeof id === "number") return id;
    }
    return undefined;
  }

  guidModelId(guid: string): string | undefined {
    for (const layer of this.visibleLayers()) {
      if (layer.guidToLocal.has(guid)) return layer.modelId;
    }
    for (const layer of this.layers.values()) {
      if (layer.guidToLocal.has(guid)) return layer.modelId;
    }
    return undefined;
  }

  refsOf(guids: Iterable<string>): ViewportElementRef[] {
    const out: ViewportElementRef[] = [];
    for (const guid of guids) {
      for (const layer of this.visibleLayers()) {
        const localId = layer.guidToLocal.get(guid);
        if (typeof localId === "number") {
          out.push({ globalId: guid, modelId: layer.modelId, localId });
        }
      }
    }
    return out;
  }

  registerGuid(guid: string, localId: number, modelId?: string): void {
    const layer = (modelId ? this.layers.get(modelId) : null) ?? this.visibleLayers()[0];
    if (!layer) return;
    layer.guidToLocal.set(guid, localId);
    layer.localToGuid.set(localId, guid);
    if (!layer.guidSet.has(guid)) {
      layer.guidSet.add(guid);
      layer.allGuids.push(guid);
    }
  }

  async includeGuids(guids: Iterable<string>): Promise<void> {
    await this.ready();
    await this.ensureGuidsMapped(guids);
    this.lastApplyKey = "";
  }

  private async ensureGuidsMapped(guids: Iterable<string>): Promise<void> {
    const list = [...new Set(guids)];
    for (const layer of this.visibleLayers()) {
      const missing = list.filter((g) => !layer.guidToLocal.has(g));
      if (missing.length === 0) continue;
      const locals = await layer.model.getLocalIdsByGuids(missing);
      for (let i = 0; i < missing.length; i++) {
        const local = locals[i];
        if (typeof local === "number") this.registerGuid(missing[i]!, local, layer.modelId);
      }
    }
  }

  private async guidFromItemData(layer: HighlightLayer, localId: number): Promise<string | null> {
    try {
      const rows = await layer.model.getItemsData([localId], {
        attributesDefault: false,
        attributes: ["GlobalId"],
        relationsDefault: { attributes: false, relations: false },
      });
      const raw = rows[0]?.GlobalId;
      if (typeof raw === "string" && raw) return raw;
      if (raw && typeof raw === "object" && "value" in raw) {
        const v = (raw as { value: unknown }).value;
        return typeof v === "string" && v ? v : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  private guidsToLocals(layer: HighlightLayer, guids: Iterable<string>): number[] {
    const out: number[] = [];
    for (const g of guids) {
      const id = layer.guidToLocal.get(g);
      if (typeof id === "number") out.push(id);
    }
    return out;
  }

  private visibleLayers(): HighlightLayer[] {
    return [...this.layers.values()].filter((l) => l.visible);
  }
}

function diff(a: Iterable<number>, b: Set<number>): number[] {
  const out: number[] = [];
  for (const v of a) if (!b.has(v)) out.push(v);
  return out;
}

/** Volumes de ambiente e anotações — não são obra, a não ser que a tarefa os ligue. */
const CONTEXT_HIDE_CATEGORY =
  /IFCSPACE|IFCSPATIALZONE|IFCEXTERNALSPATIALELEMENT|IFCZONE|IFCOPENINGELEMENT|IFCANNOTATION|IFCGRID|IFCVIRTUALELEMENT|IFCVOIDINGFEATURE/i;

async function collectContextHideIds(model: FRAGS.FragmentsModel, geomIds: number[]): Promise<number[]> {
  if (!geomIds.length) return [];
  try {
    const cats = (await model.getCategories()).filter((c): c is string => !!c && CONTEXT_HIDE_CATEGORY.test(c));
    if (!cats.length) return [];
    const map = await model.getItemsOfCategories(cats.map((c) => new RegExp(`^${escapeRe(c)}$`, "i")));
    const geom = new Set(geomIds);
    const out: number[] = [];
    const seen = new Set<number>();
    for (const ids of Object.values(map)) {
      for (const id of ids) {
        if (typeof id !== "number" || seen.has(id) || !geom.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
