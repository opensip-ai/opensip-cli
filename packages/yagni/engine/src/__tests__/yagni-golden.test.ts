/**
 * JSON golden snapshots for the YAGNI tool envelope + session payload.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { executeYagni } from '../cli/execute-yagni.js';
import { unusedConfigSurfaceDetector } from '../detectors/unused-config-surface.js';

import type { ToolCliContext } from '@opensip-cli/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, 'fixtures', 'unused-config-surface', 'pkg');
const GOLDEN_PATH = join(HERE, '__fixtures__', 'yagni-golden.json');

function normalizeFixturePath(value: string): string {
  if (!value.startsWith(FIXTURE_ROOT)) return value;
  return `<fixture>/${relative(FIXTURE_ROOT, value).split('\\').join('/')}`;
}

function stubCli(): ToolCliContext {
  return {
    scope: { datastore: () => undefined },
    emitEnvelope: vi.fn(),
    emitJson: vi.fn(),
    emitError: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    renderLive: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    setExitCode: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
    writeSarif: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
}

function stableJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (key === 'durationMs' && typeof v === 'number') return 0;
      if (key === 'fingerprint' && typeof v === 'string') return '<fingerprint>';
      if (key === 'id' && typeof v === 'string' && v.startsWith('sig_')) return '<signalId>';
      if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) return '<runId>';
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return '<createdAt>';
      if (typeof v === 'string') return normalizeFixturePath(v);
      return v;
    }),
  );
}

describe('yagni golden snapshots', () => {
  it('unused-config-surface fixture emits a stable finding shape', async () => {
    const result = await unusedConfigSurfaceDetector.run({
      cwd: FIXTURE_ROOT,
      config: { defaultMinConfidence: 'low' },
      graphCatalog: null,
      includeTests: true,
    });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.ruleId).toBe('yagni:unused-config-surface');
    expect(result.signals[0]?.metadata.yagni).toMatchObject({
      detector: 'unused-config-surface',
      reductionCategory: 'config',
      confidence: 'high',
      evidence: expect.arrayContaining([
        expect.objectContaining({
          kind: 'unused-config-property',
          data: expect.objectContaining({ property: 'orphanKnob' }),
        }),
      ]),
    });
  });

  it('executeYagni matches the checked-in golden envelope', async () => {
    const outcome = await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: {
          failOnErrors: 0,
          failOnWarnings: 0,
          graphMode: 'off',
          defaultMinConfidence: 'low',
        },
        graphMode: 'off',
        includeTests: true,
      },
      stubCli(),
      [unusedConfigSurfaceDetector],
    );

    expect(outcome.session.passed).toBe(true);
    expect(outcome.envelope.verdict.passed).toBe(true);
    expect(outcome.envelope.units.map((u) => u.slug)).toEqual(['yagni:unused-config-surface']);
    // No graph-backed detectors remain (ADR-0063); nothing is skipped.
    expect(outcome.session.payload.summary.skippedDetectors).toEqual([]);

    const actual = stableJson({
      verdict: outcome.envelope.verdict,
      units: outcome.envelope.units,
      signals: outcome.envelope.signals.map((s) => ({
        ruleId: s.ruleId,
        message: s.message,
        severity: s.severity,
        filePath: s.filePath,
        line: s.line,
        metadata: s.metadata,
      })),
      sessionSummary: {
        ...outcome.session.payload.summary,
        yagni: outcome.session.payload.summary.yagni,
      },
    });

    const expected = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    expect(actual).toEqual(expected);
  });

  it('executeYagni is deterministic for a fixed graph mode on the fixture', async () => {
    const opts = {
      cwd: FIXTURE_ROOT,
      config: { graphMode: 'off' as const, defaultMinConfidence: 'low' as const },
      graphMode: 'off' as const,
      includeTests: true,
    };
    const firstRun = await executeYagni(opts, stubCli(), [unusedConfigSurfaceDetector]);
    const secondRun = await executeYagni(opts, stubCli(), [unusedConfigSurfaceDetector]);
    const first = stableJson(firstRun.envelope.signals);
    const second = stableJson(secondRun.envelope.signals);
    expect(first).toEqual(second);
  });
});
