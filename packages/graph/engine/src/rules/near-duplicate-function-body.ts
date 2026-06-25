/**
 * graph:near-duplicate-function-body — LSH-banded MinHash near-clone detection.
 *
 * Complements `graph:duplicated-function-body` (exact hash). The detection algorithm now
 * lives in `@opensip-cli/clone-detection` (ADR-0064); this rule is a thin adapter that
 * maps the catalog to `CloneCandidate[]` (stamping `language` from `languageOfFile` for
 * the same-language gate, which stays in graph), calls `findNearDuplicates`, and wraps
 * each cluster into a graph `Signal` with the unchanged message/severity/metadata.
 */

import { findNearDuplicates } from '@opensip-cli/clone-detection';

import { languageOfFile } from '../lang-adapter/language-of-file.js';

import { createGraphSignal } from './create-graph-signal.js';
import { defineRule } from './define-rule.js';

import type { Catalog, FunctionOccurrence } from '../types.js';
import type { CloneCandidate } from '@opensip-cli/clone-detection';
import type { Signal } from '@opensip-cli/core';

const SLUG = 'graph:near-duplicate-function-body';

export const nearDuplicateFunctionBodyRule = defineRule({
  slug: SLUG,
  defaultSeverity: 'warning',
  evaluate({ catalog, config }): readonly Signal[] {
    const candidates = toCandidates(catalog);
    const clusters = findNearDuplicates(candidates, {
      minSimilarity: config.minNearDuplicateSimilarity,
      minBodySize: config.minNearDuplicateBodySize,
      lshBands: config.nearDuplicateLshBands,
    });

    return clusters.map((c) =>
      createGraphSignal(SLUG, config, {
        severity: 'low',
        category: 'quality',
        message: `${String(c.nearMembers.length)} near-duplicate function bodies cluster around ${c.anchor.qualifiedName} (estimated Jaccard ≥ ${c.estimatedSimilarity.toFixed(2)}).`,
        code: { file: c.anchor.filePath, line: c.anchor.line, column: c.anchor.column },
        suggestion:
          'Extract the shared logic into one function and replace the near-clone copies with calls to it.',
        metadata: {
          nearMembers: c.nearMembers,
          exactMembers: c.exactMembers,
          estimatedSimilarity: c.estimatedSimilarity,
          clusterSize: c.clusterSize,
        },
      }),
    );
  },
});

/**
 * Map the catalog to `CloneCandidate[]` in catalog iteration order (so the substrate's
 * `collectEligible` index identity — which the union-find clustering depends on — matches
 * the prior in-rule behavior). `language` is the caller-resolved same-language gate
 * (`languageOfFile`, which stays in graph by the rule of three).
 */
function toCandidates(catalog: Catalog): CloneCandidate[] {
  const candidates: CloneCandidate[] = [];
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (!occs) continue;
    for (const occ of occs) candidates.push(toCandidate(occ));
  }
  return candidates;
}

function toCandidate(occ: FunctionOccurrence): CloneCandidate {
  const language = languageOfFile(occ.filePath);
  return {
    bodyHash: occ.bodyHash,
    kind: occ.kind,
    inTestFile: occ.inTestFile,
    filePath: occ.filePath,
    line: occ.line,
    column: occ.column,
    endLine: occ.endLine,
    simpleName: occ.simpleName,
    qualifiedName: occ.qualifiedName,
    ...(occ.bodySignature === undefined ? {} : { bodySignature: occ.bodySignature }),
    ...(occ.bodySize === undefined ? {} : { bodySize: occ.bodySize }),
    ...(language === undefined ? {} : { language }),
  };
}
