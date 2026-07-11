/**
 * Vitest snapshots for the YAGNI tool envelope + session payload. Uses
 * `toMatchSnapshot` (the repo convention, e.g. output's signal-json test) so a
 * schema change is regenerated with `vitest -u` + a reviewed diff rather than a
 * hand-edited JSON fixture. `stableJson` normalizes volatile fields (ids, run id,
 * timestamps, durations, fingerprints, fixture paths) so the snapshot is stable.
 */

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { executeYagni } from '../cli/execute-yagni.js';
import { unusedConfigSurfaceDetector } from '../detectors/unused-config-surface.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, 'fixtures', 'unused-config-surface', 'pkg');

function normalizeFixturePath(value: string): string {
  if (!value.startsWith(FIXTURE_ROOT)) return value;
  return `<fixture>/${relative(FIXTURE_ROOT, value).split('\\').join('/')}`;
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

  it('executeYagni matches its envelope + session snapshot', async () => {
    const outcome = await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: {
          failOnErrors: 0,
          failOnWarnings: 0,
          defaultMinConfidence: 'low',
        },
        includeTests: true,
      },
      [unusedConfigSurfaceDetector],
    );

    expect(outcome.session.passed).toBe(true);
    expect(outcome.envelope.verdict.passed).toBe(true);
    expect(outcome.envelope.units.map((u) => u.slug)).toEqual(['yagni:unused-config-surface']);
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
        repair: s.repair,
        metadata: s.metadata,
      })),
      sessionSummary: {
        ...outcome.session.payload.summary,
        yagni: outcome.session.payload.summary.yagni,
      },
    });

    expect(actual).toMatchSnapshot();
  });

  it('executeYagni is deterministic on the fixture', async () => {
    const opts = {
      cwd: FIXTURE_ROOT,
      config: { defaultMinConfidence: 'low' as const },
      includeTests: true,
    };
    const firstRun = await executeYagni(opts, [unusedConfigSurfaceDetector]);
    const secondRun = await executeYagni(opts, [unusedConfigSurfaceDetector]);
    const first = stableJson(firstRun.envelope.signals);
    const second = stableJson(secondRun.envelope.signals);
    expect(first).toEqual(second);
  });
});
