import { braceExpand, Minimatch } from 'minimatch';

import { byCodePoint, deepFreeze } from './freeze.js';
import { CONTROL_CHARACTER } from './inventory-helpers.js';
import { MAX_WORKSPACE_PATTERNS } from './types.js';

import type { MinimatchOptions } from 'minimatch';

/** UTF-8 ceiling for one authored workspace glob. */
export const MAX_WORKSPACE_PATTERN_BYTES = 2048;

/**
 * Maximum authored entries inspected from one package.json or pnpm workspace
 * array. This is deliberately larger than the retained-pattern ceiling so a
 * bounded number of duplicates or malformed entries cannot crowd out every
 * usable declaration.
 */
export const MAX_WORKSPACE_AUTHORED_PATTERNS = MAX_WORKSPACE_PATTERNS * 4;

/** Maximum brace alternatives accepted from one workspace glob. */
export const MAX_WORKSPACE_BRACE_EXPANSIONS = 128;

/** Aggregate brace alternatives retained by one inventory build. */
export const MAX_WORKSPACE_TOTAL_EXPANDED_ALTERNATIVES = 2048;

/** Aggregate expanded UTF-8 bytes retained by one inventory build. */
export const MAX_WORKSPACE_TOTAL_EXPANDED_BYTES = 1024 * 1024;

const WORKSPACE_MATCH_OPTIONS: Readonly<MinimatchOptions> = Object.freeze({
  braceExpandMax: MAX_WORKSPACE_BRACE_EXPANSIONS,
  dot: false,
});

export interface WorkspacePatternProjection {
  readonly values: readonly string[];
  readonly capped: boolean;
  readonly invalid: boolean;
}

export interface CompiledWorkspacePatterns {
  /** Canonical positive and negative authored patterns admitted by preflight. */
  readonly patterns: readonly string[];
  /** Number of Minimatch objects retained; exposed for boundedness tests. */
  readonly matcherCount: number;
  readonly reasonCodes: readonly string[];
  readonly hasPositivePatterns: boolean;
  /** Whether a directory can still contain a positive workspace match. */
  couldMatchDescendant(relativeDirectory: string): boolean;
  matches(packageRoot: string): boolean;
}

interface InspectedPattern {
  readonly body: string;
  readonly expandedAlternatives: readonly string[];
  readonly negative: boolean;
  readonly normalized: string;
}

interface NormalizedPattern {
  readonly body: string;
  readonly negative: boolean;
  readonly normalized: string;
}

function normalizedPatternBody(value: unknown): NormalizedPattern | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_WORKSPACE_PATTERN_BYTES ||
    CONTROL_CHARACTER.test(value) ||
    value.includes('\\')
  ) {
    return undefined;
  }
  const negative = value.startsWith('!');
  let body = negative ? value.slice(1) : value;
  if (body.startsWith('!')) return undefined;
  while (body.startsWith('./')) body = body.slice(2);
  body = body.replace(/\/+$/u, '');
  if (
    body.length === 0 ||
    body.startsWith('/') ||
    /^[A-Za-z]:/u.test(body) ||
    body.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return undefined;
  }
  return {
    body,
    negative,
    normalized: negative ? `!${body}` : body,
  };
}

function safeExpandedAlternative(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes('\\') &&
    !CONTROL_CHARACTER.test(value) &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function inspectNormalizedWorkspacePattern(
  normalized: NormalizedPattern,
): InspectedPattern | undefined {
  const expandedAlternatives = braceExpand(normalized.body, {
    braceExpandMax: MAX_WORKSPACE_BRACE_EXPANSIONS + 1,
  });
  if (
    expandedAlternatives.length > MAX_WORKSPACE_BRACE_EXPANSIONS ||
    expandedAlternatives.some((alternative) => !safeExpandedAlternative(alternative))
  ) {
    return undefined;
  }
  return {
    ...normalized,
    expandedAlternatives,
  };
}

function inspectWorkspacePattern(value: unknown): InspectedPattern | undefined {
  const normalized = normalizedPatternBody(value);
  return normalized === undefined ? undefined : inspectNormalizedWorkspacePattern(normalized);
}

/**
 * Canonicalize one package.json/pnpm workspace array through the same boundary.
 * Unsafe paths and expansion bombs never cross into discovery or snapshots.
 */
export function projectWorkspacePatterns(
  values: readonly unknown[],
  maximum = MAX_WORKSPACE_PATTERNS,
): WorkspacePatternProjection {
  const unique = new Set<string>();
  const inspectedCanonicalPatterns = new Set<string>();
  const rawAuthoredLength = values.length;
  const validAuthoredLength =
    typeof rawAuthoredLength === 'number' &&
    Number.isSafeInteger(rawAuthoredLength) &&
    rawAuthoredLength >= 0;
  const authoredLength = validAuthoredLength ? rawAuthoredLength : 0;
  const authoredCount = Math.min(authoredLength, MAX_WORKSPACE_AUTHORED_PATTERNS);
  const retainedMaximum = Number.isFinite(maximum)
    ? Math.max(0, Math.min(Math.floor(maximum), MAX_WORKSPACE_PATTERNS))
    : MAX_WORKSPACE_PATTERNS;
  let capped = authoredLength > MAX_WORKSPACE_AUTHORED_PATTERNS;
  let invalid = !validAuthoredLength;
  for (let index = 0; index < authoredCount; index += 1) {
    const normalized = normalizedPatternBody(values[index]);
    if (normalized === undefined) {
      invalid = true;
      continue;
    }
    // Deduplicate the cheap canonical form before brace expansion. This keeps a
    // repeated brace-heavy declaration from multiplying inspection work.
    if (inspectedCanonicalPatterns.has(normalized.normalized)) continue;
    inspectedCanonicalPatterns.add(normalized.normalized);
    const inspected = inspectNormalizedWorkspacePattern(normalized);
    if (inspected === undefined) {
      invalid = true;
      continue;
    }
    if (unique.size >= retainedMaximum) {
      capped = true;
      continue;
    }
    unique.add(inspected.normalized);
  }
  return deepFreeze({ values: [...unique].sort(byCodePoint), capped, invalid });
}

function compileMatcher(pattern: InspectedPattern): Minimatch {
  return new Minimatch(pattern.body, WORKSPACE_MATCH_OPTIONS);
}

/**
 * Preflight aggregate expansion state, then compile each admitted matcher once.
 * Patterns are expected in canonical order; invalid entries are omitted safely.
 */
export function compileWorkspacePatterns(patterns: readonly string[]): CompiledWorkspacePatterns {
  const inspectedPatterns: InspectedPattern[] = [];
  const reasons = new Set<string>();
  let expandedAlternatives = 0;
  let expandedBytes = 0;
  if (!Array.isArray(patterns)) {
    reasons.add('workspace-pattern-invalid');
  }
  const rawAuthoredLength: unknown = Array.isArray(patterns) ? patterns.length : 0;
  const validAuthoredLength =
    typeof rawAuthoredLength === 'number' &&
    Number.isSafeInteger(rawAuthoredLength) &&
    rawAuthoredLength >= 0;
  const authoredLength = validAuthoredLength ? rawAuthoredLength : 0;
  if (!validAuthoredLength) reasons.add('workspace-pattern-invalid');
  if (authoredLength > MAX_WORKSPACE_PATTERNS) {
    reasons.add('manifest-workspace-cap-reached');
  }
  const patternInputs = Array.from(
    { length: Math.min(authoredLength, MAX_WORKSPACE_PATTERNS) },
    (_, index): unknown => patterns[index],
  );
  for (const value of patternInputs) {
    const inspected = inspectWorkspacePattern(value);
    if (inspected === undefined) {
      reasons.add('workspace-pattern-invalid');
      continue;
    }
    const nextAlternatives = expandedAlternatives + inspected.expandedAlternatives.length;
    const nextBytes =
      expandedBytes +
      inspected.expandedAlternatives.reduce(
        (total, alternative) => total + Buffer.byteLength(alternative, 'utf8'),
        0,
      );
    if (
      nextAlternatives > MAX_WORKSPACE_TOTAL_EXPANDED_ALTERNATIVES ||
      nextBytes > MAX_WORKSPACE_TOTAL_EXPANDED_BYTES
    ) {
      reasons.add('manifest-workspace-cap-reached');
      break;
    }
    expandedAlternatives = nextAlternatives;
    expandedBytes = nextBytes;
    inspectedPatterns.push(inspected);
  }
  const positives: Minimatch[] = [];
  const negatives: Minimatch[] = [];
  for (const inspected of inspectedPatterns) {
    (inspected.negative ? negatives : positives).push(compileMatcher(inspected));
  }
  const matches = (packageRoot: string): boolean =>
    positives.some((matcher) => matcher.match(packageRoot)) &&
    !negatives.some((matcher) => matcher.match(packageRoot));
  const couldMatchDescendant = (relativeDirectory: string): boolean =>
    relativeDirectory.length === 0 ||
    positives.some((matcher) => matcher.match(relativeDirectory, true));
  return deepFreeze({
    patterns: inspectedPatterns.map((pattern) => pattern.normalized),
    matcherCount: positives.length + negatives.length,
    reasonCodes: [...reasons].sort(byCodePoint),
    hasPositivePatterns: positives.length > 0,
    couldMatchDescendant,
    matches,
  });
}
