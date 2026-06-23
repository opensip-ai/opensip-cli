/**
 * duplicate-body-candidate — surfaces cross-occurrence duplicate function bodies
 * from a graph catalog bodyHash grouping as consolidation candidates.
 */

import { relative } from 'node:path';

import { severityForConfidence } from '../scoring/confidence.js';

import { createYagniSignal } from './create-yagni-signal.js';

import type { YagniDetector, YagniDetectorContext, YagniDetectorResult } from './types.js';
import type { GraphFunctionOccurrence } from '@opensip-cli/contracts';

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
  return [...occs].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))[0];
}

function relPath(cwd: string, filePath: string): string {
  return relative(cwd, filePath).split('\\').join('/');
}

function displayFunctionName(occ: GraphFunctionOccurrence): string {
  const simple = occ.simpleName.trim();
  if (simple.startsWith('<arrow:')) return 'arrow function';
  if (simple !== '' && !simple.includes('/') && simple.length <= 60) return simple;

  if (occ.qualifiedName.includes('<arrow:')) return 'arrow function';
  if (occ.qualifiedName.includes('/')) return 'function';
  const qualifiedTail = occ.qualifiedName.split('.').at(-1)?.trim() ?? '';
  if (qualifiedTail !== '' && !qualifiedTail.includes('/') && qualifiedTail.length <= 60) {
    return qualifiedTail;
  }
  return 'function';
}

function displayOccurrence(cwd: string, occ: GraphFunctionOccurrence): string {
  return `${relPath(cwd, occ.filePath)}:${String(occ.line)} (${displayFunctionName(occ)})`;
}

function runDuplicateBodyCandidate(ctx: YagniDetectorContext): Promise<YagniDetectorResult> {
  const started = Date.now();
  const settings = ctx.config.detectorSettings?.[DETECTOR_ID] ?? {};
  const minOccurrences =
    typeof settings.minOccurrences === 'number' ? settings.minOccurrences : DEFAULT_MIN_OCCURRENCES;
  const minBodyLines =
    typeof settings.minBodyLines === 'number' ? settings.minBodyLines : DEFAULT_MIN_BODY_LINES;

  if (ctx.graphCatalog === null) {
    return Promise.resolve({ signals: [], durationMs: Date.now() - started });
  }

  const signals = [];
  for (const [bodyHash, occs] of groupByBodyHash(ctx.graphCatalog)) {
    if (occs.length < minOccurrences) continue;
    const anchor = primaryOccurrence(occs);
    const bodyLines = anchor.endLine - anchor.line + 1;
    if (bodyLines < minBodyLines) continue;
    const packages = [
      ...new Set(occs.map((o) => o.package ?? o.filePath.split('/')[0] ?? 'unknown')),
    ].sort();
    const confidence = 'medium' as const;
    const netEstimate = bodyLines * (occs.length - 1);
    const anchorRel = relPath(ctx.cwd, anchor.filePath);
    const peer = occs.find((o) => o.qualifiedName !== anchor.qualifiedName) ?? anchor;
    const peerDisplay = displayOccurrence(ctx.cwd, peer);
    signals.push(
      createYagniSignal({
        source: SLUG,
        ruleId: SLUG,
        severity: severityForConfidence(confidence),
        category: 'architecture',
        message: `Duplicate body candidate (${String(occs.length)} occurrences) — consolidate shared logic (${confidence} confidence)`,
        suggestion: 'Extract the shared body into one module and import it from each copy site.',
        code: {
          file: anchor.filePath,
          line: anchor.line,
          column: anchor.column,
        },
        yagni: {
          detector: DETECTOR_ID,
          reductionCategory: 'dedupe',
          confidence,
          locDelta: {
            remove: netEstimate,
            add: Math.max(1, Math.floor(bodyLines / 2)),
            netEstimate,
            estimateKind: 'heuristic',
          },
          preservationArgument:
            'Occurrences share an identical bodyHash from the graph catalog; behavior should match after hoisting.',
          suggestedAction: `Consolidate with ${peerDisplay}.`,
          validationRequired: [
            'Confirm neither occurrence is published public API.',
            'Run tests covering each duplicate site after extraction.',
          ],
          riskTags: ['cross-package', 'behavior-preservation'],
          evidence: [
            {
              id: `body-hash:${bodyHash}`,
              kind: 'body-hash-group',
              summary: `${String(occs.length)} functions share bodyHash ${bodyHash.slice(0, 8)}.`,
              data: {
                bodyHash,
                occurrenceCount: occs.length,
                packages,
                anchor: {
                  qualifiedName: anchor.qualifiedName,
                  filePath: anchorRel,
                  line: anchor.line,
                },
                peer: {
                  qualifiedName: peer.qualifiedName,
                  filePath: relPath(ctx.cwd, peer.filePath),
                  line: peer.line,
                },
              },
            },
          ],
        },
      }),
    );
  }

  return Promise.resolve({ signals, durationMs: Date.now() - started });
}

export const duplicateBodyCandidateDetector: YagniDetector = {
  id: DETECTOR_ID,
  slug: SLUG,
  description: 'Duplicate function-body candidates from graph bodyHash groups',
  requiresGraph: true,
  run: runDuplicateBodyCandidate,
};
