// Test that the machine-output contract — the signal envelope (ADR-0011) —
// keeps its documented shape. CliOutput (version '1.0') was retired in Phase 7;
// the envelope (schemaVersion 2) is the single output currency every tool emits.
import { DEFAULT_BASELINE_IDENTITY, type SignalEnvelope } from '@opensip-cli/contracts';
import { describe, it, expect } from 'vitest';

describe('JSON output contract', () => {
  it('SignalEnvelope has required fields', () => {
    // Type-level test — if this compiles, the contract is valid
    const envelope: SignalEnvelope = {
      schemaVersion: 2,
      tool: 'fit',
      runId: 'run-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      verdict: {
        score: 100,
        passed: true,
        summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      },
      units: [{ slug: 'test', passed: true, durationMs: 100 }],
      signals: [],
      baselineIdentity: DEFAULT_BASELINE_IDENTITY,
    };
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.tool).toBe('fit');
  });

  it('schemaVersion is 2', () => {
    // This is the contract — bumping it is a breaking change.
    // Type-level assertion: SignalEnvelope.schemaVersion must be the literal 2.
    const envelope: SignalEnvelope = {
      schemaVersion: 2,
      tool: 'fit',
      runId: '',
      createdAt: '',
      verdict: {
        score: 0,
        passed: true,
        summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      },
      units: [],
      signals: [],
      baselineIdentity: DEFAULT_BASELINE_IDENTITY,
    };
    expect(envelope.schemaVersion).toBe(2);
  });

  it('tool is fit or sim', () => {
    const verdict = {
      score: 0,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    };
    const fitEnvelope: SignalEnvelope = {
      schemaVersion: 2,
      tool: 'fit',
      runId: '',
      createdAt: '',
      verdict,
      units: [],
      signals: [],
      baselineIdentity: DEFAULT_BASELINE_IDENTITY,
    };
    const simEnvelope: SignalEnvelope = {
      schemaVersion: 2,
      tool: 'sim',
      runId: '',
      createdAt: '',
      verdict,
      units: [],
      signals: [],
      baselineIdentity: DEFAULT_BASELINE_IDENTITY,
    };
    expect(fitEnvelope.tool).toBe('fit');
    expect(simEnvelope.tool).toBe('sim');
  });
});
