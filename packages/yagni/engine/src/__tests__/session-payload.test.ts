import { describe, expect, it } from 'vitest';

import {
  buildYagniSessionPayload,
  readYagniSessionPayload,
} from '../persistence/session-payload.js';
import { buildYagniRunSummary } from '../scoring/confidence.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

function minimalEnvelope(): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'yagni',
    runId: 'run-1',
    createdAt: '2026-06-25T00:00:00.000Z',
    verdict: {
      score: 100,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
  };
}

describe('YagniSessionPayload', () => {
  it('round-trips a fresh payload without graph fields', () => {
    const summary = buildYagniRunSummary([], []);
    const payload = buildYagniSessionPayload(minimalEnvelope(), [], summary);
    expect(payload.summary).not.toHaveProperty('graphMode');
    expect(payload.summary).not.toHaveProperty('graphBuilt');
    expect(payload.summary).not.toHaveProperty('graphDetail');
    expect(readYagniSessionPayload(payload)).toEqual(payload);
  });

  it('forward-compat loads pre-feature rows carrying removed graph fields', () => {
    const legacy = {
      __version: 1,
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        errors: 0,
        warnings: 0,
        skippedDetectors: [],
        graphMode: 'off',
        graphBuilt: false,
        graphDetail: 'legacy detail',
        yagni: {
          totalCandidates: 0,
          byConfidence: { high: 0, medium: 0, low: 0 },
          estimatedTotalLocReduction: 0,
          graphMode: 'off',
          skippedDetectors: [],
        },
      },
      checks: [],
    };
    const loaded = readYagniSessionPayload(legacy);
    expect(loaded).toBeDefined();
    expect(loaded?.summary).not.toHaveProperty('graphMode');
    expect(loaded?.summary.yagni).not.toHaveProperty('graphMode');
  });
});
