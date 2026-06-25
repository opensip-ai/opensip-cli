/**
 * graph:duplicated-function-body — group catalog entries whose body normalizes to the
 * same hash and report duplicate bodies. Two complementary paths under one slug:
 *
 *   1. Per-instance (size-gated): N-1 signals per group of ≥2 byte-identical normalized
 *      bodies passing a line floor (default 5) AND a normalized-char floor (default 200,
 *      which drops thin `defineCheck`/pass-through wrappers).
 *   2. Aggregate (cross-package): one signal per body hash in ≥ 3 distinct packages,
 *      suppressing that hash's per-instance signals (lighter body-size-only floor, 80).
 *
 * The detection algorithm + curation policy now live in `@opensip-cli/clone-detection`
 * (ADR-0064) so graph and yagni single-source them. This rule is a thin adapter: it maps
 * the catalog to `CloneCandidate[]` (pre-resolving `bodyLines` from the feature table and
 * `package` from `pkgOf`), calls `findDuplicateBodies`, and wraps each finding into a
 * graph `Signal` with the unchanged message/severity/metadata — so output is byte-stable.
 */

import { findDuplicateBodies } from '@opensip-cli/clone-detection';

import { pkgOf } from '../resolve-callee.js';

import { createGraphSignal } from './create-graph-signal.js';
import { defineRule } from './define-rule.js';

import type { Catalog, FeatureTable, FunctionOccurrence, GraphConfig } from '../types.js';
import type { CloneCandidate } from '@opensip-cli/clone-detection';
import type { Signal } from '@opensip-cli/core';

const SLUG = 'graph:duplicated-function-body';

export const duplicatedFunctionBodyRule = defineRule({
  slug: SLUG,
  defaultSeverity: 'warning',
  featureDeps: ['bodyLines'],
  evaluate({ catalog, config, features }): readonly Signal[] {
    const candidates = toCandidates(catalog, features);
    const { aggregates, groups } = findDuplicateBodies(candidates, {
      minLines: config.minDuplicateBodyLines,
      minBodySize: config.minDuplicateBodySize,
      minCrossPackagePackages: config.minCrossPackageDuplicatePackages,
      minCrossPackageBodySize: config.minCrossPackageDuplicateBodySize,
    });

    // Aggregate (cross-package) signals first, then per-instance signals — same order
    // as the prior loops, but built as bounded in-memory projections over rule findings.
    return [
      ...aggregates.map((agg) => aggregateSignal(agg, config)),
      ...groups.flatMap((group) => groupSignals(group, config)),
    ];
  },
});

function aggregateSignal(
  agg: ReturnType<typeof findDuplicateBodies>['aggregates'][number],
  config: GraphConfig,
): Signal {
  return createGraphSignal(SLUG, config, {
    severity: 'low',
    category: 'quality',
    message: `This body is duplicated across ${String(agg.packages.length)} packages (${agg.packages.join(', ')}) in ${String(agg.occurrenceCount)} occurrences — hoist it into a shared package.`,
    code: { file: agg.anchor.filePath, line: agg.anchor.line, column: agg.anchor.column },
    suggestion: 'Hoist the shared body into a single shared package and have every copy import it.',
    metadata: {
      packages: agg.packages,
      packageCount: agg.packages.length,
      occurrenceCount: agg.occurrenceCount,
      bodyHash: agg.bodyHash,
    },
  });
}

function groupSignals(
  group: ReturnType<typeof findDuplicateBodies>['groups'][number],
  config: GraphConfig,
): readonly Signal[] {
  const primary = group.members[0];
  /* v8 ignore next */
  if (!primary) return [];
  return group.members.slice(1).map((occ) =>
    createGraphSignal(SLUG, config, {
      severity: 'low',
      category: 'quality',
      message: `${occ.simpleName} has the same body as ${primary.qualifiedName} (${primary.filePath}:${String(primary.line)}).`,
      code: { file: occ.filePath, line: occ.line, column: occ.column },
      suggestion:
        'Extract the shared body to a single function and have both call sites import it.',
      metadata: {
        primary: primary.qualifiedName,
        duplicate: occ.qualifiedName,
        groupSize: group.members.length,
      },
    }),
  );
}

/**
 * Map the catalog to `CloneCandidate[]` in the SAME iteration order the prior in-rule
 * grouping used (`Object.keys(catalog.functions)` → each name's occurrences), so the
 * substrate's bucket/primary selection and emission order are byte-identical.
 * `bodyLines` is pre-resolved from the feature table (canonical span) with the inline
 * `endLine − line + 1` fallback handled by the substrate; `package` is `pkgOf` (the
 * nearest-package.json resolution the aggregate path keys on).
 */
function toCandidates(catalog: Catalog, features: FeatureTable | undefined): CloneCandidate[] {
  const candidates: CloneCandidate[] = [];
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    /* v8 ignore next */
    if (!occs) continue;
    for (const occ of occs) candidates.push(toCandidate(occ, features));
  }
  return candidates;
}

function toCandidate(occ: FunctionOccurrence, features: FeatureTable | undefined): CloneCandidate {
  const bodyLines = features?.function.get(occ.bodyHash)?.bodyLines;
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
    package: pkgOf(occ),
    ...(occ.bodySize === undefined ? {} : { bodySize: occ.bodySize }),
    ...(bodyLines === undefined ? {} : { bodyLines }),
  };
}
