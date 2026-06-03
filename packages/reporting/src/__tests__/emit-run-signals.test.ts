import { describe, it, expect } from 'vitest';

import { emitRunSignals } from '../emit-run-signals.js';

import type { CliOutput } from '@opensip-tools/contracts';
import type { EmitResult, SignalBatch, SignalSink } from '@opensip-tools/core';

function output(findings: number): CliOutput {
  return {
    version: '1.0',
    tool: 'fit',
    timestamp: '2026-06-03T00:00:00.000Z',
    score: 50,
    passed: false,
    summary: { total: 1, passed: 0, failed: 1, errors: findings, warnings: 0 },
    durationMs: 1,
    checks: [
      {
        checkSlug: 'demo',
        passed: false,
        durationMs: 1,
        findings: Array.from({ length: findings }, (_, i) => ({
          ruleId: `rule-${i}`,
          message: `m${i}`,
          severity: 'error' as const,
          filePath: `src/f${i}.ts`,
          line: i + 1,
        })),
      },
    ],
  };
}

describe('emitRunSignals', () => {
  it('maps a run’s findings into a SignalBatch and emits via the sink', async () => {
    let captured: SignalBatch | undefined;
    const sink: SignalSink = {
      emit: (b) => {
        captured = b;
        return Promise.resolve({ accepted: b.signals.length, authRejected: false });
      },
    };
    const r = await emitRunSignals({ output: output(2), tool: 'fit', recipe: 'r', cwd: '.', signalSink: sink, repo: {} });
    expect(r.accepted).toBe(2);
    expect(captured?.signals).toHaveLength(2);
    expect(captured?.tool).toBe('fit');
    expect(captured?.signals[0].ruleId).toBe('rule-0');
  });

  it('never throws when the sink throws', async () => {
    const sink: SignalSink = {
      emit: (): Promise<EmitResult> => {
        throw new Error('boom');
      },
    };
    const r = await emitRunSignals({ output: output(1), tool: 'fit', cwd: '.', signalSink: sink, repo: {} });
    expect(r).toEqual({ accepted: 0, authRejected: false });
  });
});
