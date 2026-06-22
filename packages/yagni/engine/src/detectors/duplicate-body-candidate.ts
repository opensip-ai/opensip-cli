/**
 * duplicate-body-candidate — surfaces cross-occurrence duplicate function bodies
 * from a graph catalog bodyHash grouping as consolidation candidates.
 */

import { createYagniSignal } from './create-yagni-signal.js';

import type { GraphFunctionOccurrence } from '@opensip-cli/contracts';
import type { YagniDetector, YagniDetectorContext, YagniDetectorResult } from './types.js';

const DETECTOR_ID = 'duplicate-body-candidate';
const SLUG = 'yagni:duplicate-body-candidate';
const DEFAULT_MIN_OCCURRENCES = 2;
const DEFAULT_MIN_BODY_LINES = 5;

function groupByBodyHash(
  catalog: NonNullable<YagniDetectorContext['graphCatalog']>,
): Map<string, GraphFunctionOccurrence[]> {
  const buckets = new Map<string, GraphFunctionOccurrence[]>();
  for (const occurrences of Object.values(catalog.functions)) {
    for (const occ of occurrences) {
      const bucket = buckets.get(occ.bodyHash);
      if (bucket) bucket.push(occ);
      else buckets.set(occ.bodyHash, [occ]);
    }
  }
  return buckets;
}

function primaryOccurrence(occs: readonly GraphFunctionOccurrence[]): GraphFunctionOccurrence {
  return [...occs].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))[0]!;
}

async function runDuplicateBodyCandidate(ctx: YagniDetectorContext): Promise<YagniDetectorResult> {
  const started = Date.now();
  const settings = ctx.config.detectorSettings?.[DETECTOR_ID] ?? {};
  const minOccurrences =
    typeof settings.minOccurrences === 'number' ? settings.minOccurrences : DEFAULT_MIN_OCCURRENCES;
  const minBodyLines =
    typeof settings.minBodyLines === 'number' ? settings.minBodyLines : DEFAULT_MIN_BODY_LINES;

  if (ctx.graphCatalog === null) {
    return { signals: [], durationMs: Date.now() - started };
  }

  const signals = [];
  for (const [bodyHash, occs] of groupByBodyHash(ctx.graphCatalog)) {
    if (occs.length < minOccurrences) continue;
    const anchor = primaryOccurrence(occs);
    const bodyLines = anchor.endLine - anchor.line + 1;
    if (bodyLines < minBodyLines) continue;
    const packages = [...new Set(occs.map((o) => o.package ?? o.filePath.split('/')[0] ?? 'unknown'))].sort();
    signals.push(
      createYagniSignal({
        source: SLUG,
        ruleId: SLUG,
        severity: 'low',
        category: 'architecture',
        message: `Duplicate body candidate (${String(occs.length)} occurrences, ${String(packages.length)} packages) — consider hoisting shared logic`,
        suggestion: 'Extract the shared body into one module and import it from each copy site.',
        code: { file: anchor.filePath, line: anchor.line, column: anchor.column },
        yagni: {
          detector: DETECTOR_ID,
          confidence: 0.75,
          category: 'duplication',
          evidenceKind: 'body-hash-group',
          evidence: {
            bodyHash,
            occurrenceCount: occs.length,
            packages,
            anchor: {
              qualifiedName: anchor.qualifiedName,
              filePath: anchor.filePath,
              line: anchor.line,
            },
          },
          recommendation: 'Consolidate duplicated implementation behind a single shared helper.',
        },
      }),
    );
  }

  return { signals, durationMs: Date.now() - started };
}

export const duplicateBodyCandidateDetector: YagniDetector = {
  id: DETECTOR_ID,
  slug: SLUG,
  description: 'Duplicate function-body candidates from graph bodyHash groups',
  requiresGraph: true,
  run: runDuplicateBodyCandidate,
};