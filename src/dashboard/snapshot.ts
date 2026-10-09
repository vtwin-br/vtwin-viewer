import { compactCatalog, type BimCatalog } from "../projectPlan/bimCatalog";
import type { ScheduleData } from "../schedule/types";
import { compactTaskRows, computeDashboardKpis, type DashboardKpis, type DashboardModelHint } from "./kpis";

export interface DashboardSnapshot {
  asOf: string;
  project: string;
  kpis: {
    progressoFisicoPct: number;
    tarefas: { folhas: number; pendentes: number; execucao: number; concluidas: number; semData: number };
    custo: { realizado: number; restante: number; orcamento: number; moeda: string };
    ligacao3d: { guidsLigados: number; semVinculo: number; elementos: number };
    prazo: { inicio: string; fim: string; dias: number };
    modelos: number;
    pisos: number;
  };
  paint: {
    filtros: string[];
    familias: string[];
    pisos: string[];
    nota: string;
  };
  models: DashboardModelHint[];
  buckets: Array<{
    id: string;
    label: string;
    family: string;
    storey: string | null;
    count: number;
    samples: string[];
  }>;
  tasks: ReturnType<typeof compactTaskRows>;
  selection: { count: number; sampleGuids: string[] };
}

export function buildDashboardSnapshot(input: {
  schedule: ScheduleData | null;
  date: Date;
  models: DashboardModelHint[];
  projectName: string;
  productCount: number;
  storeyCount: number;
  catalog: BimCatalog | null;
  selectedGuids: string[];
}): { kpis: DashboardKpis; snapshot: DashboardSnapshot } {
  const kpis = computeDashboardKpis({
    schedule: input.schedule,
    date: input.date,
    models: input.models,
    productCount: input.catalog?.productCount ?? input.productCount,
    storeyCount: input.catalog?.storeyCount ?? input.storeyCount,
    catalog: input.catalog,
  });
  const snapshot: DashboardSnapshot = {
    asOf: kpis.asOfLabel,
    project: input.projectName,
    kpis: {
      progressoFisicoPct: kpis.progressPct,
      tarefas: {
        folhas: kpis.leaves,
        pendentes: kpis.pending,
        execucao: kpis.active,
        concluidas: kpis.done,
        semData: kpis.undated,
      },
      custo: { realizado: roundMoney(kpis.costRealized), restante: roundMoney(kpis.costLeft), orcamento: roundMoney(kpis.costTotal), moeda: kpis.currency },
      ligacao3d: { guidsLigados: kpis.linkedGuids, semVinculo: kpis.unlinkedCount, elementos: kpis.productCount },
      prazo: { inicio: kpis.planStartLabel, fim: kpis.planEndLabel, dias: kpis.spanDays },
      modelos: kpis.modelCount,
      pisos: kpis.storeyCount,
    },
    paint: {
      filtros: ["unlinked", "linked", "done", "active", "pending", "not_done", "undated"],
      familias: [...new Set((input.catalog?.buckets ?? []).map((b) => b.family))].slice(0, 24),
      pisos: [...new Set((input.catalog?.buckets ?? []).map((b) => b.storey).filter((s): s is string => Boolean(s)))].slice(0, 16),
      nota: "Sem progresso real: done=concluído na data, not_done=ainda não concluído, unlinked=sem vínculo ao cronograma. heatmap cost interpola custo da tarefa dona do GUID.",
    },
    models: input.models,
    buckets: input.catalog ? compactCatalog(input.catalog, 80) : [],
    tasks: compactTaskRows(input.schedule, input.date, 64),
    selection: {
      count: input.selectedGuids.length,
      sampleGuids: input.selectedGuids.slice(0, 12),
    },
  };
  return { kpis, snapshot };
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
