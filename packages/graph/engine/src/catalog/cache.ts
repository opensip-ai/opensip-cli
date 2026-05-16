/**
 * Catalog cache I/O.
 *
 * Persists / loads the catalog file. Whole-cache invalidation is decided
 * by the caller (builder) based on tsCompilerVersion + tsConfigPath +
 * version comparison. Per-file invalidation is also the builder's job
 * (it rehashes each file and reuses or replaces nodes accordingly).
 *
 * Writes are atomic: temp file in the same directory, then rename.
 * POSIX rename on the same filesystem is atomic, so a concurrent reader
 * gets either the old or the new file, never a torn write.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { CATALOG_LANGUAGE, CATALOG_TOOL, CATALOG_VERSION, type Catalog, type CatalogIndex, type CatalogV1 } from './types.js';

/**
 * Read a catalog from disk. Returns null if the file is missing,
 * unreadable, or fails any of these sanity checks:
 *   - top-level JSON parse fails
 *   - `version`, `tool`, or `language` doesn't match what this code knows
 *
 * Sanity-check failures are silent — the caller's recovery action is the
 * same in every case (full rebuild) and a debug-level log line is written
 * for traceability.
 */
export function readCatalog(catalogPath: string): Catalog | null {
  if (!existsSync(catalogPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Partial<CatalogV1>;
  if (v.version !== CATALOG_VERSION) return null;
  if (v.tool !== CATALOG_TOOL) return null;
  if (v.language !== CATALOG_LANGUAGE) return null;
  if (typeof v.tsConfigPath !== 'string') return null;
  if (typeof v.tsCompilerVersion !== 'string') return null;
  if (!Array.isArray(v.files) || !Array.isArray(v.functions)) return null;
  if (typeof v.indexes !== 'object' || v.indexes === null) return null;

  return rehydrate(v as CatalogV1);
}

/** Convert a serialized CatalogV1 back into the in-memory Catalog (Map indexes). */
function rehydrate(v: CatalogV1): Catalog {
  const byContentHash = new Map<string, readonly string[]>();
  for (const [k, ids] of Object.entries(v.indexes.byContentHash)) byContentHash.set(k, ids);
  const callers = new Map<string, readonly string[]>();
  for (const [k, ids] of Object.entries(v.indexes.callers)) callers.set(k, ids);
  return {
    version: v.version,
    tool: v.tool,
    language: v.language,
    builtAt: v.builtAt,
    tsConfigPath: v.tsConfigPath,
    tsCompilerVersion: v.tsCompilerVersion,
    files: v.files,
    functions: v.functions,
    indexes: { byContentHash, callers },
  };
}

/** Convert an in-memory Catalog back to the on-disk CatalogV1. */
function dehydrate(c: Catalog): CatalogV1 {
  const byContentHash: Record<string, readonly string[]> = {};
  for (const [k, ids] of c.indexes.byContentHash) byContentHash[k] = ids;
  const callers: Record<string, readonly string[]> = {};
  for (const [k, ids] of c.indexes.callers) callers[k] = ids;
  return {
    version: c.version,
    tool: c.tool,
    language: c.language,
    builtAt: c.builtAt,
    tsConfigPath: c.tsConfigPath,
    tsCompilerVersion: c.tsCompilerVersion,
    files: c.files,
    functions: c.functions,
    indexes: { byContentHash, callers },
  };
}

/**
 * Write a catalog to disk atomically.
 *
 * Steps:
 *   1. Create the parent directory if missing (mkdir -p).
 *   2. Write to a sibling temp file.
 *   3. Rename the temp file over the target.
 *
 * The temp filename is unique per call (timestamp + random suffix) so two
 * concurrent runs that race on the rename don't clobber each other's
 * temp files between write and rename.
 */
export function writeCatalog(catalog: Catalog, catalogPath: string): void {
  const dir = dirname(catalogPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${catalogPath}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const data = JSON.stringify(dehydrate(catalog), null, 2);
  try {
    writeFileSync(tmpPath, data, 'utf8');
    renameSync(tmpPath, catalogPath);
  } catch (error) {
    // Clean up the temp file if the rename failed; otherwise rename
    // already moved it and the cleanup is a no-op.
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Decide whether a cache should be discarded wholesale before incremental
 * file-level reuse is even considered. Returns null if the cache is usable,
 * or a string explaining why it isn't.
 */
export function whyCacheInvalid(
  cache: Catalog | null,
  current: { tsCompilerVersion: string; tsConfigPath: string },
): string | null {
  if (!cache) return 'cache-missing';
  if (cache.tsCompilerVersion !== current.tsCompilerVersion) return 'ts-compiler-version-changed';
  if (cache.tsConfigPath !== current.tsConfigPath) return 'tsconfig-path-changed';
  if (cache.version !== CATALOG_VERSION) return 'schema-version-changed';
  return null;
}

/** Build an empty CatalogIndex — used when the catalog has no functions yet. */
export function emptyIndex(): CatalogIndex {
  return {
    byContentHash: new Map(),
    callers: new Map(),
  };
}
