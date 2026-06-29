import { describe, expect, it } from 'vitest';

import { createSignal } from '../../types/signal.js';
import { renderGateCompareLines } from '../gate-compare-render.js';

import type { CreateSignalInput, Signal } from '../../types/signal.js';
import type { GateCompareResult } from '../tool-results.js';

function signal(input: Partial<CreateSignalInput> & Pick<CreateSignalInput, 'ruleId'>): Signal {
  return createSignal({
    source: 'unit',
    severity: 'medium',
    ruleId: input.ruleId,
    message: input.message ?? input.ruleId,
    code: input.code,
    metadata: input.metadata,
  });
}

function result(input: Partial<GateCompareResult>): GateCompareResult {
  return {
    added: input.added ?? [],
    resolved: input.resolved ?? [],
    unchanged: input.unchanged ?? [],
    degraded: input.degraded ?? false,
  };
}

describe('renderGateCompareLines', () => {
  it('renders added signals in deterministic order with locations and messages', () => {
    const lines = renderGateCompareLines(
      result({
        degraded: true,
        added: [
          signal({
            ruleId: 'z-rule',
            message: 'short',
            code: { file: 'src/z.ts' },
          }),
          signal({
            ruleId: 'a-rule',
            message: 'a-rule',
            code: { file: 'src/a.ts', line: 2 },
          }),
          signal({
            ruleId: 'b-rule',
            message: 'this message is intentionally long',
          }),
        ],
      }),
      {
        title: 'tool gate compare',
        singularNoun: 'finding',
        messageMax: 12,
      },
    );

    expect(lines.slice(0, 3)).toEqual(['tool gate compare', '', 'Added (3):']);
    expect(lines[3]).toMatch(/^ {2}✗ a-rule\s+src\/a\.ts:2$/);
    expect(lines[4]).toMatch(/^ {2}✗ b-rule\s+\(no location\)$/);
    expect(lines[5]).toBe('      this messag…');
    expect(lines[6]).toMatch(/^ {2}✗ z-rule\s+src\/z\.ts$/);
    expect(lines[7]).toBe('      short');
    expect(lines.at(-1)).toBe('✗ DEGRADED — 3 new findings');
  });

  it('renders resolved and unchanged buckets with an improved verdict', () => {
    const lines = renderGateCompareLines(
      result({
        resolved: [
          signal({
            ruleId: 'resolved-rule',
            code: { file: 'src/resolved.ts', line: 7 },
          }),
        ],
        unchanged: [
          signal({ ruleId: 'a-unchanged', code: { file: 'src/a.ts' } }),
          signal({ ruleId: 'b-unchanged', code: { file: 'src/b.ts' } }),
        ],
      }),
      {
        title: 'tool gate compare',
        singularNoun: 'violation',
        unchangedSampleLimit: 1,
      },
    );

    expect(lines).toContain('Resolved (1):');
    expect(lines).toContain('Unchanged (2):');
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ {2}✓ resolved-rule\s+src\/resolved\.ts:7$/),
        expect.stringMatching(/^ {2}· a-unchanged\s+src\/a\.ts$/),
        '  · ... and 1 more',
        '✓ IMPROVED — 1 violation resolved, none added',
      ]),
    );
  });

  it('renders a stable verdict when there is no baseline delta', () => {
    expect(
      renderGateCompareLines(result({}), {
        title: 'tool gate compare',
        singularNoun: 'finding',
      }),
    ).toEqual(['tool gate compare', '', '✓ STABLE — no change']);
  });

  it('honours an explicit plural noun in degraded verdicts', () => {
    const lines = renderGateCompareLines(
      result({
        degraded: true,
        added: [signal({ ruleId: 'first' }), signal({ ruleId: 'second' })],
      }),
      {
        title: 'tool gate compare',
        singularNoun: 'entry',
        pluralNoun: 'entries',
      },
    );

    expect(lines.at(-1)).toBe('✗ DEGRADED — 2 new entries');
  });
});
