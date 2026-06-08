/**
 * createGraphSignal — stamps source/ruleId + applies the override, reproducing the
 * signal a rule used to hand-assemble (release 2.13.0, §5.9). Byte-equality with
 * the former `createSignal({ source:'graph', ruleId, severity:
 * applySeverityOverride(...) })` shape (modulo the generated id/timestamp).
 */

import { createSignal, type Signal } from '@opensip-tools/core';
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

  it('reproduces the former hand-assembled signal byte-for-byte (sans id/timestamp)', () => {
    const viaFactory = createGraphSignal('graph:cycle', CONFIG, BODY);
    const viaHand = createSignal({
      source: 'graph',
      severity: applySeverityOverride(BODY.severity, 'graph:cycle', CONFIG),
      category: BODY.category,
      ruleId: 'graph:cycle',
      message: BODY.message,
      code: BODY.code,
      suggestion: BODY.suggestion,
      metadata: BODY.metadata,
    });
    expect(stable(viaFactory)).toEqual(stable(viaHand));
  });

  it('applies a configured severity override', () => {
    const config = { severityOverrides: { 'graph:cycle': 'error' } } as unknown as GraphConfig;
    expect(createGraphSignal('graph:cycle', config, BODY).severity).toBe('high');
  });
});
