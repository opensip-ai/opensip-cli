/**
 * Bounded invocation of a project's target-resolver capability.
 *
 * The result-shape validators moved to `target-resolver-validation.ts` and are re-exported
 * below, so this module's public surface is unchanged.
 */

import { currentScope, tryCatchAsync } from '@opensip-cli/core';

import {
  BOUNDED_CAPABILITY_TIMEOUT_REASON,
  INVENTORY_CANCELLED_REASON,
} from './inventory-helpers.js';
import {
  validateBoundedTargetMembershipResolution,
  validateBoundedTargetResolution,
} from './target-resolver-validation.js';
import { MAX_BOUNDED_CAPABILITY_MS } from './types.js';

import type { BoundedResolutionReasons } from './target-resolver-validation.js';
import type {
  BoundedTargetMembershipResolution,
  BoundedTargetResolution,
  BoundedTargetResolver,
  Result,
} from '@opensip-cli/core';

Object.freeze({ valid: false });

type CapabilityInterrupt = 'cancelled' | 'timeout';

/**
 * Await one foreign capability with a hard bound, WITHOUT discarding an answer it already
 * gave.
 *
 * `try/catch` alone only covers the case where foreign code FAILS, never the case where it
 * does not answer at all: a resolver that hangs outlives every entry, byte and file bound
 * inventory owns, and ignores cancellation entirely. So the wait is raced against a
 * deadline and the cancel signal.
 *
 * The race deliberately PREFERS a settled call over a simultaneous interrupt, and that is
 * why this is not `runWithTimeout` from the core execution substrate. That primitive is
 * built for scheduling units, where a cancelled unit's result is worthless, so its
 * parent-abort arm resolves ahead of an already-rejected work promise. Here the result is
 * evidence: a capability that returned a malformed value, or threw, has told us something
 * about the host that a concurrent Ctrl-C must not erase. Deferring the interrupt arm by
 * one macrotask makes the preference deterministic rather than a microtask-ordering
 * accident — a promise that has settled always drains before the check phase — while a
 * genuinely hung call is still abandoned immediately after the abort.
 *
 * Per ruling D5 the cancel plane falls back to the ambient run signal when the caller
 * threads none.
 */
async function settleBoundedCapability(
  invoke: () => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<Result<unknown, Error> | CapabilityInterrupt> {
  const work = tryCatchAsync(invoke);
  // Only a real AbortSignal can be raced. A caller that hands an internal seam a
  // duck-typed object still gets the deadline plus the `.aborted` polling the surrounding
  // code performs, instead of a crash inside the race wiring; `buildProjectInventory`
  // refuses such a value at its own boundary (ruling D6).
  const cancel = signal instanceof AbortSignal ? signal : currentScope()?.abortSignal;
  const interrupt = new Promise<CapabilityInterrupt>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), MAX_BOUNDED_CAPABILITY_MS);
    timer.unref?.();
    const onAbort = (): void => {
      setImmediate(() => resolve('cancelled'));
    };
    if (cancel?.aborted === true) onAbort();
    else cancel?.addEventListener('abort', onAbort, { once: true });
    void work.finally(() => {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onAbort);
    });
  });
  return Promise.race([work, interrupt]);
}

/**
 * Invoke and classify one host-supplied bounded capability.
 *
 * Returns the raw capability value, or `undefined` after recording why there is none. An
 * interrupt and an observed fault are reported differently on purpose: attributing
 * `reasonCodes.failure` to a call that was merely cancelled would publish a host fault
 * that was never committed.
 */
async function invokeBoundedCapability(
  invoke: () => Promise<unknown>,
  reasons: Set<string>,
  reasonCodes: BoundedResolutionReasons,
  signal: AbortSignal | undefined,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  const settled = await settleBoundedCapability(invoke, signal);
  if (settled === 'timeout') {
    reasons.add(BOUNDED_CAPABILITY_TIMEOUT_REASON);
    reasons.add(reasonCodes.failure);
    return { ok: false };
  }
  if (settled === 'cancelled') {
    reasons.add(INVENTORY_CANCELLED_REASON);
    return { ok: false };
  }
  if (!settled.ok) {
    if (signal?.aborted === true) reasons.add(INVENTORY_CANCELLED_REASON);
    reasons.add(reasonCodes.failure);
    // @swallow-ok: the failure is surfaced as a bounded reason code; the error detail is intentionally not logged here.
    return { ok: false };
  }
  return { ok: true, value: settled.value };
}

/** Invoke and validate one bounded host capability, adding stable trust reasons. */
export async function invokeBoundedTargetResolution(
  invoke: () => Promise<unknown>,
  maximumFiles: number,
  reasons: Set<string>,
  reasonCodes: BoundedResolutionReasons,
  signal?: AbortSignal,
): Promise<BoundedTargetResolution | undefined> {
  const invoked = await invokeBoundedCapability(invoke, reasons, reasonCodes, signal);
  if (!invoked.ok) {
    // @swallow-ok the failure is already surfaced: `invokeBoundedCapability` records it into
    // `reasons`/`reasonCodes`, which become the resolution's coverage reasons. Returning the
    // error again here would double-report one condition.
    return undefined;
  }
  const validated = validateBoundedTargetResolution(invoked.value, maximumFiles);
  const aborted = signal?.aborted === true;
  if (aborted) reasons.add(INVENTORY_CANCELLED_REASON);
  if (validated === undefined) reasons.add(reasonCodes.invalid);
  if (aborted) return undefined;
  return validated;
}

/** Invoke and validate one shared-walk membership capability. */
export async function invokeBoundedTargetMembershipResolution(input: {
  readonly expectedTargetNames: ReadonlySet<string>;
  readonly invoke: () => Promise<unknown>;
  readonly maximumFiles: number;
  readonly maximumTargetsPerFile: number;
  readonly reasonCodes: BoundedResolutionReasons;
  readonly reasons: Set<string>;
  readonly signal?: AbortSignal;
}): Promise<BoundedTargetMembershipResolution | undefined> {
  const invoked = await invokeBoundedCapability(
    input.invoke,
    input.reasons,
    input.reasonCodes,
    input.signal,
  );
  if (!invoked.ok) {
    // @swallow-ok same as above — the reason accumulator already carries it.
    return undefined;
  }
  const validated = validateBoundedTargetMembershipResolution(
    invoked.value,
    input.maximumFiles,
    input.maximumTargetsPerFile,
    input.expectedTargetNames,
  );
  const aborted = input.signal?.aborted === true;
  if (aborted) input.reasons.add(INVENTORY_CANCELLED_REASON);
  if (validated === undefined) input.reasons.add(input.reasonCodes.invalid);
  if (aborted) return undefined;
  return validated;
}

/** Apply global exclusions through the bounded surface and qualify truncation. */
export async function applyBoundedGlobalExcludes(input: {
  readonly files: readonly string[];
  readonly maximumFiles: number;
  readonly projectRoot: string;
  readonly reasons: Set<string>;
  readonly resolver: BoundedTargetResolver;
  readonly signal?: AbortSignal;
}): Promise<readonly string[]> {
  const resolved = await invokeBoundedTargetResolution(
    () =>
      input.resolver.applyGlobalExcludesBounded(input.files, input.projectRoot, {
        maxResults: input.maximumFiles,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    input.maximumFiles,
    input.reasons,
    {
      failure: 'global-exclude-filter-failed',
      invalid: 'bounded-global-filter-invalid',
    },
    input.signal,
  );
  if (resolved === undefined) return [];
  const candidates = new Set(input.files);
  if (resolved.files.some((filePath) => !candidates.has(filePath))) {
    input.reasons.add('bounded-global-filter-invalid');
    return [];
  }
  if (resolved.capped) input.reasons.add('file-cap-reached');
  if (resolved.cancelled) input.reasons.add(INVENTORY_CANCELLED_REASON);
  return resolved.files;
}

/**
 * Validate hostile global-exclude configuration through a zero-retention call
 * before inventory performs any manifest or structural filesystem discovery.
 */
export async function preflightBoundedTargetResolver(input: {
  readonly projectRoot: string;
  readonly resolver: BoundedTargetResolver;
  readonly reasons: Set<string>;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const files = await applyBoundedGlobalExcludes({
    files: [],
    maximumFiles: 0,
    projectRoot: input.projectRoot,
    reasons: input.reasons,
    resolver: input.resolver,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return files.length === 0 && input.reasons.size === 0;
}

export {
  validateBoundedTargetMembershipResolution,
  asBoundedTargetMembershipResolver,
  asBoundedTargetResolver,
  validateBoundedTargetResolution,
} from './target-resolver-validation.js';
