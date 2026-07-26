import { isAbsolute } from 'node:path';

import { currentScope, isPlainRecord, tryCatch, tryCatchAsync } from '@opensip-cli/core';

import {
  BOUNDED_CAPABILITY_TIMEOUT_REASON,
  CONTROL_CHARACTER,
  INVENTORY_CANCELLED_REASON,
} from './inventory-helpers.js';
import {
  MAX_BOUNDED_CAPABILITY_MS,
  MAX_TARGET_NAME,
  MAX_TARGET_RESOLVED_PATH_LENGTH,
} from './types.js';

import type {
  BoundedTargetMembershipResolution,
  BoundedTargetMembershipResolver,
  BoundedTargetResolution,
  BoundedTargetResolver,
  Result,
  TargetResolver,
} from '@opensip-cli/core';

interface InvalidBoundedTargetResolution {
  readonly valid: false;
}

interface ValidBoundedTargetResolution {
  readonly resolution: BoundedTargetResolution;
  readonly valid: true;
}

type BoundedTargetResolutionValidation =
  InvalidBoundedTargetResolution | ValidBoundedTargetResolution;

const INVALID_BOUNDED_TARGET_RESOLUTION: InvalidBoundedTargetResolution = Object.freeze({
  valid: false,
});

interface InvalidBoundedTargetMembershipResolution {
  readonly valid: false;
}

interface ValidBoundedTargetMembershipResolution {
  readonly resolution: BoundedTargetMembershipResolution;
  readonly valid: true;
}

type BoundedTargetMembershipValidation =
  InvalidBoundedTargetMembershipResolution | ValidBoundedTargetMembershipResolution;

const INVALID_BOUNDED_TARGET_MEMBERSHIP_RESOLUTION: InvalidBoundedTargetMembershipResolution =
  Object.freeze({ valid: false });

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validAbsoluteResultPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TARGET_RESOLVED_PATH_LENGTH &&
    !CONTROL_CHARACTER.test(value) &&
    isAbsolute(value)
  );
}

function copyTargetNames(
  value: unknown,
  maximumTargetsPerFile: number,
  expectedTargetNames: ReadonlySet<string>,
): readonly string[] | undefined {
  if (!Array.isArray(value)) return;
  const targetNameCount = value.length;
  if (
    typeof targetNameCount !== 'number' ||
    !Number.isSafeInteger(targetNameCount) ||
    targetNameCount <= 0 ||
    targetNameCount > maximumTargetsPerFile
  ) {
    return;
  }
  const targetNames = Array.from({ length: targetNameCount }, (_, index): unknown => value[index]);
  const copied: string[] = [];
  const unique = new Set<string>();
  for (const targetName of targetNames) {
    if (
      typeof targetName !== 'string' ||
      targetName.length === 0 ||
      targetName.length > MAX_TARGET_NAME ||
      CONTROL_CHARACTER.test(targetName) ||
      !expectedTargetNames.has(targetName) ||
      unique.has(targetName)
    ) {
      return;
    }
    unique.add(targetName);
    copied.push(targetName);
  }
  return Object.freeze(copied);
}

function copyTargetMembership(
  value: unknown,
  uniqueFiles: Set<string>,
  maximumTargetsPerFile: number,
  expectedTargetNames: ReadonlySet<string>,
): BoundedTargetMembershipResolution['memberships'][number] | undefined {
  if (!isPlainDataRecord(value)) return;
  const { filePath, targetNames } = value;
  if (!validAbsoluteResultPath(filePath) || uniqueFiles.has(filePath)) return;
  const copiedTargetNames = copyTargetNames(
    targetNames,
    maximumTargetsPerFile,
    expectedTargetNames,
  );
  if (copiedTargetNames === undefined) return;
  uniqueFiles.add(filePath);
  return Object.freeze({ filePath, targetNames: copiedTargetNames });
}

/** Runtime-qualified failure reasons for one bounded capability invocation. */
export interface BoundedResolutionReasons {
  readonly failure: string;
  readonly invalid: string;
}

/**
 * Feature-detect the complete bounded targeting surface without trusting
 * property accessors supplied by an external host.
 */
export function asBoundedTargetResolver(
  resolver: TargetResolver,
): BoundedTargetResolver | undefined {
  const checked = tryCatch(() => {
    const candidate = resolver as TargetResolver & {
      readonly applyGlobalExcludesBounded?: unknown;
      readonly resolveTargetsBounded?: unknown;
    };
    return (
      typeof candidate.resolveTargetsBounded === 'function' &&
      typeof candidate.applyGlobalExcludesBounded === 'function'
    );
  });
  return checked.ok && checked.value ? (resolver as BoundedTargetResolver) : undefined;
}

/** Feature-detect the shared-walk membership capability through guarded property access. */
export function asBoundedTargetMembershipResolver(
  resolver: BoundedTargetResolver,
): BoundedTargetMembershipResolver | undefined {
  const checked = tryCatch(
    () =>
      typeof (
        resolver as BoundedTargetResolver & {
          resolveTargetMembershipsBounded?: unknown;
        }
      ).resolveTargetMembershipsBounded === 'function',
  );
  return checked.ok && checked.value ? (resolver as BoundedTargetMembershipResolver) : undefined;
}

/**
 * Validate a host result before copying, sorting, spreading, or iterating it.
 * The defensive boundary catches hostile proxies/getters as well as malformed
 * plain values and copies only after every retained path has passed its bounds.
 */
export function validateBoundedTargetResolution(
  value: unknown,
  maximumFiles: number,
): BoundedTargetResolution | undefined {
  const checked = tryCatch<BoundedTargetResolutionValidation>(() => {
    if (!isPlainRecord(value)) return INVALID_BOUNDED_TARGET_RESOLUTION;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return INVALID_BOUNDED_TARGET_RESOLUTION;
    }
    const { cancelled, capped, files } = value;
    if (typeof capped !== 'boolean' || typeof cancelled !== 'boolean' || !Array.isArray(files)) {
      return INVALID_BOUNDED_TARGET_RESOLUTION;
    }
    const fileCount = files.length;
    if (
      typeof fileCount !== 'number' ||
      !Number.isSafeInteger(fileCount) ||
      fileCount < 0 ||
      fileCount > maximumFiles
    ) {
      return INVALID_BOUNDED_TARGET_RESOLUTION;
    }
    const copiedFiles: string[] = [];
    const uniqueFiles = new Set<string>();
    for (let index = 0; index < fileCount; index += 1) {
      const filePath: unknown = files[index];
      if (
        typeof filePath !== 'string' ||
        filePath.length === 0 ||
        filePath.length > MAX_TARGET_RESOLVED_PATH_LENGTH ||
        CONTROL_CHARACTER.test(filePath) ||
        !isAbsolute(filePath)
      ) {
        return INVALID_BOUNDED_TARGET_RESOLUTION;
      }
      if (uniqueFiles.has(filePath)) return INVALID_BOUNDED_TARGET_RESOLUTION;
      uniqueFiles.add(filePath);
      copiedFiles.push(filePath);
    }
    return Object.freeze({
      resolution: Object.freeze({
        files: Object.freeze(copiedFiles),
        capped,
        cancelled,
      }),
      valid: true,
    });
  });
  if (!checked.ok || !checked.value.valid) return;
  return checked.value.resolution;
}

/**
 * Validate one shared-walk membership result before retaining or iterating any
 * host-owned arrays. Target names must be an exact subset of the requested set.
 */
export function validateBoundedTargetMembershipResolution(
  value: unknown,
  maximumFiles: number,
  maximumTargetsPerFile: number,
  expectedTargetNames: ReadonlySet<string>,
): BoundedTargetMembershipResolution | undefined {
  const checked = tryCatch<BoundedTargetMembershipValidation>(() => {
    if (!isPlainDataRecord(value)) return INVALID_BOUNDED_TARGET_MEMBERSHIP_RESOLUTION;
    const { cancelled, capped, membershipCapped, memberships } = value;
    const membershipCount = Array.isArray(memberships) ? memberships.length : -1;
    if (
      typeof capped !== 'boolean' ||
      typeof cancelled !== 'boolean' ||
      typeof membershipCapped !== 'boolean' ||
      !Array.isArray(memberships) ||
      typeof membershipCount !== 'number' ||
      !Number.isSafeInteger(membershipCount) ||
      membershipCount < 0 ||
      membershipCount > maximumFiles
    ) {
      return INVALID_BOUNDED_TARGET_MEMBERSHIP_RESOLUTION;
    }
    const membershipInputs = Array.from(
      { length: membershipCount },
      (_, index): unknown => memberships[index],
    );
    const copiedMemberships: {
      readonly filePath: string;
      readonly targetNames: readonly string[];
    }[] = [];
    const uniqueFiles = new Set<string>();
    for (const membership of membershipInputs) {
      const copied = copyTargetMembership(
        membership,
        uniqueFiles,
        maximumTargetsPerFile,
        expectedTargetNames,
      );
      if (copied === undefined) return INVALID_BOUNDED_TARGET_MEMBERSHIP_RESOLUTION;
      copiedMemberships.push(copied);
    }
    return Object.freeze({
      resolution: Object.freeze({
        memberships: Object.freeze(copiedMemberships),
        capped,
        membershipCapped,
        cancelled,
      }),
      valid: true,
    });
  });
  if (!checked.ok || !checked.value.valid) return;
  return checked.value.resolution;
}

/** The capability never answered: the wait ended on a bound, not on an observation. */
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
