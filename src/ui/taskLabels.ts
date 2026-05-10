/**
 * Códigos de fase exportados pelo Bonsai (prefixo DCP-…) — úteis nos dados,
 * mas pouco legíveis na UI; o nome da tarefa (Civil, MEP, …) passa a ser o foco.
 */
export function isInternalProjectCode(ident: string | undefined): boolean {
  if (!ident) return false;
  return /^DCP-/i.test(ident.trim());
}

/** Nome apresentável: remove prefixo de código se vier repetido no Name. */
export function displayTaskName(task: { name: string; identification?: string }): string {
  let n = task.name.trim();
  const id = task.identification?.trim();
  if (id && n.toLowerCase().startsWith(id.toLowerCase())) {
    n = n.slice(id.length).trim();
  }
  if (/^DCP-\d+(\.\d+)*\s+/i.test(n)) {
    n = n.replace(/^DCP-\d+(\.\d+)*\s+/i, "").trim();
  }
  return n || task.name.trim() || "Tarefa";
}
