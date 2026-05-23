/**
 * graph:duplicated-function-body — group catalog entries whose body
 * normalizes to the same hash and report groups of size > 1.
 *
 * A "duplicate" is two or more functions whose normalized body is
 * byte-identical (whitespace/comment normalization handled by
 * hashFunctionBody). Two thresholds filter out non-actionable hits:
 *
 *   - minDuplicateBodyLines (default 5): the source span must be at
 *     least this many lines.
 *   - minDuplicateBodySize  (default 200): the *normalized* body
 *     (post comment-strip + whitespace-collapse) must be at least
 *     this many characters. This catches the common case of a
 *     `defineCheck({ ... analyze(content) { return analyzeFile(...) } })`
 *     wrapper where the source spans 8+ lines but the executable
 *     body is only ~80 characters once normalized — structurally
 *     identical to every other thin wrapper, but never an actionable
 *     refactor target.
 */

import { createSignal } from '@opensip-tools/core';

import type { Catalog, FunctionOccurrence, GraphConfig, Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

const DEFAULT_MIN_LINES = 5;
const DEFAULT_MIN_BODY_SIZE = 200;

export const duplicatedFunctionBodyRule: Rule = {
  slug: 'graph:duplicated-function-body',
  defaultSeverity: 'warning',
  evaluate(catalog, _indexes, config: GraphConfig): readonly Signal[] {
    const minLines = config.minDuplicateBodyLines ?? DEFAULT_MIN_LINES;
    const minBodySize = config.minDuplicateBodySize ?? DEFAULT_MIN_BODY_SIZE;
    const groups = groupByHash(catalog, minLines, minBodySize);
    const signals: Signal[] = [];
    for (const group of groups) {
      if (group.length < 2) continue;
      const primary = group[0];
      /* v8 ignore next */
      if (!primary) continue;
      for (let i = 1; i < group.length; i++) {
        const occ = group[i];
        /* v8 ignore next */
        if (!occ) continue;
        signals.push(
          createSignal({
            source: 'graph',
            severity: 'low',
            category: 'quality',
            ruleId: 'graph:duplicated-function-body',
            message: `${occ.simpleName} has the same body as ${primary.qualifiedName} (${primary.filePath}:${String(primary.line)}).`,
            code: { file: occ.filePath, line: occ.line, column: occ.column },
            suggestion:
              'Extract the shared body to a single function and have both call sites import it.',
            metadata: {
              primary: primary.qualifiedName,
              duplicate: occ.qualifiedName,
              groupSize: group.length,
            },
          }),
        );
      }
    }
    return signals;
  },
};

function groupByHash(
  catalog: Catalog,
  minLines: number,
  minBodySize: number,
): readonly (readonly FunctionOccurrence[])[] {
  // Walk the catalog directly; the byBodyHash index dedupes by hash,
  // which is exactly what we need to NOT do here.
  const buckets = new Map<string, FunctionOccurrence[]>();
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
    /* v8 ignore next */
    if (!occs) continue;
    for (const occ of occs) {
      if (!isInterestingForDup(occ, minLines, minBodySize)) continue;
      let bucket = buckets.get(occ.bodyHash);
      if (!bucket) {
        bucket = [];
        buckets.set(occ.bodyHash, bucket);
      }
      bucket.push(occ);
    }
  }
  return [...buckets.values()];
}

/**
 * The dup-body rule is targeting "two functions whose body the
 * developer should extract." Inline arrows / function expressions /
 * module-init occurrences fail that test:
 *  - test-suite arrows with identical 5-line bodies are common boilerplate
 *  - module-inits hash whatever is at top level; identical hashes mean
 *    twin files, not a dup-extraction opportunity
 *  - constructor/getter/setter/method dups are interesting; keep those
 *
 * The bodySize threshold drops trivial wrappers — a `defineCheck` or
 * pass-through analyze that contains an `if`-guard plus a delegating
 * call. These have identical normalized bodies across many files but
 * are never the right refactor target. Catalogs from older runs that
 * lack `bodySize` skip the size check (treated as "passes").
 */
function isInterestingForDup(
  occ: FunctionOccurrence,
  minLines: number,
  minBodySize: number,
): boolean {
  if (occ.kind === 'arrow' || occ.kind === 'function-expression' || occ.kind === 'module-init') {
    return false;
  }
  if (occ.inTestFile) return false;
  const span = occ.endLine - occ.line + 1;
  if (span < minLines) return false;
  if (occ.bodySize !== undefined && occ.bodySize < minBodySize) return false;
  return true;
}
