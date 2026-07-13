import { relative, resolve } from 'node:path';

import { isPathInside } from '@opensip-cli/core';

import {
  preflightGlobalFilterCandidates,
  preflightInputs,
  snapshotMembershipOptions,
  snapshotResolutionOptions,
} from './bounded-resolve-inputs.js';
import {
  compileGlobalExcludes,
  compileTargets,
  matchingTargetNames,
  targetRetainsFile,
} from './bounded-resolve-matchers.js';
import { compareCodePointStrings } from './code-point-order.js';
import { walkTargetFilesystem } from './filesystem-walk.js';

import type {
  BoundedTargetMembershipResolution,
  BoundedTargetMembershipResolutionOptions,
  BoundedTargetResolution,
  BoundedTargetResolutionOptions,
  TargetView,
} from '@opensip-cli/core';

export {
  MAX_BOUNDED_BRACE_EXPANSIONS,
  MAX_BOUNDED_GLOBAL_EXCLUDES,
  MAX_BOUNDED_GLOBAL_FILTER_INPUTS,
  MAX_BOUNDED_GLOBAL_FILTER_PATH_BYTES,
  MAX_BOUNDED_PATTERN_BYTES,
  MAX_BOUNDED_TARGET_EXCLUDES,
  MAX_BOUNDED_TARGET_INCLUDES,
  MAX_BOUNDED_TARGET_RESULTS,
  MAX_BOUNDED_TARGETS,
  MAX_BOUNDED_TOTAL_EXPANDED_ALTERNATIVES,
  MAX_BOUNDED_TOTAL_EXPANDED_BYTES,
  MAX_BOUNDED_TOTAL_PATTERNS,
} from './bounded-resolve-inputs.js';

const FILTER_CHECKPOINT_INTERVAL = 128;

function frozenResolution(
  files: readonly string[],
  capped: boolean,
  cancelled: boolean,
): BoundedTargetResolution {
  return Object.freeze({ files: Object.freeze(files), capped, cancelled });
}

function frozenMembershipResolution(
  memberships: BoundedTargetMembershipResolution['memberships'],
  capped: boolean,
  membershipCapped: boolean,
  cancelled: boolean,
): BoundedTargetMembershipResolution {
  return Object.freeze({
    memberships: Object.freeze(memberships),
    capped,
    membershipCapped,
    cancelled,
  });
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolveNow) => setImmediate(resolveNow));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Apply project-wide excludes through a cooperative, hard-bounded surface.
 *
 * Hostile pattern and candidate ceilings are checked before any matcher is
 * constructed. Output is a deterministic, deduplicated prefix and preserves
 * the legacy filter's realpath containment and `{ dot: true }` matching.
 *
 * @throws {RangeError} When a requested result, candidate, or pattern boundary is invalid.
 * @throws {TypeError} When runtime-supplied arrays, paths, or glob patterns are malformed.
 */
export async function applyGlobalExcludesBounded(
  files: readonly string[],
  rootDir: string,
  globalExcludes: readonly string[],
  options: BoundedTargetResolutionOptions,
): Promise<BoundedTargetResolution> {
  const safeOptions = snapshotResolutionOptions(options);
  const safeInputs = preflightInputs([], globalExcludes);
  const safeFiles = preflightGlobalFilterCandidates(files);
  const retained: string[] = [];
  if (isAborted(safeOptions.signal)) return frozenResolution(retained, false, true);

  const absoluteRoot = resolve(rootDir);
  const compiledGlobalExcludes = compileGlobalExcludes(safeInputs.globalExcludes);
  const candidates = [...new Set(safeFiles)].sort(compareCodePointStrings);
  let capped = false;
  for (const [index, filePath] of candidates.entries()) {
    if (index > 0 && index % FILTER_CHECKPOINT_INTERVAL === 0) {
      await yieldToEventLoop();
    }
    if (isAborted(safeOptions.signal)) return frozenResolution(retained, capped, true);
    if (!isPathInside(filePath, absoluteRoot)) continue;
    const relativePath = relative(absoluteRoot, filePath);
    if (compiledGlobalExcludes.some((matcher) => matcher.match(relativePath))) continue;
    if (retained.length >= safeOptions.maxResults) {
      capped = true;
      break;
    }
    retained.push(filePath);
  }
  return frozenResolution(retained, capped, false);
}

/**
 * Resolve exact file-to-target membership in one cooperative filesystem walk.
 *
 * Target matchers are compiled once and evaluated against the same bounded,
 * canonically ordered file stream. This keeps total filesystem work independent
 * of target cardinality while preserving each target's include/exclude semantics.
 * Rows and target names are deterministic code-point prefixes when their hard
 * result or per-file membership ceilings are reached.
 *
 * @throws {RangeError} When a requested result, membership, or config boundary is invalid.
 * @throws {TypeError} When runtime-supplied target arrays or pattern shapes are malformed.
 * @throws {Error} When filesystem expansion fails other than caller cancellation.
 */
export async function resolveTargetMembershipsBounded(
  targets: readonly TargetView[],
  rootDir: string,
  globalExcludes: readonly string[],
  options: BoundedTargetMembershipResolutionOptions,
): Promise<BoundedTargetMembershipResolution> {
  const safeOptions = snapshotMembershipOptions(options);
  const safeInputs = preflightInputs(targets, globalExcludes);
  const memberships: BoundedTargetMembershipResolution['memberships'][number][] = [];
  if (safeOptions.signal?.aborted === true) {
    return frozenMembershipResolution(memberships, false, false, true);
  }
  if (safeInputs.targets.length === 0) {
    return frozenMembershipResolution(memberships, false, false, false);
  }

  const absoluteRoot = resolve(rootDir);
  const compiledTargets = compileTargets(safeInputs.targets);
  const compiledGlobalExcludes = compileGlobalExcludes(safeInputs.globalExcludes);
  let resultLimitReached = false;
  let membershipLimitReached = false;
  const walk = await walkTargetFilesystem(
    absoluteRoot,
    ({ absolutePath, relativePath }) => {
      if (compiledGlobalExcludes.some((matcher) => matcher.match(relativePath))) return true;
      const targetNames = matchingTargetNames(compiledTargets, relativePath, absolutePath);
      if (targetNames.length === 0) return true;
      if (memberships.length >= safeOptions.maxResults) {
        resultLimitReached = true;
        return false;
      }
      if (targetNames.length > safeOptions.maxTargetsPerFile) membershipLimitReached = true;
      memberships.push(
        Object.freeze({
          filePath: absolutePath,
          targetNames: Object.freeze(targetNames.slice(0, safeOptions.maxTargetsPerFile)),
        }),
      );
      return true;
    },
    { signal: safeOptions.signal },
  );
  return frozenMembershipResolution(
    memberships,
    resultLimitReached || walk.capped,
    membershipLimitReached,
    walk.cancelled,
  );
}

/**
 * Resolve targets through a cooperative filesystem walk while retaining only
 * the code-point-smallest `maxResults` unique paths.
 *
 * One manual `opendir` DFS scans the root regardless of target cardinality.
 * Every complete directory batch is code-point sorted before processing, so
 * enumeration is globally ordered and can stop after probing match N+1. The
 * walk never follows directory symlinks and has hard depth, directory, entry,
 * per-directory, and frontier ceilings. All config/result ceilings are
 * validated before the filesystem is opened.
 *
 * @throws {RangeError} When a requested result or config boundary is invalid.
 * @throws {TypeError} When runtime-supplied target arrays or pattern shapes are malformed.
 * @throws {Error} When filesystem expansion fails other than caller cancellation.
 */
export async function resolveTargetsBounded(
  targets: readonly TargetView[],
  rootDir: string,
  globalExcludes: readonly string[],
  options: BoundedTargetResolutionOptions,
): Promise<BoundedTargetResolution> {
  const safeOptions = snapshotResolutionOptions(options);
  const safeInputs = preflightInputs(targets, globalExcludes);
  const files: string[] = [];
  if (safeOptions.signal?.aborted === true) return frozenResolution(files, false, true);
  if (safeInputs.targets.length === 0) return frozenResolution(files, false, false);

  const absoluteRoot = resolve(rootDir);
  const compiledTargets = compileTargets(safeInputs.targets);
  const compiledGlobalExcludes = compileGlobalExcludes(safeInputs.globalExcludes);
  let resultLimitReached = false;
  const walk = await walkTargetFilesystem(
    absoluteRoot,
    ({ absolutePath, relativePath }) => {
      if (compiledGlobalExcludes.some((matcher) => matcher.match(relativePath))) return true;
      if (
        !compiledTargets.some((target) => targetRetainsFile(target, relativePath, absolutePath))
      ) {
        return true;
      }
      if (files.length >= safeOptions.maxResults) {
        resultLimitReached = true;
        return false;
      }
      files.push(absolutePath);
      return true;
    },
    { signal: safeOptions.signal },
  );
  return frozenResolution(files, resultLimitReached || walk.capped, walk.cancelled);
}
