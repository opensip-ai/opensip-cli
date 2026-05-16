/**
 * graph:duplicated-function-body — group catalog entries whose body
 * normalizes to the same hash and report groups of size > 1.
 *
 * A "duplicate" is two or more functions whose normalized body is
 * byte-identical (whitespace/comment normalization handled by
 * hashFunctionBody). The default minimum body length is 5 lines so
 * trivial helpers (one-liner getters, etc.) don't dominate the report.
 */

import { createSignal } from '@opensip-tools/core';

import type { Catalog, FunctionOccurrence, GraphConfig, Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

const DEFAULT_MIN_LINES = 5;

export const duplicatedFunctionBodyRule: Rule = {
  slug: 'graph:duplicated-function-body',
  defaultSeverity: 'warning',
  evaluate(catalog, _indexes, config: GraphConfig): readonly Signal[] {
    const minLines = config.minDuplicateBodyLines ?? DEFAULT_MIN_LINES;
    const groups = groupByHash(catalog, minLines);
    const signals: Signal[] = [];
    for (const group of groups) {
      if (group.length < 2) continue;
      const primary = group[0];
      if (!primary) continue;
      for (let i = 1; i < group.length; i++) {
        const occ = group[i];
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

function groupByHash(catalog: Catalog, minLines: number): readonly (readonly FunctionOccurrence[])[] {
  // Walk the catalog directly; the byBodyHash index dedupes by hash,
  // which is exactly what we need to NOT do here.
  const buckets = new Map<string, FunctionOccurrence[]>();
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
    if (!occs) continue;
    for (const occ of occs) {
      if (!isInterestingForDup(occ, minLines)) continue;
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
 */
function isInterestingForDup(occ: FunctionOccurrence, minLines: number): boolean {
  if (occ.kind === 'arrow' || occ.kind === 'function-expression' || occ.kind === 'module-init') {
    return false;
  }
  if (occ.inTestFile) return false;
  const span = occ.endLine - occ.line + 1;
  return span >= minLines;
}
