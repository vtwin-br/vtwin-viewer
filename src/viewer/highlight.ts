import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import type { SimulationStateBuckets } from "../schedule/simulation";

const COLOR_ACTIVE = new THREE.Color(0xf59e0b);
const COLOR_SELECTION = new THREE.Color(0x38bdf8);

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
  };
}

/**
 * Visibilidade 4D:
 *   - Pré-play / início parado: mostra o modelo inteiro.
 *   - Play, pause a meio ou fim: só produtos COM início e fim.
 *     pending oculto, active amarelo, done cor original.
 *     Sem data fica oculto.
 */
export class ScheduleHighlighter {
  private model: FRAGS.FragmentsModel;
  private fragments: OBC.FragmentsManager;
  /** Todos os GUIDs de produtos referenciados pelo cronograma. */
  private allGuids: string[];
  /** Cache GUID -> localId resolvido pelo modelo. */
  private guidToLocal = new Map<string, number>();
  /** Cache localId -> GUID. */
  private localToGuid = new Map<number, string>();
  private allGeomIds: number[] = [];
  private readyDone = false;
  /** Localids atualmente ocultos. */
  private currentHidden = new Set<number>();
  /** Localids de cada estado atualmente aplicado, para desfazer rapidamente. */
  private currentActive = new Set<number>();
  /** LocalIds atualmente "selecionados" pelo usuario via UI. */
  private currentSelection = new Set<number>();

  constructor(
    model: FRAGS.FragmentsModel,
    fragments: OBC.FragmentsManager,
    allGuids: Iterable<string>,
  ) {
    this.model = model;
    this.fragments = fragments;
    this.allGuids = [...new Set(allGuids)];
  }

  /** Resolve GUIDs -> localIds e lista a geometria do modelo. */
  async ready(): Promise<void> {
    if (this.readyDone) return;
    this.readyDone = true;
    if (this.allGuids.length > 0) {
      const localIds = await this.model.getLocalIdsByGuids(this.allGuids);
      for (let i = 0; i < this.allGuids.length; i++) {
        const guid = this.allGuids[i];
        const local = localIds[i];
        if (typeof local === "number") {
          this.guidToLocal.set(guid, local);
          this.localToGuid.set(local, guid);
        }
      }
    }
    this.allGeomIds = await this.model.getItemsIdsWithGeometry();
  }

  /**
   * @param previewAll true no início, sem play — modelo completo visível.
   */
  async apply(
    buckets: SimulationStateBuckets,
    opts: { previewAll: boolean } = { previewAll: false },
  ): Promise<void> {
    await this.ready();

    if (opts.previewAll) {
      await this.showFullModel();
      return;
    }

    const nextActive = new Set(this.guidsToLocals(buckets.active));
    const nextDone = new Set(this.guidsToLocals(buckets.done));
    const nextVisible = new Set<number>([...nextActive, ...nextDone]);

    const nextHidden = new Set<number>();
    for (const id of this.allGeomIds) {
      if (!nextVisible.has(id)) nextHidden.add(id);
    }

    const activeToReset = diff(this.currentActive, nextActive);
    if (activeToReset.length > 0) {
      await this.model.resetHighlight(activeToReset);
    }
    const activeToAdd = diff(nextActive, this.currentActive);
    if (activeToAdd.length > 0) {
      await this.model.highlight(activeToAdd, activeMaterial());
    }

    const toHide = diff(nextHidden, this.currentHidden);
    const toShow = diff(this.currentHidden, nextHidden);
    if (toHide.length > 0) await this.setVisibleMany(toHide, false);
    if (toShow.length > 0) await this.setVisibleMany(toShow, true);

    this.currentActive = nextActive;
    this.currentHidden = nextHidden;

    if (this.currentSelection.size > 0) {
      const selArr = [...this.currentSelection];
      await this.model.highlight(selArr, selectionMaterial());
    }

    await this.fragments.core.update(true);
  }

  private async showFullModel(): Promise<void> {
    if (this.currentActive.size > 0) {
      await this.model.resetHighlight([...this.currentActive]);
      this.currentActive.clear();
    }
    if (this.currentHidden.size > 0) {
      await this.setVisibleMany([...this.currentHidden], true);
      this.currentHidden.clear();
    }
    if (this.currentSelection.size > 0) {
      await this.model.highlight([...this.currentSelection], selectionMaterial());
    }
    await this.fragments.core.update(true);
  }

  private async setVisibleMany(ids: number[], visible: boolean): Promise<void> {
    const chunk = 4000;
    for (let i = 0; i < ids.length; i += chunk) {
      await this.model.setVisible(ids.slice(i, i + chunk), visible);
    }
  }

  /** Destaca em azul os produtos de uma task. Substitui a selecao anterior. */
  async selectByGuids(guids: Iterable<string>): Promise<void> {
    await this.ready();

    // Limpa selecao anterior
    if (this.currentSelection.size > 0) {
      const prev = [...this.currentSelection];
      await this.model.resetHighlight(prev);
      // Reaplica o highlight "active" nos que ainda estao ativos
      const stillActive = prev.filter((id) => this.currentActive.has(id));
      if (stillActive.length > 0) {
        await this.model.highlight(stillActive, activeMaterial());
      }
      this.currentSelection.clear();
    }

    const newSel = this.guidsToLocals(guids);
    if (newSel.length > 0) {
      await this.model.highlight(newSel, selectionMaterial());
      this.currentSelection = new Set(newSel);
    }

    await this.fragments.core.update(true);
  }

  /** Limpa selecao ativa. */
  async clearSelection(): Promise<void> {
    if (this.currentSelection.size === 0) return;
    const prev = [...this.currentSelection];
    this.currentSelection.clear();
    await this.model.resetHighlight(prev);
    const stillActive = prev.filter((id) => this.currentActive.has(id));
    if (stillActive.length > 0) {
      await this.model.highlight(stillActive, activeMaterial());
    }
    await this.fragments.core.update(true);
  }

  /**
   * Raycast no clique do rato. Devolve o GlobalId do produto atingido,
   * ou null se o clique não acertar geometria do cronograma.
   */
  async pickGuid(
    camera: THREE.Camera,
    event: PointerEvent | MouseEvent,
    dom: HTMLElement,
  ): Promise<string | null> {
    await this.ready();
    const mouse = new THREE.Vector2(event.clientX, event.clientY);
    const result = await this.model.raycast({
      camera: camera as THREE.PerspectiveCamera | THREE.OrthographicCamera,
      mouse,
      dom: dom as HTMLCanvasElement,
    });
    if (!result) return null;
    const known = this.localToGuid.get(result.localId);
    if (known) return known;
    const getter = this.model as unknown as {
      getGuidsByLocalIds?: (ids: number[]) => Promise<(string | null | undefined)[]>;
    };
    if (typeof getter.getGuidsByLocalIds === "function") {
      const guids = await getter.getGuidsByLocalIds([result.localId]);
      return guids?.[0] ?? null;
    }
    return null;
  }

  private guidsToLocals(guids: Iterable<string>): number[] {
    const out: number[] = [];
    for (const g of guids) {
      const id = this.guidToLocal.get(g);
      if (typeof id === "number") out.push(id);
    }
    return out;
  }
}

function diff(a: Iterable<number>, b: Set<number>): number[] {
  const out: number[] = [];
  for (const v of a) if (!b.has(v)) out.push(v);
  return out;
}
