import { familyLabel } from "../ifc/ifcFamilies";
import { formatDay } from "./dates";
import { inferFamilies, inferModelHints, storeyKeys, tokenize } from "./linkHints";
import type { BimCatalog, CatalogBucket } from "./bimCatalog";
import type { PlanTask } from "./types";

export type AssistConfidence = "high" | "medium" | "low";

export interface AssistSuggestion {
  taskId: string;
  ifcTaskId: number;
  wbs: string;
  name: string;
  startLabel: string;
  endLabel: string;
  cost?: number;
  bucketId: string;
  bucketLabel: string;
  family: string;
  storey: string | null;
  count: number;
  guids: string[];
  confidence: AssistConfidence;
  score: number;
  reason: string;
  source: "rules" | "llm";
  accepted: boolean;
}

export interface AssistUnmatched {
  taskId: string;
  ifcTaskId: number;
  wbs: string;
  name: string;
  reason: string;
}

export interface AssistReport {
  suggestions: AssistSuggestion[];
  unmatched: AssistUnmatched[];
  skippedLinked: number;
  skippedSummary: number;
  catalog: { products: number; buckets: number; storeys: number };
}

export interface LlmBucketPick {
  taskId: string;
  bucketId: string;
  confidence?: AssistConfidence;
  reason?: string;
}

interface TaskHint {
  families: string[];
  storeyKeys: string[];
  modelHints: string[];
  tokens: string[];
}

function isLeaf(tasks: PlanTask[], index: number): boolean {
  const level = tasks[index]!.outlineLevel;
  const next = tasks[index + 1];
  return !next || next.outlineLevel <= level;
}

function hintsOf(task: PlanTask, ancestorNames: string): TaskHint {
  const blob = `${task.wbs ?? ""} ${task.name} ${ancestorNames}`;
  return {
    families: inferFamilies(blob),
    storeyKeys: storeyKeys(blob),
    modelHints: inferModelHints(blob),
    tokens: tokenize(blob),
  };
}

function ancestorBlob(tasks: PlanTask[], index: number): string {
  const parts: string[] = [];
  let level = tasks[index]!.outlineLevel;
  for (let i = index - 1; i >= 0 && level > 1; i--) {
    if (tasks[i]!.outlineLevel < level) {
      parts.push(tasks[i]!.name);
      level = tasks[i]!.outlineLevel;
    }
  }
  return parts.join(" ");
}

function overlap<T>(a: Iterable<T>, b: Set<T> | T[]): number {
  const set = b instanceof Set ? b : new Set(b);
  let n = 0;
  for (const x of a) if (set.has(x)) n += 1;
  return n;
}

function scoreBucket(hint: TaskHint, bucket: CatalogBucket, familyCount: number, storeyFamilyCount: number): { score: number; bits: string[] } {
  const bits: string[] = [];
  let score = 0;
  const familyHit = hint.families.includes(bucket.family);
  if (familyHit) {
    score += 55;
    bits.push(familyLabel(bucket.family));
    if (familyCount === 1) score += 18;
  } else if (hint.families.length) {
    score -= 25;
  }
  const storeyHit = hint.storeyKeys.length && bucket.storeyKeys.some((k) => hint.storeyKeys.includes(k));
  if (storeyHit) {
    score += 38;
    bits.push(bucket.storey || "nível");
    if (storeyFamilyCount === 1) score += 10;
  } else if (hint.storeyKeys.length && bucket.storeyKeys.length) {
    score -= 12;
  }
  if (hint.modelHints.length && bucket.modelHint && hint.modelHints.includes(bucket.modelHint)) {
    score += 16;
    bits.push(bucket.modelLabel);
  }
  const nameHit = overlap(
    hint.tokens,
    tokenize(`${bucket.storey ?? ""} ${bucket.sampleNames.join(" ")} ${familyLabel(bucket.family)}`),
  );
  if (nameHit) score += Math.min(12, nameHit * 3);
  return { score, bits };
}

function confidenceOf(score: number, familyHit: boolean, storeyHit: boolean): AssistConfidence | null {
  if (familyHit && storeyHit && score >= 80) return "high";
  if (score >= 88) return "high";
  if (score >= 55 && familyHit) return "medium";
  if (score >= 42 && familyHit) return "low";
  return null;
}

function toSuggestion(
  task: PlanTask,
  bucket: CatalogBucket,
  score: number,
  reason: string,
  confidence: AssistConfidence,
  source: "rules" | "llm",
): AssistSuggestion {
  return {
    taskId: task.id,
    ifcTaskId: task.linkedIfcTaskId!,
    wbs: task.wbs ?? "",
    name: task.name,
    startLabel: task.start ? formatDay(task.start) : "—",
    endLabel: task.end ? formatDay(task.end) : "—",
    cost: task.cost,
    bucketId: bucket.id,
    bucketLabel: bucket.label,
    family: bucket.family,
    storey: bucket.storey,
    count: bucket.guids.length,
    guids: [...bucket.guids],
    confidence,
    score,
    reason,
    source,
    accepted: confidence !== "low",
  };
}

function mergeGuids(buckets: CatalogBucket[]): { guids: string[]; label: string; storey: string | null; family: string } {
  const guids = [...new Set(buckets.flatMap((b) => b.guids))];
  const models = [...new Set(buckets.map((b) => b.modelLabel))];
  const storey = buckets[0]?.storey ?? null;
  const family = buckets[0]!.family;
  const storeyBit = storey ? ` · ${storey}` : "";
  return {
    guids,
    storey,
    family,
    label: `${familyLabel(family)}${storeyBit}${models.length ? ` · ${models.join(" + ")}` : ""}`,
  };
}

export function suggestProductLinks(tasks: PlanTask[], catalog: BimCatalog): AssistReport {
  const unmatched: AssistUnmatched[] = [];
  let skippedLinked = 0;
  let skippedSummary = 0;
  const raw: AssistSuggestion[] = [];
  const familyTotals = new Map<string, number>();
  const storeyFamilyTotals = new Map<string, number>();
  for (const b of catalog.buckets) {
    familyTotals.set(b.family, (familyTotals.get(b.family) ?? 0) + 1);
    const sk = b.storeyKeys[0] ?? "_";
    const k = `${sk}|${b.family}`;
    storeyFamilyTotals.set(k, (storeyFamilyTotals.get(k) ?? 0) + 1);
  }

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    if (task.linkedIfcTaskId == null) continue;
    if (!isLeaf(tasks, i) || task.isSummary) {
      skippedSummary += 1;
      continue;
    }
    if (task.linkedProductGuids.length) {
      skippedLinked += 1;
      continue;
    }
    const hint = hintsOf(task, ancestorBlob(tasks, i));
    if (!hint.families.length && !hint.storeyKeys.length) {
      unmatched.push({
        taskId: task.id,
        ifcTaskId: task.linkedIfcTaskId,
        wbs: task.wbs ?? "",
        name: task.name,
        reason: "Sem tipo IFC nem nível reconhecidos no nome/WBS",
      });
      continue;
    }

    let best: { bucket: CatalogBucket; score: number; bits: string[]; familyHit: boolean; storeyHit: boolean } | null =
      null;
    let second = 0;
    for (const bucket of catalog.buckets) {
      const familyHit = hint.families.includes(bucket.family);
      const storeyHit = hint.storeyKeys.length > 0 && bucket.storeyKeys.some((k) => hint.storeyKeys.includes(k));
      const { score, bits } = scoreBucket(
        hint,
        bucket,
        familyTotals.get(bucket.family) ?? 0,
        storeyFamilyTotals.get(`${bucket.storeyKeys[0] ?? "_"}|${bucket.family}`) ?? 0,
      );
      if (!best || score > best.score) {
        second = best?.score ?? 0;
        best = { bucket, score, bits, familyHit, storeyHit };
      } else if (score > second) {
        second = score;
      }
    }
    if (!best) {
      unmatched.push({
        taskId: task.id,
        ifcTaskId: task.linkedIfcTaskId,
        wbs: task.wbs ?? "",
        name: task.name,
        reason: "Catálogo BIM vazio",
      });
      continue;
    }
    const conf = confidenceOf(best.score, best.familyHit, best.storeyHit);
    if (!conf || best.score < 42) {
      unmatched.push({
        taskId: task.id,
        ifcTaskId: task.linkedIfcTaskId,
        wbs: task.wbs ?? "",
        name: task.name,
        reason: hint.families.length
          ? "Tipo reconhecido, mas sem conjunto IFC suficientemente claro"
          : "Nível reconhecido, mas sem tipo de elemento",
      });
      continue;
    }
    if (second > 0 && best.score - second < 8 && conf !== "high") {
      unmatched.push({
        taskId: task.id,
        ifcTaskId: task.linkedIfcTaskId,
        wbs: task.wbs ?? "",
        name: task.name,
        reason: "Vários conjuntos IFC com pontuação semelhante",
      });
      continue;
    }

    const related = catalog.buckets.filter((b) => {
      if (b.family !== best!.bucket.family) return false;
      const sameStorey =
        (!hint.storeyKeys.length && !best!.bucket.storeyKeys.length) ||
        b.storeyKeys.some((k) => best!.bucket.storeyKeys.includes(k));
      if (!sameStorey) return false;
      if (hint.modelHints.length) return !!b.modelHint && hint.modelHints.includes(b.modelHint);
      return true;
    });
    const merged = mergeGuids(related.length ? related : [best.bucket]);
    const suggestion = toSuggestion(task, best.bucket, best.score, best.bits.join(" · ") || "Correspondência", conf, "rules");
    suggestion.guids = merged.guids;
    suggestion.count = merged.guids.length;
    suggestion.bucketLabel = merged.label;
    suggestion.storey = merged.storey;
    raw.push(suggestion);
  }

  const claimed = new Set<string>();
  const suggestions: AssistSuggestion[] = [];
  for (const row of [...raw].sort((a, b) => b.score - a.score)) {
    const free = row.guids.filter((g) => !claimed.has(g));
    if (!free.length) {
      unmatched.push({
        taskId: row.taskId,
        ifcTaskId: row.ifcTaskId,
        wbs: row.wbs,
        name: row.name,
        reason: "Elementos já atribuídos a outra atividade com melhor pontuação",
      });
      continue;
    }
    free.forEach((g) => claimed.add(g));
    row.guids = free;
    row.count = free.length;
    suggestions.push(row);
  }
  suggestions.sort((a, b) => a.wbs.localeCompare(b.wbs, "pt", { numeric: true }) || a.name.localeCompare(b.name, "pt"));
  unmatched.sort((a, b) => a.wbs.localeCompare(b.wbs, "pt", { numeric: true }));
  return {
    suggestions,
    unmatched,
    skippedLinked,
    skippedSummary,
    catalog: {
      products: catalog.productCount,
      buckets: catalog.buckets.length,
      storeys: catalog.storeyCount,
    },
  };
}

export function applyLlmPicks(report: AssistReport, catalog: BimCatalog, tasks: PlanTask[], picks: LlmBucketPick[]): AssistReport {
  const byId = new Map(catalog.buckets.map((b) => [b.id, b]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const next = { ...report, suggestions: [...report.suggestions], unmatched: [...report.unmatched] };
  for (const pick of picks) {
    const bucket = byId.get(pick.bucketId);
    const task = taskById.get(pick.taskId);
    if (!bucket || !task?.linkedIfcTaskId) continue;
    if (task.isSummary || task.linkedProductGuids.length) continue;
    const conf = pick.confidence ?? "medium";
    const row = toSuggestion(task, bucket, conf === "high" ? 90 : conf === "medium" ? 70 : 50, pick.reason || "IA", conf, "llm");
    const existing = next.suggestions.findIndex((s) => s.taskId === task.id);
    if (existing >= 0) next.suggestions.splice(existing, 1);
    next.unmatched = next.unmatched.filter((u) => u.taskId !== task.id);
    next.suggestions.push(row);
  }
  const claimed = new Set<string>();
  const kept: AssistSuggestion[] = [];
  for (const row of [...next.suggestions].sort((a, b) => b.score - a.score || (a.source === "llm" ? -1 : 1))) {
    const free = row.guids.filter((g) => !claimed.has(g));
    if (!free.length) {
      next.unmatched.push({
        taskId: row.taskId,
        ifcTaskId: row.ifcTaskId,
        wbs: row.wbs,
        name: row.name,
        reason: "Elementos já atribuídos a outra atividade",
      });
      continue;
    }
    free.forEach((g) => claimed.add(g));
    kept.push({ ...row, guids: free, count: free.length });
  }
  next.suggestions = kept.sort((a, b) => a.wbs.localeCompare(b.wbs, "pt", { numeric: true }));
  next.unmatched.sort((a, b) => a.wbs.localeCompare(b.wbs, "pt", { numeric: true }));
  return next;
}

export function compactTasksForLlm(tasks: PlanTask[], report: AssistReport, limit = 60): Array<{
  id: string;
  wbs: string;
  name: string;
  linked: boolean;
}> {
  const suggested = new Set(report.suggestions.map((s) => s.taskId));
  const unmatched = report.unmatched.map((u) => u.taskId);
  const prefer = [...unmatched, ...tasks.filter((t) => !t.isSummary && !t.linkedProductGuids.length && !suggested.has(t.id)).map((t) => t.id)];
  const seen = new Set<string>();
  const rows: Array<{ id: string; wbs: string; name: string; linked: boolean }> = [];
  for (const id of prefer) {
    if (seen.has(id) || rows.length >= limit) break;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.linkedIfcTaskId == null) continue;
    seen.add(id);
    rows.push({ id: task.id, wbs: task.wbs ?? "", name: task.name, linked: suggested.has(id) });
  }
  return rows;
}
