import { aiChatJson } from "../ai/client";
import type { AssistConfidence, LlmBucketPick } from "./linkAssist";

export async function refineWithAi(input: {
  tasks: Array<{ id: string; wbs: string; name: string; linked: boolean }>;
  buckets: Array<{ id: string; label: string; family: string; storey: string | null; count: number; samples: string[] }>;
}): Promise<LlmBucketPick[]> {
  const parsed = await aiChatJson<{
    matches?: Array<{ taskId?: string; bucketId?: string; confidence?: string; reason?: string }>;
  }>({
    temperature: 0,
    json: true,
    messages: [
      {
        role: "system",
        content:
          "És um coordenador BIM 4D. Liga atividades de cronograma a conjuntos IFC (nível + família). Só podes usar bucketId da lista. Não inventes GUIDs nem datas. Responde JSON {\"matches\":[{\"taskId\",\"bucketId\",\"confidence\":\"high|medium|low\",\"reason\"}]}. Omite tarefas sem correspondência clara. Prefere tarefas folha (execução) a resumos.",
      },
      {
        role: "user",
        content: JSON.stringify({
          tarefas: input.tasks,
          conjuntos: input.buckets,
        }),
      },
    ],
  });
  const allowed = new Set(input.buckets.map((b) => b.id));
  const tasks = new Set(input.tasks.map((t) => t.id));
  const out: LlmBucketPick[] = [];
  for (const row of parsed.matches ?? []) {
    if (!row.taskId || !row.bucketId || !tasks.has(row.taskId) || !allowed.has(row.bucketId)) continue;
    const confidence: AssistConfidence =
      row.confidence === "high" || row.confidence === "low" || row.confidence === "medium" ? row.confidence : "medium";
    out.push({
      taskId: row.taskId,
      bucketId: row.bucketId,
      confidence,
      reason: (row.reason || "IA").slice(0, 160),
    });
  }
  return out;
}
