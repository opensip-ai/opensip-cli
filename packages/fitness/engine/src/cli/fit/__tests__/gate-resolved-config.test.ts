/**
 * gate-resolved-config — proves fit's findings policy (ADR-0035) reads its
 * `failOnErrors` / `failOnWarnings` thresholds off the host-RESOLVED config block
 * (`scope.toolConfig.fitness`), NOT the re-parsed `signalersConfig.fitness.*`
 * (ADR-0023, Phase 4), and falls back to `signalersConfig` (then `{1,0}`) when no
 * toolConfig is present (config-less / off-CLI).
 *
 * Post-ADR-0035, this resolution lives in `resolveFitVerdictPolicy` and feeds
 * `envelope.verdict.passed` — the single exit driver. The declared env bindings
 * OPENSIP_FIT_FAIL_ON_ERRORS / OPENSIP_FIT_FAIL_ON_WARNINGS resolve into
 * `scope.toolConfig.fitness`; these tests pin that they drive the policy
 * (overriding the file source) and that the fallback chain holds. This is the
 * regression guard that env bindings are no longer no-ops at the gate.
 */

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  policyPasses,
  runWithScopeSync,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { resolveFitVerdictPolicy } from '../result-builders.js';

import type { SignalersConfig } from '../../../signalers/types.js';
import type { ResolvedToolConfig, VerdictPolicy } from '@opensip-cli/core';

/** Fresh scope with empty registries — local equivalent of the retired
 *  `@opensip-cli/core/test-utils` helper. The fitness engine's own tests
 *  cannot use `@opensip-cli/test-support` (it depends on this package —
 *  the dev edge would make the package graph cyclic; ADR-0040). */
const makeTestScope = (): RunScope =>
  new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });

/** The minimal `signalersConfig` shape `resolveFitVerdictPolicy` reads as the FALLBACK source. */
function makeSignalersConfig(failOnErrors: number, failOnWarnings: number): SignalersConfig {
  return {
    fitness: { failOnErrors, failOnWarnings, disabledChecks: [] },
    cli: {},
  } as unknown as SignalersConfig;
}

/** Resolve fit's policy inside a scope carrying the given resolved toolConfig. */
function policyWith(
  signalers: SignalersConfig,
  toolConfig: ResolvedToolConfig | undefined,
): VerdictPolicy {
  const scope = makeTestScope();
  if (toolConfig !== undefined) Object.assign(scope, { toolConfig });
  return runWithScopeSync(scope, () => resolveFitVerdictPolicy(signalers));
}

describe('fit findings policy reads thresholds off scope.toolConfig.fitness (ADR-0023 / ADR-0035)', () => {
  it('OPENSIP_FIT_FAIL_ON_ERRORS=0 (resolved) → an error-emitting run does NOT fail, even though the file says failOnErrors:1', () => {
    // File source says fail-on-errors:1 — the OLD behaviour would fail here.
    const policy = policyWith(makeSignalersConfig(1, 0), {
      fitness: { failOnErrors: 0, failOnWarnings: 0 },
    });
    expect(policy.failOnErrors).toBe(0);
    // 0 = never fail on errors → a 3-error run passes.
    expect(policyPasses({ errors: 3, warnings: 0 }, policy)).toBe(true);
  });

  it('OPENSIP_FIT_FAIL_ON_WARNINGS=1 (resolved) → a warning-only run FAILs, even though the file says failOnWarnings:0', () => {
    // File source says fail-on-warnings:0 — the OLD behaviour would pass here.
    const policy = policyWith(makeSignalersConfig(1, 0), {
      fitness: { failOnErrors: 1, failOnWarnings: 1 },
    });
    expect(policy.failOnWarnings).toBe(1);
    expect(policyPasses({ errors: 0, warnings: 2 }, policy)).toBe(false);
  });

  it('falls back to signalersConfig when the scope carries no toolConfig (config-less / off-CLI)', () => {
    // No resolved block on the scope → the file source drives the policy.
    const policy = policyWith(makeSignalersConfig(1, 0), undefined);
    expect(policy.failOnErrors).toBe(1);
    expect(policyPasses({ errors: 2, warnings: 0 }, policy)).toBe(false);
  });
});
