/**
 * createGraphSignal — stamps source/ruleId + applies the override, reproducing the
 * signal a rule used to hand-assemble (release 2.13.0, §5.9). Byte-equality with
 * the former `createSignal({ source:'graph', ruleId, severity:
 * applySeverityOverride(...) })` shape (modulo the generated id/timestamp).
 */

import { createSignal, type Signal } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import { applySeverityOverride } from '../_severity-override.js';
import { createGraphSignal } from '../create-graph-signal.js';

import type { GraphConfig } from '../../types.js';

const CONFIG = {} as GraphConfig;
const BODY = {
  severity: 'medium' as const,
  category: 'architecture',
  message: 'x is part of a cycle',
  code: { file: 'src/a.ts', line: 1, column: 2 },
  suggestion: 'Break the cycle',
  metadata: { sccId: 's1' },
};

/** Strip the non-deterministic fields (generated id + timestamp) for comparison. */
function stable(signal: Signal): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...signal };
  delete copy.id;
  delete copy.createdAt;
  return copy;
}

describe('createGraphSignal', () => {
  it('stamps source=graph and ruleId=slug', () => {
    const s = createGraphSignal('graph:cycle', CONFIG, BODY);
    expect(s.source).toBe('graph');
    expect(s.ruleId).toBe('graph:cycle');
    expect(s.severity).toBe('medium'); // no override → base
    expect(s.category).toBe('architecture');
    expect(s.metadata).toEqual({ sccId: 's1' });
  });

  it('lifts 0-based occurrence columns to 1-based Signal columns (ADR-0179)', () => {
    // BODY.code.column is parser-native 0-based (2 → character index 2).
    // Signal must store 1-based (3) so SARIF startColumn points at that char.
    const viaFactory = createGraphSignal('graph:cycle', CONFIG, BODY);
    expect(viaFactory.column).toBe(3);
    expect(viaFactory.code?.column).toBe(3);

    const viaHand = createSignal({
      source: 'graph',
      severity: applySeverityOverride(BODY.severity, 'graph:cycle', CONFIG),
      category: BODY.category,
      ruleId: 'graph:cycle',
      message: BODY.message,
      code: {
        ...BODY.code,
        column: (BODY.code.column ?? 0) + 1,
      },
      suggestion: BODY.suggestion,
      metadata: BODY.metadata,
    });
    expect(stable(viaFactory)).toEqual(stable(viaHand));
  });

  it('maps 0-based column 0 to Signal column 1 (start of line)', () => {
    const s = createGraphSignal('graph:large-function', CONFIG, {
      ...BODY,
      code: { file: 'src/a.ts', line: 10, column: 0 },
    });
    expect(s.column).toBe(1);
    expect(s.code?.column).toBe(1);
  });

  it('applies a configured severity override', () => {
    const config = {
      severityOverrides: { 'graph:cycle': 'error' },
    } as unknown as GraphConfig;
    expect(createGraphSignal('graph:cycle', config, BODY).severity).toBe('high');
  });
});
