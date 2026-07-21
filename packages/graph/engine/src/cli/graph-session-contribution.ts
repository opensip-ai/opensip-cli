import { deriveRunOutcome } from '@opensip-cli/core';

import { GRAPH_LAYOUT_KEY } from '../identity.js';
import { buildGraphSessionPayload } from '../persistence/session-payload.js';
import { mapOpenSipRuleIdToEngineSlug } from '../render/rule-id-mapping.js';
import { currentRules } from '../rules/registry.js';

import { buildGraphEnvelope } from './build-envelope.js';

import type { FinalizedSignals } from './apply-suppressions.js';
import type { GraphCommandOptions } from './graph-options.js';
import type { GraphSessionPayload } from '../persistence/session-payload.js';
import type { Rule } from '../types.js';
import type { Signal, ToolSessionContribution } from '@opensip-cli/core';

/** Headline verdict fields copied onto the generic session contribution row. */
export interface SessionVerdict {
  readonly score: number;
  readonly passed: boolean;
}

/**
 * Build the generic-session contribution for a single-process graph run from
 * branded finalized signals and the same envelope verdict the delivery path
 * already computed (ADR-0177). The host run plane stamps timing + id and
 * persists the row after the handler returns; graph never writes the generic
 * session row.
 */
export function buildGraphSessionContribution(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  finalized: FinalizedSignals,
  verdict: SessionVerdict,
): ToolSessionContribution {
  const payload = buildGraphSessionPayload(finalized.signals, evaluatedRuleSlugs());
  return contributionFromGraphPayload(opts, payload, verdict);
}

/**
 * Build the aggregate generic-session contribution for a `--workspace` run.
 * Child envelopes carry Option-A-mapped OpenSIP rule IDs; reverse-map back to
 * engine slugs so dashboard per-rule metric columns keep working. A failed
 * child makes the aggregate incomplete, so its session is explicitly an
 * error with a score of zero regardless of the surviving signals.
 */
export function buildWorkspaceSessionContribution(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  signals: readonly Signal[],
  anyChildFailed: boolean,
): ToolSessionContribution {
  const engineSignals = signals.map((s) => {
    const ruleId = mapOpenSipRuleIdToEngineSlug(s.ruleId);
    return { ...s, ruleId, source: ruleId };
  });
  const contribution = contributionFromSignals(opts, engineSignals);
  if (!anyChildFailed) return contribution;
  // A failed child means the aggregate evidence is incomplete. The signals
  // collected from the remaining children cannot justify a green verdict or
  // their otherwise-derived pass-rate score.
  return {
    ...contribution,
    score: 0,
    passed: false,
    runOutcome: 'error',
  };
}

/**
 * Engine slugs of every rule a run evaluated. Prefer the explicitly-resolved
 * rule set the run actually used; otherwise read the current scope's full
 * registry, matching `runGraph`'s own `args.rules ?? currentRules()` default.
 */
export function evaluatedRuleSlugs(explicitRules?: readonly Rule[]): readonly string[] {
  if (explicitRules) return explicitRules.map((r) => r.slug);
  try {
    return currentRules().map((r) => r.slug);
  } catch {
    // @swallow-ok no active graph rule registry in narrow unit/programmatic paths;
    // session payload still records the observed signals.
    return [];
  }
}

/**
 * Build graph's generic-session contribution from engine-slug signals plus the
 * engine slugs of the rules evaluated. Shared by static dispatch and live Ink
 * so the contribution shape cannot drift.
 *
 * Score/passed come from {@link buildGraphEnvelope} (ADR-0177) — the same pure
 * assembly the live delivery path uses — not from `passRate` over the
 * all-evaluated payload summary (clean-rule inventory stays in payload only).
 */
export function contributionFromSignals(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  signals: readonly Signal[],
  evaluatedSlugs: readonly string[] = evaluatedRuleSlugs(),
): ToolSessionContribution {
  const payload = buildGraphSessionPayload(signals, evaluatedSlugs);
  // Pure assembly; runId/createdAt do not affect verdict.score/passed.
  const envelope = buildGraphEnvelope({
    signals,
    recipe: opts.recipe,
    runId: '',
    createdAt: '',
  });
  return contributionFromGraphPayload(opts, payload, envelope.verdict);
}

/**
 * Finalize a graph-owned payload into the host's generic session contribution.
 * Ordinary graph and impact runs share this score/verdict assembly while
 * retaining explicit payload construction at their two call sites.
 *
 * `verdict` MUST be the envelope's `score`/`passed` (ADR-0177). Payload detail
 * may list every evaluated rule; it must not recompute the headline.
 */
export function contributionFromGraphPayload(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  payload: GraphSessionPayload,
  verdict: SessionVerdict,
): ToolSessionContribution {
  return {
    tool: GRAPH_LAYOUT_KEY,
    cwd: opts.cwd,
    ...(opts.recipe === undefined ? {} : { recipe: opts.recipe }),
    score: verdict.score,
    passed: verdict.passed,
    runOutcome: deriveRunOutcome({ passed: verdict.passed }),
    payload,
  };
}
