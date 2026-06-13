/**
 * @fileoverview Determinism-critical code must NOT order with
 * `String.prototype.localeCompare` — use a code-point comparator.
 *
 * WHY (the drift this freezes out):
 *   `localeCompare` is collation-based, and its result is **locale- and
 *   ICU-version-sensitive** — it is NOT guaranteed to equal lexicographic
 *   code-point order. Several opensip-cli artifacts MUST be byte-identical
 *   across machines/CI runners for their contract to hold:
 *     - the graph catalog JSON export (`render/catalog-json.ts`) is a
 *       golden-fixture / idempotent-re-ingestion artifact — its `symbols`/
 *       `edges` ordering must be byte-stable;
 *     - the TS adapter cache key (`graph-*/src/cache-key.ts`) and the merged
 *       sharded catalog (`cli/orchestrate/*`, `pipeline/*`) feed cache reuse
 *       and equivalence checks that assume deterministic ordering;
 *     - the datastore baseline rows (`packages/datastore/src/*`) back the
 *       git-trackable net-new ratchet.
 *   A run on a machine with a different `LANG`/ICU collation table would
 *   reorder these arrays and break the byte-equivalence guarantee silently.
 *
 * DETECTION — regex on `strip-strings-and-comments`-filtered content (NOT AST):
 *   a `.localeCompare(` call expression anywhere in a determinism-critical
 *   source file. Comments and string literals are blanked first, so prose
 *   that merely mentions `localeCompare` (including this header) never fires.
 *
 * SCOPE — only the determinism-critical layers below (graph build/render/cache
 * + datastore persistence). Display/UI code (`cli/ui/`, report renderers) is
 * intentionally out of scope: a human-facing sort legitimately wants locale
 * collation. Adopter repos are unaffected (the path guard makes the check inert
 * outside this workspace's package layout). Test files are skipped.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Determinism-critical source layers. A `localeCompare` here orders an artifact
 * that must be byte-stable across machines (cache key, golden export, baseline,
 * merged catalog) — NOT a human-facing display sort.
 */
const DETERMINISM_CRITICAL: readonly RegExp[] = [
  /packages\/graph\/engine\/src\/(?:render|persistence|cache|pipeline)\//,
  /packages\/graph\/engine\/src\/cli\/orchestrate\//,
  /packages\/graph\/graph-[a-z]+\/src\//, // language adapters incl. cache-key.ts
  /packages\/datastore\/src\//,
];

/** Test-file fragments — skipped (fixtures legitimately exercise ordering). */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** A `.localeCompare(` call — the locale-sensitive (non-deterministic) comparator. */
const LOCALE_COMPARE_RE = /\.localeCompare\s*\(/g;

/**
 * Pure analysis over one determinism-critical source file. Returns a finding for
 * each `.localeCompare(` call. Exported for unit tests.
 */
export function analyzeDeterministicSortNoLocaleCompare(
  content: string,
  filePath: string,
): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (TEST_PATH.test(normalized)) return [];
  if (!DETERMINISM_CRITICAL.some((re) => re.test(normalized))) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    LOCALE_COMPARE_RE.lastIndex = 0;
    if (!LOCALE_COMPARE_RE.test(line)) continue;
    violations.push({
      line: i + 1,
      message:
        'localeCompare orders a determinism-critical artifact (cache key, catalog ' +
        'export, baseline, or merged graph). Its collation is locale-/ICU-dependent ' +
        'and is NOT guaranteed to equal code-point order, so the byte-equivalence ' +
        'guarantee (golden fixtures, idempotent re-ingestion, cache reuse) breaks on a ' +
        'runner with a different locale.',
      severity: 'error',
      suggestion:
        'Use a code-point comparator instead: `(a, b) => (a < b ? -1 : a > b ? 1 : 0)`. ' +
        'If a locale-aware order is genuinely required here, pin the locale ' +
        "(`localeCompare(b, 'en', { sensitivity: 'variant' })`) and document why " +
        'byte-stability does not apply, or exempt the file with ' +
        '`@fitness-ignore-file deterministic-sort-no-localecompare` and a reason.',
      type: 'deterministic-sort-no-localecompare',
    });
  }
  return violations;
}

export const deterministicSortNoLocaleCompare = defineCheck({
  id: '8702bbee-a15a-4930-9dfd-8a622b96c47b',
  slug: 'deterministic-sort-no-localecompare',
  description:
    'Determinism-critical code (graph cache key / catalog export / merge, datastore baseline) must not order with localeCompare — use a code-point comparator for byte-stable output',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  // strip-strings-and-comments: only a real `.localeCompare(` call survives;
  // prose/string mentions (including this file's header) do not false-fire.
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => analyzeDeterministicSortNoLocaleCompare(content, filePath),
});
