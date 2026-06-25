/**
 * duplicate-body-candidate — flags function bodies that are byte-identical (after comment
 * strip + whitespace normalization) across two or more sites, so they can be consolidated.
 *
 * yagni owns NO detection math (ADR-0064): it builds its own TypeScript inventory
 * (`buildTsInventory`, no `@opensip-cli/graph` dependency) and calls the shared
 * `findDuplicateBodies` from `@opensip-cli/clone-detection` — the SAME implementation +
 * curation policy graph's `graph:duplicated-function-body` rule uses, so the two tools
 * cannot diverge (the cross-tool parity test is the standing guard). yagni adds only the
 * reduction framing + confidence/metadata.
 */

import { findDuplicateBodies } from '@opensip-cli/clone-detection';
import { currentScope, withSpan } from '@opensip-cli/core';

import { buildTsInventory } from '../lib/build-ts-inventory.js';
import { severityForConfidence } from '../scoring/confidence.js';

import { createYagniSignal } from './create-yagni-signal.js';

import type { YagniDetector, YagniDetectorContext, YagniDetectorResult } from './types.js';
import type {
  CloneCandidate,
  CrossPackageAggregate,
  DuplicateGroup,
} from '@opensip-cli/clone-detection';
import type { Signal } from '@opensip-cli/core';

const DETECTOR_ID = 'duplicate-body-candidate';
const SLUG = 'yagni:duplicate-body-candidate';
const CONFIDENCE = 'medium' as const;

function span(occ: CloneCandidate): number {
  return occ.bodyLines ?? occ.endLine - occ.line + 1;
}

/**
 * Build a reduction signal for a duplicate group.
 *
 * @throws {Error} If the clone-detection substrate returns a structurally invalid
 *   empty group.
 */
function groupSignal(group: DuplicateGroup): Signal {
  const primary = group.members[0];
  /* v8 ignore next */
  if (!primary) throw new Error('duplicate group with no members');
  const count = group.members.length;
  const netEstimate = span(primary) * (count - 1);
  const peers = group.members
    .slice(1)
    .map((m) => `${m.filePath}:${String(m.line)}`)
    .join(', ');
  return createYagniSignal({
    source: SLUG,
    ruleId: SLUG,
    severity: severityForConfidence(CONFIDENCE),
    category: 'quality',
    message: `${primary.simpleName} has a body duplicated across ${String(count)} sites — consolidate.`,
    suggestion: `Extract the shared body into one function and have all ${String(count)} sites call it.`,
    code: { file: primary.filePath, line: primary.line, column: primary.column },
    yagni: {
      detector: DETECTOR_ID,
      reductionCategory: 'dedupe',
      confidence: CONFIDENCE,
      locDelta: { remove: netEstimate, add: 0, netEstimate, estimateKind: 'lower-bound' },
      preservationArgument: `The body is byte-identical (normalized) across ${String(count)} sites, so consolidating to one function preserves behavior.`,
      suggestedAction: `Consolidate ${String(count)} identical copies of ${primary.simpleName} (peers: ${peers}).`,
      validationRequired: [
        'Confirm the copies are behaviorally identical, not just textually (closures, captured scope).',
        'Run the affected packages’ test suites after consolidation.',
      ],
      riskTags: [],
      evidence: [
        {
          id: `dup-body:${primary.bodyHash}`,
          kind: 'duplicate-body',
          summary: `${String(count)} sites share body hash ${primary.bodyHash.slice(0, 12)}.`,
          data: {
            bodyHash: primary.bodyHash,
            occurrenceCount: count,
            sites: group.members.map((m) => `${m.filePath}:${String(m.line)}`),
          },
        },
      ],
    },
  });
}

function aggregateSignal(agg: CrossPackageAggregate): Signal {
  const netEstimate = span(agg.anchor) * (agg.occurrenceCount - 1);
  return createYagniSignal({
    source: SLUG,
    ruleId: SLUG,
    severity: severityForConfidence(CONFIDENCE),
    category: 'quality',
    message: `A body is duplicated across ${String(agg.packages.length)} packages (${agg.packages.join(', ')}) in ${String(agg.occurrenceCount)} sites — hoist it into a shared package.`,
    suggestion: 'Hoist the shared body into one shared package and have every copy import it.',
    code: { file: agg.anchor.filePath, line: agg.anchor.line, column: agg.anchor.column },
    yagni: {
      detector: DETECTOR_ID,
      reductionCategory: 'dedupe',
      confidence: CONFIDENCE,
      locDelta: { remove: netEstimate, add: 0, netEstimate, estimateKind: 'lower-bound' },
      preservationArgument: `The same normalized body appears in ${String(agg.occurrenceCount)} sites across ${String(agg.packages.length)} packages; hoisting to a shared package preserves behavior.`,
      suggestedAction: `Hoist the body shared across ${agg.packages.join(', ')} into one shared package.`,
      validationRequired: [
        'Confirm the cross-package copies are behaviorally identical.',
        'Add the new shared package as a dependency of each consumer and run their tests.',
      ],
      riskTags: ['cross-package'],
      evidence: [
        {
          id: `dup-body-xpkg:${agg.bodyHash}`,
          kind: 'cross-package-duplicate-body',
          summary: `${String(agg.occurrenceCount)} sites across ${agg.packages.join(', ')} share body hash ${agg.bodyHash.slice(0, 12)}.`,
          data: {
            bodyHash: agg.bodyHash,
            occurrenceCount: agg.occurrenceCount,
            packages: agg.packages,
          },
        },
      ],
    },
  });
}

function runDuplicateBodyCandidate(ctx: YagniDetectorContext): Promise<YagniDetectorResult> {
  const result = withSpan(
    'opensip-cli-yagni',
    'yagni.duplicate_body_candidate',
    () => {
      const started = Date.now();
      const candidates = buildTsInventory(ctx.cwd, ctx.pathRoots);
      const { aggregates, groups } = findDuplicateBodies(candidates);
      const signals: Signal[] = [
        ...aggregates.map((a) => aggregateSignal(a)),
        ...groups.map((g) => groupSignal(g)),
      ];
      const durationMs = Date.now() - started;
      // O2 — one structured scan-complete event (counts + duration only; never body text).
      currentScope()?.logger?.info({
        evt: 'yagni.duplicate-detector.scan.complete',
        module: 'yagni:duplicate-body-candidate',
        durationMs,
        candidateCount: candidates.length,
        groupCount: aggregates.length + groups.length,
      });
      return { signals, durationMs };
    },
    { 'yagni.detector': DETECTOR_ID },
  );
  return Promise.resolve(result);
}

export const duplicateBodyCandidateDetector: YagniDetector = {
  id: DETECTOR_ID,
  slug: SLUG,
  description: 'Function bodies duplicated across two or more sites (consolidation candidates)',
  run: runDuplicateBodyCandidate,
};
