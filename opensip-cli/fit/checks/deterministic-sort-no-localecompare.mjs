/**
 * @fileoverview deterministic-sort-no-localecompare — determinism-critical
 *               opensip-cli artifacts must order with a code-point comparator,
 *               never `localeCompare`. Project-local SELF-check.
 *
 * Lives here (not in the shipped `@opensip-cli/checks-*` packs) because it
 * encodes opensip-cli' OWN package layout: the determinism-critical layers are
 * named by first-party path (`packages/graph/engine/src/{render,cache,pipeline,
 * cli/orchestrate}`, the `graph-<lang>` adapters, `packages/datastore/src`). A
 * consumer repo has none of those, so the rule is opensip-internal, not
 * universal.
 *
 * WHY: `localeCompare` is collation-based and locale/ICU-dependent — NOT
 * guaranteed to equal code-point order. The graph catalog JSON export is a
 * golden-fixture / idempotent-re-ingestion artifact; the TS adapter cache key
 * and the merged sharded catalog feed cache reuse + equivalence checks; the
 * datastore baseline rows back the git-trackable ratchet. All must be
 * byte-identical across machines, so a locale-sensitive sort silently breaks
 * the contract on a runner with a different LANG/ICU table.
 *
 * `strip-strings-and-comments` keeps a `.localeCompare(` mentioned in a comment
 * or string from false-firing; only a real call survives.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Determinism-critical first-party layers (byte-stable artifacts). */
const DETERMINISM_CRITICAL = [
  /packages\/graph\/engine\/src\/(?:render|persistence|cache|pipeline)\//,
  /packages\/graph\/engine\/src\/cli\/orchestrate\//,
  /packages\/graph\/graph-[a-z]+\/src\//, // language adapters incl. cache-key.ts
  /packages\/datastore\/src\//,
];

/** Test-file fragments — skipped (fixtures legitimately exercise ordering). */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** A `.localeCompare(` call — the locale-sensitive (non-deterministic) comparator. */
const LOCALE_COMPARE_RE = /\.localeCompare\s*\(/g;

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeDeterministicSortNoLocaleCompare(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (TEST_PATH.test(normalized)) return [];
  if (!DETERMINISM_CRITICAL.some((re) => re.test(normalized))) return [];

  const violations = [];
  for (const [i, line] of content.split('\n').entries()) {
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
        "(`localeCompare(b, 'en', { sensitivity: 'variant' })`) and document why, or " +
        'exempt with `@fitness-ignore-file deterministic-sort-no-localecompare` and a reason.',
      type: 'deterministic-sort-no-localecompare',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '8702bbee-a15a-4930-9dfd-8a622b96c47b',
    slug: 'deterministic-sort-no-localecompare',
    description:
      'Determinism-critical opensip-cli code (graph cache key / catalog export / merge, datastore baseline) must not order with localeCompare — use a code-point comparator for byte-stable output',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    contentFilter: 'strip-strings-and-comments',
    analyze: (content, filePath) => analyzeDeterministicSortNoLocaleCompare(content, filePath),
  }),
];
