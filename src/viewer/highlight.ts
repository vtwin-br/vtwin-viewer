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
 * Aplica os estados (pending/active/done) no FragmentsModel:
 *   - active   -> highlight amarelo
 *   - pending  -> oculto (setVisible false)
 *   - done     -> visivel, sem highlight (cor original)
 *
 * Trabalha com lotes para minimizar chamadas no worker do fragments.
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
  /** Localids de cada estado atualmente aplicado, para desfazer rapidamente. */
  private currentActive = new Set<number>();
  private currentPending = new Set<number>();
  /** LocalIds atualmente "selecionados" pelo usuario via UI. */
  private currentSelection = new Set<number>();
  /** LocalIds que participam da simulação (têm tarefa associada no IFC). */
  private scheduledLocalIds = new Set<number>();
  /** Já escondemos geometria sem cronograma (IfcSpace, etc.). */
  private nonScheduledHidden = false;

  constructor(
    model: FRAGS.FragmentsModel,
    fragments: OBC.FragmentsManager,
    allGuids: Iterable<string>,
  ) {
    this.model = model;
    this.fragments = fragments;
    this.allGuids = [...new Set(allGuids)];
  }

  /** Resolve GUIDs -> localIds no modelo (uma unica vez). */
  async ready(): Promise<void> {
    if (this.guidToLocal.size > 0) return;
    const localIds = await this.model.getLocalIdsByGuids(this.allGuids);
    for (let i = 0; i < this.allGuids.length; i++) {
      const guid = this.allGuids[i];
      const local = localIds[i];
      if (typeof local === "number") {
        this.guidToLocal.set(guid, local);
        this.localToGuid.set(local, guid);
        this.scheduledLocalIds.add(local);
      }
    }
    await this.hideGeometryWithoutSchedule();
  }

  /**
   * Esconde tudo o que tem geometria no Fragments mas não está ligado a nenhuma
   * tarefa do cronograma (ex.: IfcSpace, zonas, mobiliário sem IfcRelAssignsToProduct).
   * Assim, no dia 0 só o “vazio” aparece até as tarefas liberarem elementos.
   */
  private async hideGeometryWithoutSchedule(): Promise<void> {
    if (this.nonScheduledHidden) return;
    this.nonScheduledHidden = true;

    const allGeom = await this.model.getItemsIdsWithGeometry();
    const scheduled = this.scheduledLocalIds;

    let toHide: number[];
    if (scheduled.size === 0) {
      toHide = allGeom;
    } else {
      toHide = allGeom.filter((id) => !scheduled.has(id));
    }

    const chunk = 4000;
    for (let i = 0; i < toHide.length; i += chunk) {
      await this.model.setVisible(toHide.slice(i, i + chunk), false);
    }
    await this.fragments.core.update(true);
  }

  /** Aplica os estados do simulador no modelo. */
  async apply(buckets: SimulationStateBuckets): Promise<void> {
    await this.ready();

    const nextActive = new Set(this.guidsToLocals(buckets.active));
    const nextPending = new Set(this.guidsToLocals(buckets.pending));

    // 1) Reseta o que saiu do estado "active"
    const activeToReset = diff(this.currentActive, nextActive);
    if (activeToReset.length > 0) {
      await this.model.resetHighlight(activeToReset);
    }

    // 2) Aplica highlight amarelo no que entrou em "active"
    const activeToAdd = diff(nextActive, this.currentActive);
    if (activeToAdd.length > 0) {
      await this.model.highlight(activeToAdd, activeMaterial());
    }

    // 3) Visibilidade: pending fica oculto, restante visivel
    const toHide = diff(nextPending, this.currentPending);
    const toShow = diff(this.currentPending, nextPending);
    if (toHide.length > 0) await this.model.setVisible(toHide, false);
    if (toShow.length > 0) await this.model.setVisible(toShow, true);

    this.currentActive = nextActive;
    this.currentPending = nextPending;

    // Reaplica selecao do usuario por cima (caso tenha sido sobreposta)
    if (this.currentSelection.size > 0) {
      const selArr = [...this.currentSelection];
      await this.model.highlight(selArr, selectionMaterial());
    }

    await this.fragments.core.update(true);
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
