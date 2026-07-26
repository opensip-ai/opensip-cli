/**
 * One pure source-filter predicate for every public graph audit read view, plus
 * the audit source-role matcher (P2 Phase 1.4): a compiled, non-serializable
 * predicate that reclassifies configured paths as test sources.
 */

import { err, ok, type Result } from '@opensip-cli/core';
import { Minimatch } from 'minimatch';

import { graphErrorCatalog } from '../errors/graph-error-catalog.js';

import { graphPackageOf } from './query-contracts.js';

import type { AuditSourceRolePolicy, GraphSourceFilter } from './query-contracts.js';
import type { GraphReadError } from './types.js';
import type { FunctionOccurrence } from '../types.js';

// Plan 01: the `GRAPH` head was mapped by nothing, so every one of these resolved to
// UNKNOWN_FAILURE — fatal and operator-only — for conditions MCP consumers branch on.
const QUERY_INVALID = graphErrorCatalog.require('GRAPH.READ.QUERY_INVALID');

/**
 * Max unique normalized project-relative catalog file paths classified against
 * the audit source-role globs for one `g1:` generation (P2 Phase 1.4). Beyond
 * this, {@link compileSourceRoleMatcher} fails the read with a typed
 * resource-limit error rather than silently treating unclassified files as
 * production.
 */
export const MAX_AUDIT_SOURCE_ROLE_FILES = 250_000;

/**
 * Minimatch options for audit source-role globs. `nobrace`/`noext`/`nonegate`
 * mirror the config validator (brace/extglob/negation forms are rejected at
 * config time); `dot` matches dotfiles; `nocomment` treats `#` literally.
 */
const MINIMATCH_OPTIONS = {
  dot: true,
  nobrace: true,
  noext: true,
  nocomment: true,
  nonegate: true,
} as const;

/**
 * Compiled, NON-serializable audit source-role matcher (P2 Phase 1.4). NEVER
 * placed in a DTO — no function, `Minimatch`, or `RegExp` crosses the read
 * boundary. `matches` is an O(1) lookup into a matched-path set pre-computed
 * once at compile time, so the (≤64 globs) × (≤files) classification never runs
 * per query row.
 */
export interface SourceRoleMatcher {
  matches(filePath: string): boolean;
}

/** Immutable classification limits (production passes {@link MAX_AUDIT_SOURCE_ROLE_FILES}). */
export interface SourceRoleLimits {
  readonly maxFiles: number;
}

/** The no-op matcher — no configured globs, so nothing is reclassified. */
const EMPTY_MATCHER: SourceRoleMatcher = { matches: () => false };

/**
 * Compile an {@link AuditSourceRolePolicy} against a generation's unique
 * normalized project-relative file paths into a {@link SourceRoleMatcher}
 * (P2 Phase 1.4). Returns the no-op matcher when no globs are configured.
 *
 * Fails closed with a typed error when a glob cannot be compiled, or when the
 * unique file count exceeds `limits.maxFiles` — never silently degrading
 * unclassified files to production scope.
 */
export function compileSourceRoleMatcher(
  policy: AuditSourceRolePolicy | undefined,
  filePaths: Iterable<string>,
  limits: SourceRoleLimits,
): Result<SourceRoleMatcher, GraphReadError> {
  if (policy === undefined || policy.testGlobs.length === 0) return ok(EMPTY_MATCHER);
  let matchers: Minimatch[];
  try {
    matchers = policy.testGlobs.map((glob) => new Minimatch(glob, MINIMATCH_OPTIONS));
  } catch {
    return err({
      code: QUERY_INVALID.code,
      operation: 'analysis',
      message: 'Failed to compile an audit source-role glob.',
    });
  }
  const matched = new Set<string>();
  const considered = new Set<string>();
  for (const filePath of filePaths) {
    if (considered.has(filePath)) continue;
    considered.add(filePath);
    if (considered.size > limits.maxFiles) {
      return err({
        code: QUERY_INVALID.code,
        operation: 'analysis',
        message: 'Audit source-role classification exceeded the file limit.',
      });
    }
    if (matchers.some((matcher) => matcher.match(filePath))) matched.add(filePath);
  }
  return ok({ matches: (filePath: string) => matched.has(filePath) });
}

/**
 * The single effective test-source definition (P2 Phase 1.4/1.5): the adapter's
 * `inTestFile` bit OR an audit source-role glob match. Every source-scope caller
 * routes through this so a filtered row cannot leak into production summaries.
 */
export function effectiveTestSource(
  row: Pick<FunctionOccurrence, 'filePath' | 'inTestFile'>,
  matcher: SourceRoleMatcher,
): boolean {
  return row.inTestFile || matcher.matches(row.filePath);
}

type FilterableRow = Pick<
  FunctionOccurrence,
  'filePath' | 'package' | 'kind' | 'visibility' | 'inTestFile' | 'definedInGenerated'
>;

/**
 * Whether a catalog occurrence matches the shared graph source filter, applying
 * the compiled audit source-role matcher to the effective test classification
 * (P2 Phase 1.4). This is the canonical role-aware predicate; Tasks 1.5-1.6
 * migrate every read view / MCP-local projection onto it.
 */
export function matchesGraphSourceFilterWithRoles(
  row: FilterableRow,
  filter: GraphSourceFilter,
  matcher: SourceRoleMatcher,
): boolean {
  if (!matchesSourceScope(effectiveTestSource(row, matcher), filter.sourceScope)) return false;
  return matchesNonScopeFilter(row, filter);
}

/** Filter checks independent of the source-scope/test classification. */
function matchesNonScopeFilter(row: FilterableRow, filter: GraphSourceFilter): boolean {
  if (!matchesGenerated(row.definedInGenerated, filter.generated)) return false;

  if (filter.packages !== undefined && filter.packages.length > 0) {
    const packageName = graphPackageOf(row);
    if (!filter.packages.includes(packageName)) return false;
  }

  if (filter.kinds !== undefined && filter.kinds.length > 0 && !filter.kinds.includes(row.kind))
    return false;

  if (
    filter.visibilities !== undefined &&
    filter.visibilities.length > 0 &&
    !filter.visibilities.includes(row.visibility)
  )
    return false;

  if (filter.filePath !== undefined && row.filePath !== filter.filePath) {
    return false;
  }

  if (filter.filePrefix !== undefined && !matchesFilePrefix(row.filePath, filter.filePrefix)) {
    return false;
  }

  return true;
}

function matchesSourceScope(inTestFile: boolean, scope: GraphSourceFilter['sourceScope']): boolean {
  switch (scope) {
    case 'all': {
      return true;
    }
    case 'production': {
      return !inTestFile;
    }
    case 'test': {
      return inTestFile;
    }
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

function matchesGenerated(
  definedInGenerated: boolean,
  policy: GraphSourceFilter['generated'],
): boolean {
  switch (policy) {
    case 'include': {
      return true;
    }
    case 'exclude': {
      return !definedInGenerated;
    }
    case 'only': {
      return definedInGenerated;
    }
    default: {
      const _exhaustive: never = policy;
      return _exhaustive;
    }
  }
}

/**
 * Segment-aware prefix match: `src/api` matches `src/api` and `src/api/x.ts`,
 * but not `src/api-old/x.ts`.
 */
export function matchesFilePrefix(filePath: string, filePrefix: string): boolean {
  if (filePath === filePrefix) return true;
  return filePath.startsWith(`${filePrefix}/`);
}

/**
 * Whether a read uses the canonical production/non-generated evidence scope.
 * Configured audit source-role globs make the read non-canonical (P2 Phase 1.4),
 * so the cached unfiltered `FeatureTable.edge` shortcut is declined.
 */
export function isCanonicalProductionFilter(filter: GraphSourceFilter): boolean {
  return (
    filter.sourceScope === 'production' &&
    filter.generated === 'exclude' &&
    filter.packages === undefined &&
    filter.filePath === undefined &&
    filter.filePrefix === undefined &&
    filter.kinds === undefined &&
    filter.visibilities === undefined &&
    (filter.sourceRoles === undefined || filter.sourceRoles.testGlobs.length === 0)
  );
}
