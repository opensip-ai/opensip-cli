/**
 * One pure source-filter predicate for every public graph audit read view.
 */

import type { FunctionOccurrence } from '../types.js';

import type { GraphSourceFilter } from './query-contracts.js';

/**
 * Whether a catalog occurrence matches the shared graph source filter.
 * Exact path is byte-for-byte; prefix is segment-aware (complete path segment).
 */
export function matchesGraphSourceFilter(
  row: Pick<
    FunctionOccurrence,
    | 'filePath'
    | 'package'
    | 'kind'
    | 'visibility'
    | 'inTestFile'
    | 'definedInGenerated'
  >,
  filter: GraphSourceFilter,
): boolean {
  if (!matchesSourceScope(row.inTestFile, filter.sourceScope)) return false;
  if (!matchesGenerated(row.definedInGenerated, filter.generated)) return false;

  if (filter.packages !== undefined && filter.packages.length > 0) {
    const packageName = row.package ?? packageFallback(row.filePath);
    if (!filter.packages.includes(packageName)) return false;
  }

  if (filter.kinds !== undefined && filter.kinds.length > 0) {
    if (!filter.kinds.includes(row.kind)) return false;
  }

  if (filter.visibilities !== undefined && filter.visibilities.length > 0) {
    if (!filter.visibilities.includes(row.visibility)) return false;
  }

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

function packageFallback(filePath: string): string {
  const first = filePath.split('/').find((segment) => segment.length > 0);
  return first ?? '(unknown)';
}
