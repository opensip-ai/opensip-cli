import { braceExpand } from 'minimatch';

import type {
  BoundedTargetMembershipResolutionOptions,
  BoundedTargetResolutionOptions,
  TargetView,
} from '@opensip-cli/core';

/** Product inventory ceiling; callers cannot request an unbounded result set. */
export const MAX_BOUNDED_TARGET_RESULTS = 20_000;

/** Candidate-input ceiling for bounded global-exclude filtering. */
export const MAX_BOUNDED_GLOBAL_FILTER_INPUTS = MAX_BOUNDED_TARGET_RESULTS;

/** UTF-8 byte ceiling for a candidate path supplied to the bounded filter. */
export const MAX_BOUNDED_GLOBAL_FILTER_PATH_BYTES = 16 * 1024;

/** Hostile-config ceiling on target definitions in one bounded resolution. */
export const MAX_BOUNDED_TARGETS = 128;

/** Hostile-config ceiling on include patterns in one target. */
export const MAX_BOUNDED_TARGET_INCLUDES = 128;

/** Hostile-config ceiling on exclude patterns in one target. */
export const MAX_BOUNDED_TARGET_EXCLUDES = 128;

/** Hostile-config ceiling on project-wide excludes. */
export const MAX_BOUNDED_GLOBAL_EXCLUDES = 128;

/** Hostile-config ceiling across every include and exclude pattern. */
export const MAX_BOUNDED_TOTAL_PATTERNS = 512;

/** UTF-8 byte ceiling for any one glob pattern. */
export const MAX_BOUNDED_PATTERN_BYTES = 2048;

/** Maximum brace alternatives accepted from any one glob pattern. */
export const MAX_BOUNDED_BRACE_EXPANSIONS = 128;

/** Aggregate retained brace alternatives across every matcher construction. */
export const MAX_BOUNDED_TOTAL_EXPANDED_ALTERNATIVES = 2048;

/** Aggregate UTF-8 bytes retained across every brace-expanded matcher input. */
export const MAX_BOUNDED_TOTAL_EXPANDED_BYTES = 1024 * 1024;

const CONTROL_CHARACTER = /\p{Cc}/u;

interface PatternPreflightInput {
  /** Target excludes are compiled once for glob-ignore parity and once as a post-filter. */
  readonly compilationMultiplicity: 1 | 2;
  readonly pattern: unknown;
}

export interface PreflightedTargetInputs {
  readonly globalExcludes: readonly string[];
  readonly targets: readonly TargetView[];
}

/**
 * Snapshot a hostile array by bounded numeric index without invoking its overridable iterator.
 *
 * @throws {TypeError} When the input is not an array or has an invalid runtime length.
 * @throws {RangeError} When the array exceeds the supplied maximum.
 */
function boundedArraySnapshot(
  value: unknown,
  maximum: number,
  description: string,
): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${description} must be an array`);
  const count = value.length;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`${description} must have a valid array length`);
  }
  if (count > maximum) throw new RangeError(`${description} cannot exceed ${maximum}`);
  return Array.from({ length: count }, (_, index): unknown => value[index]);
}

/** @throws {TypeError | RangeError} When a pattern collection crosses its boundary. */
function patternArray(value: unknown, maximum: number, description: string): readonly string[] {
  return boundedArraySnapshot(value, maximum, description) as readonly string[];
}

/**
 * Snapshot and validate the shared bounded-resolution options.
 *
 * @throws {RangeError} When `maxResults` is not within the product result ceiling.
 */
export function snapshotResolutionOptions(
  options: BoundedTargetResolutionOptions,
): BoundedTargetResolutionOptions {
  const maxResults = options.maxResults;
  if (
    !Number.isSafeInteger(maxResults) ||
    maxResults < 0 ||
    maxResults > MAX_BOUNDED_TARGET_RESULTS
  ) {
    throw new RangeError(
      `maxResults must be a non-negative safe integer no greater than ${MAX_BOUNDED_TARGET_RESULTS}`,
    );
  }
  const signal = options.signal;
  return Object.freeze({ maxResults, ...(signal === undefined ? {} : { signal }) });
}

/**
 * Snapshot and validate membership bounds before any filesystem or matcher work.
 *
 * @throws {RangeError} When `maxTargetsPerFile` or `maxResults` exceeds its hard boundary.
 */
export function snapshotMembershipOptions(
  options: BoundedTargetMembershipResolutionOptions,
): BoundedTargetMembershipResolutionOptions {
  const maxTargetsPerFile = options.maxTargetsPerFile;
  if (
    !Number.isSafeInteger(maxTargetsPerFile) ||
    maxTargetsPerFile < 1 ||
    maxTargetsPerFile > MAX_BOUNDED_TARGETS
  ) {
    throw new RangeError(
      `maxTargetsPerFile must be a positive safe integer no greater than ${MAX_BOUNDED_TARGETS}`,
    );
  }
  const base = snapshotResolutionOptions(options);
  return Object.freeze({ ...base, maxTargetsPerFile });
}

/**
 * @throws {TypeError | RangeError} When a pattern is malformed or its encoded or expanded form
 *   exceeds a hard ceiling.
 */
function safePatternExpansions(pattern: unknown): readonly string[] {
  if (typeof pattern !== 'string') throw new TypeError('Target glob patterns must be strings');
  if (Buffer.byteLength(pattern, 'utf8') > MAX_BOUNDED_PATTERN_BYTES) {
    throw new RangeError(`Target glob patterns cannot exceed ${MAX_BOUNDED_PATTERN_BYTES} bytes`);
  }
  const expansions = braceExpand(pattern, {
    braceExpandMax: MAX_BOUNDED_BRACE_EXPANSIONS + 1,
  });
  if (expansions.length > MAX_BOUNDED_BRACE_EXPANSIONS) {
    throw new RangeError(
      `Target glob patterns cannot expand to more than ${MAX_BOUNDED_BRACE_EXPANSIONS} braces`,
    );
  }
  if (expansions.some((expanded) => expanded.split(/[\\/]+/u).includes('..'))) {
    throw new RangeError('Target glob patterns cannot contain parent path segments');
  }
  return expansions;
}

/**
 * @throws {TypeError | RangeError} When any pattern is malformed or the aggregate expansion
 *   budget is exceeded.
 */
function preflightExpandedPatternBudget(patterns: readonly PatternPreflightInput[]): void {
  let alternativeCount = 0;
  let expandedBytes = 0;
  for (const { compilationMultiplicity, pattern } of patterns) {
    const expansions = safePatternExpansions(pattern);
    alternativeCount += expansions.length * compilationMultiplicity;
    expandedBytes +=
      expansions.reduce((total, expanded) => total + Buffer.byteLength(expanded, 'utf8'), 0) *
      compilationMultiplicity;
    if (alternativeCount > MAX_BOUNDED_TOTAL_EXPANDED_ALTERNATIVES) {
      throw new RangeError(
        `Total expanded target alternatives cannot exceed ${MAX_BOUNDED_TOTAL_EXPANDED_ALTERNATIVES}`,
      );
    }
    if (expandedBytes > MAX_BOUNDED_TOTAL_EXPANDED_BYTES) {
      throw new RangeError(
        `Total expanded target pattern bytes cannot exceed ${MAX_BOUNDED_TOTAL_EXPANDED_BYTES}`,
      );
    }
  }
}

/**
 * @throws {TypeError | RangeError} When target arrays or glob patterns are malformed or exceed a
 *   hard ceiling.
 */
export function preflightInputs(
  targets: readonly TargetView[],
  globalExcludes: readonly string[],
): PreflightedTargetInputs {
  const targetInputs = boundedArraySnapshot(targets, MAX_BOUNDED_TARGETS, 'Target count');
  const safeGlobalExcludes = patternArray(
    globalExcludes,
    MAX_BOUNDED_GLOBAL_EXCLUDES,
    'Global exclude count',
  );
  let patternCount = safeGlobalExcludes.length;
  const patterns: PatternPreflightInput[] = [];
  for (const pattern of safeGlobalExcludes) {
    patterns.push({ compilationMultiplicity: 1, pattern });
  }
  const safeTargets: TargetView[] = [];
  for (const targetInput of targetInputs) {
    if (typeof targetInput !== 'object' || targetInput === null) {
      throw new TypeError('Targets must contain config objects');
    }
    const config = (targetInput as { readonly config?: unknown }).config;
    if (typeof config !== 'object' || config === null) {
      throw new TypeError('Targets must contain config objects');
    }
    const targetConfig = config as {
      readonly exclude?: unknown;
      readonly include?: unknown;
      readonly name?: unknown;
    };
    const include = patternArray(
      targetConfig.include,
      MAX_BOUNDED_TARGET_INCLUDES,
      'Target include count',
    );
    const exclude = patternArray(
      targetConfig.exclude,
      MAX_BOUNDED_TARGET_EXCLUDES,
      'Target exclude count',
    );
    const name = targetConfig.name;
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      Buffer.byteLength(name, 'utf8') > MAX_BOUNDED_PATTERN_BYTES ||
      CONTROL_CHARACTER.test(name)
    ) {
      throw new TypeError('Target names must be bounded non-empty strings');
    }
    patternCount += include.length + exclude.length;
    for (const pattern of include) patterns.push({ compilationMultiplicity: 1, pattern });
    for (const pattern of exclude) patterns.push({ compilationMultiplicity: 2, pattern });
    safeTargets.push(
      Object.freeze({
        config: Object.freeze({
          name,
          description: '',
          include: Object.freeze(include),
          exclude: Object.freeze(exclude),
        }),
      }),
    );
  }
  if (patternCount > MAX_BOUNDED_TOTAL_PATTERNS) {
    throw new RangeError(`Total target pattern count cannot exceed ${MAX_BOUNDED_TOTAL_PATTERNS}`);
  }
  preflightExpandedPatternBudget(patterns);
  return Object.freeze({
    globalExcludes: Object.freeze(safeGlobalExcludes),
    targets: Object.freeze(safeTargets),
  });
}

/**
 * @throws {TypeError | RangeError} When candidate paths are malformed or exceed a hard ceiling.
 */
export function preflightGlobalFilterCandidates(files: readonly string[]): readonly string[] {
  const candidates = boundedArraySnapshot(
    files,
    MAX_BOUNDED_GLOBAL_FILTER_INPUTS,
    'Global filter candidate count',
  );
  const copied: string[] = [];
  for (const filePath of candidates) {
    if (typeof filePath !== 'string') {
      throw new TypeError('Global filter candidate paths must be strings');
    }
    if (
      filePath.length === 0 ||
      Buffer.byteLength(filePath, 'utf8') > MAX_BOUNDED_GLOBAL_FILTER_PATH_BYTES ||
      CONTROL_CHARACTER.test(filePath)
    ) {
      throw new RangeError('Global filter candidate path is outside its hard bounds');
    }
    copied.push(filePath);
  }
  return Object.freeze(copied);
}
