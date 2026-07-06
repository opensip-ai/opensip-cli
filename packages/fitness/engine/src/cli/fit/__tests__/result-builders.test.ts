import { createSignal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { SignalersConfigSchema } from '../../../signalers/schema.js';
import { buildFitEnvelope, buildFitnessSessionPayload } from '../result-builders.js';

import type { FitnessRecipeResult, RecipeCheckResult } from '../../../recipes/types.js';

const signalersConfig = SignalersConfigSchema.parse({});

function checkResult(overrides: Partial<RecipeCheckResult> = {}): RecipeCheckResult {
  return {
    checkId: 'CHK_rich',
    checkSlug: 'rich-check',
    passed: false,
    violationCount: 1,
    errorCount: 1,
    warningCount: 0,
    ignoredCount: 0,
    durationMs: 7,
    totalItems: 1,
    itemType: 'files',
    skipped: false,
    effectiveSignals: [
      createSignal({
        source: 'fitness',
        provider: 'rich-provider',
        severity: 'high',
        category: 'architecture',
        ruleId: 'fit:rich-check',
        message: 'keep identity stable',
        suggestion: 'keep the rich fields',
        code: { file: 'src/rich.ts', line: 3, column: 11 },
        metadata: { checkSlug: 'rich-check', custom: 'preserved' },
      }),
    ],
    ...overrides,
  };
}

function recipeResult(checkResults: readonly RecipeCheckResult[]): FitnessRecipeResult {
  return {
    recipeId: 'RCP_test',
    recipeName: 'test',
    sessionId: 'SES_test',
    success: false,
    startedAt: new Date('2026-07-01T00:00:00.000Z'),
    completedAt: new Date('2026-07-01T00:00:01.000Z'),
    durationMs: 1000,
    checkResults,
    summary: {
      totalChecks: checkResults.length,
      passedChecks: checkResults.filter((cr) => cr.passed).length,
      failedChecks: checkResults.filter((cr) => !cr.passed).length,
      skippedChecks: 0,
      erroredChecks: 0,
      totalViolations: checkResults.reduce((sum, cr) => sum + cr.violationCount, 0),
      totalErrors: checkResults.reduce((sum, cr) => sum + cr.errorCount, 0),
      totalWarnings: checkResults.reduce((sum, cr) => sum + cr.warningCount, 0),
      totalIgnored: 0,
    },
  };
}

describe('buildFitEnvelope', () => {
  it('normalizes fitness signal identity before stamping while preserving rich fields', () => {
    const envelope = buildFitEnvelope(recipeResult([checkResult()]), 'test', signalersConfig);
    const signal = envelope.signals[0];

    expect(signal?.source).toBe('rich-check');
    expect(signal?.ruleId).toBe('rich-check');
    expect(signal?.fingerprint).toBe(
      '2ba1046533d9ab506c1dd6ef5f9047ec54cc4e452257850de70042710ec1d074',
    );
    // Wire `provider` is pinned to the historical value for EVERY fitness signal
    // (the pre-refactor re-lift forced `createSignal`'s 'opensip-cli' default,
    // overriding any check-supplied provider). The fixture sets 'rich-provider';
    // the normalized envelope must still report 'opensip-cli' so consumers
    // keying on it keep working — byte-stable, like source/ruleId.
    expect(signal?.provider).toBe('opensip-cli');
    expect(signal?.category).toBe('architecture');
    expect(signal?.metadata).toEqual({ checkSlug: 'rich-check', custom: 'preserved' });
    expect(signal?.severity).toBe('high');
  });

  it('keeps the fitness session payload on the historical dashboard projection', () => {
    const envelope = buildFitEnvelope(recipeResult([checkResult()]), 'test', signalersConfig);
    const payload = buildFitnessSessionPayload(envelope);

    expect(payload).toEqual({
      __version: 1,
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        errors: 1,
        warnings: 0,
      },
      checks: [
        {
          checkSlug: 'rich-check',
          passed: false,
          violationCount: 1,
          findings: [
            {
              ruleId: 'rich-check',
              message: 'keep identity stable',
              severity: 'error',
              filePath: 'src/rich.ts',
              line: 3,
              column: 11,
              suggestion: 'keep the rich fields',
            },
          ],
          durationMs: 7,
        },
      ],
    });
  });
});
