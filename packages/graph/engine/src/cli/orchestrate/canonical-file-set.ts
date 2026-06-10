/**
 * Canonical graph file set — the SINGLE definition of "which files the graph
 * tool analyzes," shared by BOTH build engines (exact single-program and
 * sharded parallel).
 *
 * Phase 1 of graph-sharded-exact-parity (ADR-0031 lineage). Before this, the
 * two engines discovered DIFFERENT file sets:
 *   - exact   walked the ROOT tsconfig (no include/exclude) → EVERY `.ts(x)`,
 *             fixtures AND tests included;
 *   - sharded enumerated each PACKAGE tsconfig, which excludes that package's
 *             `__fixtures__` tree and (for some packages) its test files.
 * The result was a ~2,500-occurrence catalog gap (measured via
 * `scripts/graph-catalog-diff.mjs`) and two engines that could never agree.
 *
 * The maintainer's Phase-0 ruling (LOCKED): the canonical graph is
 * **production code + real test files, with `__fixtures__/` EXCLUDED**, applied
 * identically to both engines. Real test files are KEPT — they're needed for
 * `test-only-reachable` and for test → production blast/coverage edges.
 * `__fixtures__/` is synthetic test-INPUT code (fitness-check sample sources,
 * graph fixtures) that is noise in a real call graph.
 *
 * This module owns that decision as ONE pure predicate ({@link isFixturePath})
 * and ONE pure filter ({@link resolveCanonicalFileSet}) over file paths. Both
 * engines feed their project-wide root discovery through `resolveCanonicalFileSet`
 * so they see the identical set; the sharded engine then PARTITIONS that set
 * across shards rather than re-deriving each shard's files from a package
 * tsconfig (see `partition-files.ts`).
 */

/** The path segment that marks synthetic test-input code excluded from the canonical set. */
const FIXTURES_SEGMENT = '/__fixtures__/';

/**
 * The canonical fixture predicate: a path is a fixture iff it contains a
 * `/__fixtures__/` segment anywhere in its (forward-slash-normalized) path.
 *
 * Pure and string-only — it makes no filesystem call and is agnostic to whether
 * the input is absolute or project-relative. Normalizes Windows `\` to `/`
 * first so the segment match is OS-independent. This is the ONLY place the
 * fixture convention is encoded; both engines and the parity test reference it.
 */
export function isFixturePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  return normalized.includes(FIXTURES_SEGMENT);
}

/**
 * Reduce a raw discovered file set to the canonical graph set: drop every
 * fixture path, keep everything else (production AND real test files).
 *
 * Pure over the input array — returns a NEW array, preserves input order, and
 * never touches the filesystem. Both engines call this on the SAME project-wide
 * root discovery so their inputs to parse/walk are byte-identical.
 *
 * @param files - raw discovered absolute file paths (e.g. `DiscoverOutput.files`).
 * @returns the subset with `__fixtures__/` paths removed.
 */
export function resolveCanonicalFileSet(files: readonly string[]): readonly string[] {
  return files.filter((f) => !isFixturePath(f));
}
