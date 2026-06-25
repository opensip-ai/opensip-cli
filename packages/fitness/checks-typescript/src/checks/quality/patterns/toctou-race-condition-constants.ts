/**
 * Constants and safe-path configuration for the TOCTOU race-condition check.
 */

import { getCheckConfig } from '@opensip-cli/fitness';

/**
 * Recipe-config shape for toctou-race-condition. Project-specific safe-paths
 * belong in a recipe's `checks.config['toctou-race-condition']` block.
 */
export interface TocTouConfig extends Record<string, unknown> {
  /**
   * Additional path patterns where TOCTOU is not a concern. Each entry is
   * compiled to a case-insensitive RegExp via `new RegExp(entry, 'i')`.
   */
  additionalSafeTOCTOUPaths?: readonly string[];
}

/** Patterns that indicate proper atomic update handling */
export const ATOMIC_PATTERNS = [
  /expectedVersion/i,
  /version\s*:/,
  /ConditionExpression/,
  /conditionalUpdate/i,
  /atomicUpdate/i,
  /compareAndSwap/i,
  /optimisticLock/i,
  /CONCURRENCY SAFE/,
  /transaction/i,
  /beginTransaction/i,
  /withTransaction/i,
  /runInTransaction/i,
  /acquireLock/i,
  /withLock/i,
  /mutex/i,
  /idempotent/i,
  /idempotencyKey/i,
  /single-threaded/i,
  /in-memory/i,
  /atomic in.*Node/i,
  /single-threaded coalesce/i,
  /Node single-threaded/i,
  /event-loop semantics/i,
];

/** Paths where TOCTOU is typically not a concern */
export const SAFE_TOCTOU_PATHS = [
  /\/cache\//i,
  /\/caching\//i,
  /memory-backend/i,
  /memory-cache/i,
  /memory-store/i,
  /in-memory/i,
  /-cache\.tsx?$/i,
  /-prefetcher\.tsx?$/i,
  /rate-limit/i,
  /rate_limit/i,
  /local-storage/i,
  /local-state/i,
  /state-manager/i,
  /\/cli\//,
  /\/scripts\//,
  /\/testing\//,
  /test-utils/,
  /\/config\//,
  /\/registry\//,
  /\/di-registration\//,
  /\/factories\//,
  /\/routes\//,
  /\/di\//,
  /\/schema\//,
  /\/detectors\//i,
  /\/dashboard\/src\//i,
  /\/graph\/engine\/src\/pipeline\/features\.ts$/i,
  /parse-cache/i,
  /import-graph/i,
  /check-result-processor/i,
  /phantom-dependency/i,
  /unused-config-options/i,
  /duplicate-utility-functions/i,
  /test-only-frontend-modules/i,
  /interface-implementation-consistency/i,
  /\/discover\.ts$/i,
  /\/filter\.ts$/i,
  /\/loader\.ts$/i,
  /registry\.ts$/i,
];

/** Read operation method names */
const READ_METHOD_NAMES = [
  'get',
  'find',
  'findOne',
  'findFirst',
  'findMany',
  'getById',
  'fetch',
  'load',
  'read',
] as const;

/** Update operation method names */
const UPDATE_METHOD_NAMES = ['update', 'save', 'put', 'set', 'patch', 'modify'] as const;

/** Drizzle-style ORM writes treated as atomic SQL. */
const DRIZZLE_ATOMIC_WRITE_METHOD_NAMES = ['update', 'insert', 'delete'] as const;

export function isReadMethod(methodName: string): boolean {
  return (READ_METHOD_NAMES as readonly string[]).includes(methodName);
}

export function isUpdateMethod(methodName: string): boolean {
  return (UPDATE_METHOD_NAMES as readonly string[]).includes(methodName);
}

export function isDrizzleAtomicWriteMethod(methodName: string): boolean {
  return (DRIZZLE_ATOMIC_WRITE_METHOD_NAMES as readonly string[]).includes(methodName);
}

export const KIND_READ_SHARED = 'read-shared' as const;
export const KIND_UPDATE_SHARED = 'update-shared' as const;
export const KIND_READ_LOCAL = 'read-local' as const;
export const KIND_UPDATE_LOCAL = 'update-local' as const;

/** Compile recipe-provided string entries to case-insensitive RegExp values. */
export function buildEffectiveSafePaths(): readonly RegExp[] {
  const cfg = getCheckConfig<TocTouConfig>('toctou-race-condition');
  const extras = (cfg.additionalSafeTOCTOUPaths ?? []).map((src) => new RegExp(src, 'i'));
  return [...SAFE_TOCTOU_PATHS, ...extras];
}

/** Check if a file path is in a safe TOCTOU context. */
export function isSafeToctouPath(filePath: string, safePaths: readonly RegExp[]): boolean {
  return safePaths.some((pattern) => pattern.test(filePath));
}

/** Check if content has atomic patterns */
export function hasAtomicPatterns(content: string): boolean {
  return ATOMIC_PATTERNS.some((p) => p.test(content));
}
