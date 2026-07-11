import { SIGNAL_ENVELOPE_SCHEMA_VERSION, type SignalEnvelope } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import { projectEnvelopeEvidence, projectLedgerArgs } from '../run-ledger-projection.js';

function envelope(overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    schemaVersion: SIGNAL_ENVELOPE_SCHEMA_VERSION,
    tool: 'fit',
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      passed: true,
      faulted: false,
      score: 1,
      summary: {
        total: 3,
        passed: 3,
        failed: 0,
        errors: 0,
        warnings: 1,
      },
    },
    units: [{ slug: 'unit-a', passed: true, durationMs: 4 }],
    signals: [],
    baselineIdentity: {
      fingerprintStrategyId: 'test',
      fingerprintStrategyVersion: 1,
    },
    ...overrides,
  };
}

describe('run ledger projection', () => {
  describe('projectLedgerArgs', () => {
    it('returns undefined when only host-owned or undefined values are present', () => {
      expect(
        projectLedgerArgs({
          apiKey: 'secret',
          config: 'opensip-cli.config.yml',
          cwd: '/repo',
          json: true,
          quiet: false,
          reportTo: 'cloud',
          value: undefined,
        }),
      ).toBeUndefined();
    });

    it('redacts secrets and sanitizes scalar, nested, long, array, and opaque values', () => {
      const projected = projectLedgerArgs({
        zed: 'last',
        authorization: 'Bearer token',
        count: 3,
        enabled: false,
        empty: null,
        long: 'x'.repeat(505),
        list: Array.from({ length: 55 }, (_, index) => index),
        nested: {
          token: 'nested-secret',
          beta: 'b',
          alpha: {
            one: {
              two: {
                three: 'too deep',
              },
            },
          },
        },
        many: Object.fromEntries(
          Array.from({ length: 55 }, (_, index) => [
            `key-${String(index).padStart(2, '0')}`,
            index,
          ]),
        ),
        big: 42n,
        symbol: Symbol.for('ledger'),
        callable: () => 'not serialized',
      });

      expect(Object.keys(projected ?? {})).toEqual([
        'authorization',
        'big',
        'callable',
        'count',
        'empty',
        'enabled',
        'list',
        'long',
        'many',
        'nested',
        'symbol',
        'zed',
      ]);
      expect(projected).toMatchObject({
        authorization: '<redacted>',
        big: '42',
        callable: '[object Function]',
        count: 3,
        empty: null,
        enabled: false,
        long: `${'x'.repeat(500)}...`,
        symbol: 'Symbol(ledger)',
      });
      expect((projected?.list as readonly unknown[]).length).toBe(50);
      expect(Object.keys(projected?.many as Record<string, unknown>)).toHaveLength(50);
      expect(projected?.nested).toEqual({
        alpha: {
          one: {
            two: '<object>',
          },
        },
        beta: 'b',
        token: '<redacted>',
      });
    });
  });

  describe('projectEnvelopeEvidence', () => {
    it('returns undefined without an envelope', () => {
      expect(projectEnvelopeEvidence(undefined)).toBeUndefined();
    });

    it('projects the stable evidence fields and caps fingerprints', () => {
      const signals = Array.from({ length: 25 }, (_, index) => ({
        fingerprint: `fingerprint-${index}`,
        metadata: {},
      }));

      expect(
        projectEnvelopeEvidence(
          envelope({
            resolutionMode: 'exact',
            // Minimal signal stubs: this test only exercises fingerprint projection/capping.
            signals: signals as unknown as SignalEnvelope['signals'],
          }),
        ),
      ).toEqual({
        schemaVersion: SIGNAL_ENVELOPE_SCHEMA_VERSION,
        tool: 'fit',
        runId: 'run-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        verdict: {
          passed: true,
          faulted: false,
          score: 1,
          errors: 0,
          warnings: 1,
          total: 3,
        },
        signalCount: 25,
        unitCount: 1,
        fingerprints: Array.from({ length: 20 }, (_, index) => `fingerprint-${index}`),
        resolutionMode: 'exact',
      });
    });

    it('omits optional evidence fields when there are no string fingerprints or resolution mode', () => {
      expect(
        projectEnvelopeEvidence(
          envelope({
            // Minimal signal stub with no string fingerprint (defensive path).
            signals: [
              { fingerprint: undefined, metadata: {} },
            ] as unknown as SignalEnvelope['signals'],
          }),
        ),
      ).toEqual({
        schemaVersion: SIGNAL_ENVELOPE_SCHEMA_VERSION,
        tool: 'fit',
        runId: 'run-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        verdict: {
          passed: true,
          faulted: false,
          score: 1,
          errors: 0,
          warnings: 1,
          total: 3,
        },
        signalCount: 1,
        unitCount: 1,
      });
    });
  });
});
