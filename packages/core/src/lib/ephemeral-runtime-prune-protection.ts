/**
 * Advisory protection snapshot for bounded ephemeral-cache pruning.
 *
 * Failure is fail-closed: callers receive `undefined` and skip the whole pass
 * whenever configured or active coordination keys cannot be bounded safely.
 */

import {
  CACHE_KEY_PATTERN,
  PRUNE_PASS_BUDGET_MS,
  remainingBudget,
  type PruneDeadline,
} from './ephemeral-runtime-prune-candidates.js';
import { listActiveRuntimeLeaseKeys, type RuntimeLeaseEvent } from './runtime-lease.js';

import type { EphemeralRuntimeTestHooks } from './ephemeral-runtime.js';
import type { FileLockEvent } from './file-lock.js';

const MAX_PROTECTED_COORDINATION_KEYS = 256;
const PRUNE_ENUMERATION_WAIT_MS = 200;

/** Resolve bounded configured and live coordination keys for one prune pass. */
export async function resolveProtectedCoordinationKeys(
  requested: readonly string[],
  deadline: PruneDeadline,
  onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void,
  hooks?: EphemeralRuntimeTestHooks,
): Promise<ReadonlySet<string> | undefined> {
  if (
    requested.length > MAX_PROTECTED_COORDINATION_KEYS ||
    requested.some((key) => !CACHE_KEY_PATTERN.test(key))
  ) {
    return;
  }
  try {
    const waitMs = remainingBudget(deadline, PRUNE_ENUMERATION_WAIT_MS);
    if (waitMs <= 0) return;
    const active = await listActiveRuntimeLeaseKeys({
      policy: { waitMs, pollMs: 5 },
      onEvent,
    });
    await hooks?.afterActiveSnapshot?.();
    if (remainingBudget(deadline, PRUNE_PASS_BUDGET_MS) <= 0) return;
    const protectedKeys = new Set([...requested, ...active]);
    if (protectedKeys.size > MAX_PROTECTED_COORDINATION_KEYS) return;
    return protectedKeys;
  } catch {
    // @swallow-ok Uncertain lease enumeration disables the entire prune pass.
    return;
  }
}
