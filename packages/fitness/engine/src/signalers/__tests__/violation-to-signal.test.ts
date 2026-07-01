/**
 * Unit tests for `violationToSignal` (ADR-0011, Phase 6) — the fitness
 * violation → core `Signal` mapping. Guards the contract that the migration
 * preserves: `source === ruleId === checkSlug`, the legacy 2-level severity is
 * lifted UP into the 4-level `SignalSeverity` (never collapsed), and the
 * file/line/column ride on `code` (and are mirrored to the flat fields).
 *
 * Pure mapping — no framework, no IO, no mocks. `createSignal` generates a
 * non-deterministic `id`/`createdAt`, so those fields are asserted by shape,
 * not value.
 */
import { describe, expect, it } from 'vitest';

import { violationToSignal } from '../violation-to-signal.js';

import type { RecipeCheckResult } from '../../recipes/types.js';

type RecipeViolation = NonNullable<RecipeCheckResult['violations']>[number];

function violation(over: Partial<RecipeViolation> = {}): RecipeViolation {
  return {
    file: 'src/foo.ts',
    line: 10,
    column: 3,
    message: 'Something is wrong',
    severity: 'error',
    ...over,
  };
}

describe('violationToSignal', () => {
  it('carries the check slug on both source and ruleId', () => {
    const signal = violationToSignal('my-check-slug', violation());
    expect(signal.source).toBe('my-check-slug');
    expect(signal.ruleId).toBe('my-check-slug');
  });

  it('lifts legacy error → high (never collapses)', () => {
    expect(violationToSignal('s', violation({ severity: 'error' })).severity).toBe('high');
  });

  it('lifts legacy warning → medium (never collapses)', () => {
    expect(violationToSignal('s', violation({ severity: 'warning' })).severity).toBe('medium');
  });

  it('maps the code location and mirrors it to the flat fields', () => {
    const signal = violationToSignal('s', violation({ file: 'src/bar.ts', line: 42, column: 7 }));
    expect(signal.code).toEqual({ file: 'src/bar.ts', line: 42, column: 7 });
    expect(signal.filePath).toBe('src/bar.ts');
    expect(signal.line).toBe(42);
    expect(signal.column).toBe(7);
  });

  it('preserves the message and the optional suggestion', () => {
    const signal = violationToSignal(
      's',
      violation({ message: 'Bad import', suggestion: 'Use the barrel' }),
    );
    expect(signal.message).toBe('Bad import');
    expect(signal.suggestion).toBe('Use the barrel');
  });

  it('preserves structured repair guidance from recipe violations', () => {
    const signal = violationToSignal(
      's',
      violation({
        repair: {
          repairKind: 'fix-import',
          autofixable: false,
          confidence: 0.8,
          patchHint: { kind: 'text', summary: 'Use the public barrel' },
        },
      }),
    );
    expect(signal.repair).toEqual({
      repairKind: 'fix-import',
      autofixable: false,
      confidence: 0.8,
      patchHint: { kind: 'text', summary: 'Use the public barrel' },
    });
  });

  it('defaults category to quality and provider to opensip-cli', () => {
    const signal = violationToSignal('s', violation());
    expect(signal.category).toBe('quality');
    expect(signal.provider).toBe('opensip-cli');
  });

  it('produces a well-formed Signal id and ISO createdAt', () => {
    const signal = violationToSignal('s', violation());
    expect(signal.id).toMatch(/^sig_/);
    expect(() => new Date(signal.createdAt).toISOString()).not.toThrow();
  });
});
