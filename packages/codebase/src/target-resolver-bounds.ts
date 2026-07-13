import { isAbsolute } from 'node:path';

import { isPlainRecord, tryCatch, tryCatchAsync } from '@opensip-cli/core';

import { CONTROL_CHARACTER, INVENTORY_CANCELLED_REASON } from './inventory-helpers.js';
import { MAX_TARGET_NAME, MAX_TARGET_RESOLVED_PATH_LENGTH } from './types.js';

import type {
  BoundedTargetMembershipResolution,
  BoundedTargetMembershipResolver,
  BoundedTargetResolution,
  BoundedTargetResolver,
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

/** Invoke and validate one bounded host capability, adding stable trust reasons. */
export async function invokeBoundedTargetResolution(
  invoke: () => Promise<unknown>,
  maximumFiles: number,
  reasons: Set<string>,
  reasonCodes: BoundedResolutionReasons,
  signal?: AbortSignal,
): Promise<BoundedTargetResolution | undefined> {
  const invoked = await tryCatchAsync(invoke);
  if (!invoked.ok) {
    if (signal?.aborted === true) reasons.add(INVENTORY_CANCELLED_REASON);
    reasons.add(reasonCodes.failure);
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
  const invoked = await tryCatchAsync(input.invoke);
  if (!invoked.ok) {
    if (input.signal?.aborted === true) input.reasons.add(INVENTORY_CANCELLED_REASON);
    input.reasons.add(input.reasonCodes.failure);
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
