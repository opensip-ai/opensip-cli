/**
 * Shape validation for the values a bounded target-resolver capability returns.
 *
 * Split from `target-resolver-bounds.ts` when that file passed the repository's file-length
 * bound. The seam is real rather than arbitrary: everything here is a pure predicate over a
 * value that has already been returned — no I/O, no deadline, no cancellation — while the
 * module it came from is entirely about INVOKING a foreign capability under a bound.
 */

import { isAbsolute } from 'node:path';

import { isPlainRecord, tryCatch } from '@opensip-cli/core';

import { CONTROL_CHARACTER } from './inventory-helpers.js';
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

/** The capability never answered: the wait ended on a bound, not on an observation. */
