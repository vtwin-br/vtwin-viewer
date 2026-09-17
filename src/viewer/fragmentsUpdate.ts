import type * as OBC from "@thatopen/components";

interface PendingUpdate {
  scheduled: boolean;
  force: boolean;
  promise: Promise<void> | null;
  resolve: (() => void) | null;
  reject: ((reason: unknown) => void) | null;
}

const pendingByManager = new WeakMap<OBC.FragmentsManager, PendingUpdate>();

/**
 * Consolida pedidos concorrentes numa única atualização Fragments por frame.
 * Operações críticas podem pedir `force`; esse sinal é preservado no lote.
 */
export function requestFragmentsUpdate(
  fragments: OBC.FragmentsManager,
  force = false,
): Promise<void> {
  let pending = pendingByManager.get(fragments);
  if (!pending) {
    pending = {
      scheduled: false,
      force: false,
      promise: null,
      resolve: null,
      reject: null,
    };
    pendingByManager.set(fragments, pending);
  }
  pending.force ||= force;
  if (pending.promise) return pending.promise;

  pending.promise = new Promise<void>((resolve, reject) => {
    pending!.resolve = resolve;
    pending!.reject = reject;
  });
  if (!pending.scheduled) {
    pending.scheduled = true;
    requestAnimationFrame(() => void flushFragmentsUpdate(fragments, pending!));
  }
  return pending.promise;
}

async function flushFragmentsUpdate(
  fragments: OBC.FragmentsManager,
  pending: PendingUpdate,
): Promise<void> {
  const force = pending.force;
  const resolve = pending.resolve;
  const reject = pending.reject;
  pending.scheduled = false;
  pending.force = false;
  pending.promise = null;
  pending.resolve = null;
  pending.reject = null;
  try {
    await fragments.core.update(force);
    resolve?.();
  } catch (error) {
    reject?.(error);
  }
}
