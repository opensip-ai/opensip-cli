import { passRate } from '@opensip-cli/contracts';

import { buildGraphSessionPayload } from '../persistence/session-payload.js';
import { mapOpenSipRuleIdToEngineSlug } from '../render/rule-id-mapping.js';
import { currentRules } from '../rules/registry.js';

import type { FinalizedSignals } from './apply-suppressions.js';
import type { GraphCommandOptions } from './graph-options.js';
import type { Rule } from '../types.js';
import type { Signal, ToolSessionContribution } from '@opensip-cli/core';

/**
 * Build the generic-session contribution for a single-process graph run from
 * branded finalized signals. The host run plane stamps timing + id and persists
 * the row after the handler returns; graph never writes the generic session row.
 */
export function buildGraphSessionContribution(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  finalized: FinalizedSignals,
): ToolSessionContribution {
  return contributionFromSignals(opts, finalized.signals);
}

/**
 * Build the aggregate generic-session contribution for a `--workspace` run.
 * Child envelopes carry Option-A-mapped OpenSIP rule IDs; reverse-map back to
 * engine slugs so dashboard per-rule metric columns keep working.
 */
export function buildWorkspaceSessionContribution(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  signals: readonly Signal[],
): ToolSessionContribution {
  const engineSignals = signals.map((s) => {
    const ruleId = mapOpenSipRuleIdToEngineSlug(s.ruleId);
    return { ...s, ruleId, source: ruleId };
  });
  return contributionFromSignals(opts, engineSignals);
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
 */
export function contributionFromSignals(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  signals: readonly Signal[],
  evaluatedSlugs: readonly string[] = evaluatedRuleSlugs(),
): ToolSessionContribution {
  const payload = buildGraphSessionPayload(signals, evaluatedSlugs);
  return {
    tool: 'graph',
    cwd: opts.cwd,
    ...(opts.recipe === undefined ? {} : { recipe: opts.recipe }),
    score: passRate(payload.summary),
    passed: payload.summary.errors === 0,
    payload,
  };
}
