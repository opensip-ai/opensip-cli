/**
 * gate-resolved-config — proves the fit gate (`shouldFail`, the exit-code
 * driver) reads its `failOnErrors` / `failOnWarnings` thresholds off the
 * host-RESOLVED config block (`scope.toolConfig.fitness`), NOT the re-parsed
 * `signalersConfig.fitness.*` (ADR-0023, Phase 4).
 *
 * The declared env bindings OPENSIP_FIT_FAIL_ON_ERRORS / OPENSIP_FIT_FAIL_ON_WARNINGS
 * are resolved into `scope.toolConfig.fitness` by the host's precedence resolver
 * (flag > env > file > defaults). These tests drive `buildFitDoneResult` with a
 * scope whose `toolConfig.fitness` holds the resolved thresholds and assert
 * `shouldFail` follows the RESOLVED values — overriding what `signalersConfig`
 * (the file source) says. This is the regression guard that env bindings are no
 * longer no-ops at the gate.
 */

import { runWithScopeSync } from '@opensip-tools/core';
import { makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';
import { describe, expect, it } from 'vitest';

import { fitnessTool } from '../../../tool.js';
import { buildFitDoneResult } from '../result-builders.js';

import type { FitnessRecipeResult } from '../../../recipes/types.js';
import type { SignalersConfig } from '../../../signalers/types.js';
import type { BuildFitDoneArgs } from '../result-builders.js';
import type { ResolvedToolConfig } from '@opensip-tools/core';

/** A FitnessRecipeResult with a controllable error/warning summary, no findings detail. */
function makeFitnessResult(totalErrors: number, totalWarnings: number): FitnessRecipeResult {
  return {
    recipeId: 'r',
    recipeName: 'default',
    sessionId: 's',
    success: totalErrors === 0 && totalWarnings === 0,
    startedAt: new Date(0),
    completedAt: new Date(1),
    durationMs: 1,
    checkResults: [],
    summary: {
      totalChecks: 1,
      passedChecks: totalErrors === 0 ? 1 : 0,
      failedChecks: totalErrors === 0 ? 0 : 1,
      skippedChecks: 0,
      erroredChecks: 0,
      totalViolations: totalErrors + totalWarnings,
      totalErrors,
      totalWarnings,
      totalIgnored: 0,
    },
  };
}

/** The minimal `signalersConfig` shape `buildFitDoneResult` reads as the FALLBACK source. */
function makeSignalersConfig(failOnErrors: number, failOnWarnings: number): SignalersConfig {
  return {
    fitness: { failOnErrors, failOnWarnings, disabledChecks: [] },
    cli: {},
  } as unknown as SignalersConfig;
}

/** Build the buildFitDoneResult args bundle. */
function makeArgs(
  fitnessResult: FitnessRecipeResult,
  signalersConfig: SignalersConfig,
): BuildFitDoneArgs {
  return {
    args: { cwd: '/work/project' } as BuildFitDoneArgs['args'],
    fitnessResult,
    // buildFitDoneResult only reads envelope through buildFitVerboseDetail (no
    // verbose flag here) — a minimal stub suffices for the gate logic.
    envelope: {
      tool: 'fit',
      runId: '',
      createdAt: '1970-01-01T00:00:00.000Z',
      units: [],
      signals: [],
      verdict: { passed: true, score: 100 },
      summary: {},
    } as unknown as BuildFitDoneArgs['envelope'],
    signalersConfig,
    recipeName: 'default',
  };
}

/** Run `buildFitDoneResult` inside a scope carrying the given resolved toolConfig. */
function gateWithResolvedConfig(
  args: BuildFitDoneArgs,
  toolConfig: ResolvedToolConfig | undefined,
): boolean {
  const scope = makeTestScope();
  // Install fitness's subscope (checks/recipes/load) — buildFitDoneResult reads
  // getPluginLoadErrors() off scope.fitness.load, so it must be present.
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  if (toolConfig !== undefined) Object.assign(scope, { toolConfig });
  return runWithScopeSync(scope, () => buildFitDoneResult(args).shouldFail === true);
}

describe('fit gate reads thresholds off scope.toolConfig.fitness (ADR-0023, Phase 4)', () => {
  it('OPENSIP_FIT_FAIL_ON_ERRORS=0 (resolved) makes an error-emitting run NOT fail, even though the file says failOnErrors:1', () => {
    // File source says fail-on-errors:1 — the OLD behaviour would fail here.
    const signalers = makeSignalersConfig(1, 0);
    const fitnessResult = makeFitnessResult(/* errors */ 3, /* warnings */ 0);

    // Resolved config (env OPENSIP_FIT_FAIL_ON_ERRORS=0 folded in) → 0 = never fail on errors.
    const resolved: ResolvedToolConfig = { fitness: { failOnErrors: 0, failOnWarnings: 0 } };

    const shouldFail = gateWithResolvedConfig(makeArgs(fitnessResult, signalers), resolved);
    expect(shouldFail).toBe(false);
  });

  it('OPENSIP_FIT_FAIL_ON_WARNINGS=1 (resolved) flips a warning-only run to FAIL, even though the file says failOnWarnings:0', () => {
    // File source says fail-on-warnings:0 — the OLD behaviour would pass here.
    const signalers = makeSignalersConfig(1, 0);
    const fitnessResult = makeFitnessResult(/* errors */ 0, /* warnings */ 2);

    // Resolved config (env OPENSIP_FIT_FAIL_ON_WARNINGS=1 folded in) → fail on any warning.
    const resolved: ResolvedToolConfig = { fitness: { failOnErrors: 1, failOnWarnings: 1 } };

    const shouldFail = gateWithResolvedConfig(makeArgs(fitnessResult, signalers), resolved);
    expect(shouldFail).toBe(true);
  });

  it('falls back to signalersConfig when the scope carries no toolConfig (config-less / off-CLI)', () => {
    // No resolved block on the scope → the file source drives the gate.
    const signalers = makeSignalersConfig(/* failOnErrors */ 1, /* failOnWarnings */ 0);
    const fitnessResult = makeFitnessResult(/* errors */ 2, /* warnings */ 0);

    const shouldFail = gateWithResolvedConfig(makeArgs(fitnessResult, signalers), undefined);
    expect(shouldFail).toBe(true);
  });
});
