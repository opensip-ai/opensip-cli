import { describe, expect, it } from 'vitest';

import { buildYagniSessionPayload } from '../persistence/session-payload.js';
import { yagniReplayFromSession } from '../persistence/session-replay.js';
import { buildYagniRunSummary } from '../scoring/confidence.js';

import type { SignalEnvelope, StoredSession } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    source: 'yagni:unused-config-surface',
    provider: 'yagni',
    severity: 'medium',
    category: 'quality',
    ruleId: 'yagni:unused-config-surface',
    message: 'Unused public config key',
    filePath: 'src/config.ts',
    line: 12,
    column: 5,
    suggestion: 'Remove the unused key.',
    metadata: {
      yagni: {
        detector: 'yagni:unused-config-surface',
        reductionCategory: 'config',
        confidence: 'high',
        preservationArgument: 'No reads found.',
        suggestedAction: 'Remove the unused key.',
        validationRequired: ['Run tests'],
        riskTags: [],
        evidence: [{ id: 'ev-1', kind: 'usage', summary: 'No references' }],
      },
    },
    createdAt: '2026-06-25T00:00:00.000Z',
    ...overrides,
  };
}

function envelope(signals: readonly Signal[]): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'yagni',
    runId: 'run-1',
    createdAt: '2026-06-25T00:00:00.000Z',
    verdict: {
      score: 80,
      passed: false,
      summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 },
    },
    units: [
      {
        slug: 'yagni:unused-config-surface',
        passed: false,
        violationCount: signals.length,
        durationMs: 4,
      },
    ],
    signals,
    baselineIdentity: {
      fingerprintStrategyId: 'yagni.sha256-detector-locations',
      fingerprintStrategyVersion: 1,
    },
  };
}

function storedSession(payload: unknown): StoredSession {
  return {
    id: 'YAGNI_1',
    tool: 'yagni',
    cwd: '/repo',
    startedAt: '2026-06-25T00:00:00.000Z',
    completedAt: '2026-06-25T00:00:00.000Z',
    score: 80,
    passed: false,
    durationMs: 10,
    payload,
  };
}

describe('yagniReplayFromSession', () => {
  it('projects a stored yagni payload back into a replay envelope', () => {
    const signals = [signal()];
    const payload = buildYagniSessionPayload(
      envelope(signals),
      [],
      buildYagniRunSummary(signals, []),
    );

    const replay = yagniReplayFromSession(storedSession(payload));

    expect(replay.fidelity).toBe('projection');
    expect(replay.envelope.tool).toBe('yagni');
    expect(replay.envelope.runId).toBe('YAGNI_1');
    expect(replay.envelope.verdict.summary).toEqual({
      total: 1,
      passed: 0,
      failed: 1,
      errors: 0,
      warnings: 1,
    });
    expect(replay.envelope.units).toEqual([
      {
        slug: 'yagni:unused-config-surface',
        passed: false,
        violationCount: 1,
        durationMs: 4,
      },
    ]);
    expect(replay.envelope.signals[0]).toMatchObject({
      source: 'yagni:unused-config-surface',
      provider: 'yagni',
      severity: 'medium',
      category: 'quality',
      ruleId: 'yagni:unused-config-surface',
      filePath: 'src/config.ts',
      code: { file: 'src/config.ts', line: 12, column: 5 },
      metadata: signals[0]?.metadata,
    });
    expect(replay.envelope.baselineIdentity).toEqual({
      fingerprintStrategyId: 'yagni.sha256-detector-locations',
      fingerprintStrategyVersion: 1,
    });
    expect(replay.result.type).toBe('run-presentation');
    expect(replay.result.tool).toBe('yagni');
    expect(replay.result.envelope).toBe(replay.envelope);
  });

  it('throws when the stored payload is not a yagni session payload', () => {
    expect(() => yagniReplayFromSession(storedSession({ checks: [] }))).toThrow(
      /no replay payload/,
    );
  });
});
