/**
 * JSON golden snapshots for the YAGNI tool envelope + session payload.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { executeYagni } from '../cli/execute-yagni.js';
import { unusedConfigSurfaceDetector } from '../detectors/unused-config-surface.js';
import { duplicateBodyCandidateDetector } from '../detectors/duplicate-body-candidate.js';

import type { ToolCliContext } from '@opensip-cli/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, 'fixtures', 'unused-config-surface', 'pkg');
const GOLDEN_PATH = join(HERE, '__fixtures__', 'yagni-golden.json');

function stubCli(): ToolCliContext {
  return {
    scope: { datastore: () => undefined },
    emitEnvelope: () => {},
    emitJson: () => {},
    emitError: () => {},
    render: async () => {},
    renderLive: async () => {},
    registerLiveView: () => {},
    setExitCode: () => {},
    deliverSignals: async () => ({ delivered: false }),
    writeSarif: async () => {},
    maybeOpenReport: async () => {},
  } as unknown as ToolCliContext;
}

function stableJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (key === 'durationMs' && typeof v === 'number') return 0;
      if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) return '<runId>';
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return '<createdAt>';
      return v;
    }),
  );
}

describe('yagni golden snapshots', () => {
  it('unused-config-surface fixture emits a stable finding shape', async () => {
    const result = await unusedConfigSurfaceDetector.run({
      cwd: FIXTURE_ROOT,
      config: { defaultMinConfidence: 0 },
      graphCatalog: null,
      includeTests: false,
    });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.ruleId).toBe('yagni:unused-config-surface');
    expect(result.signals[0]?.metadata.yagni).toMatchObject({
      detector: 'unused-config-surface',
      evidenceKind: 'unused-config-property',
      evidence: expect.objectContaining({ property: 'orphanKnob' }),
    });
  });

  it('executeYagni with --graph off matches the checked-in golden envelope', async () => {
    const outcome = await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: {
          failOnErrors: 0,
          failOnWarnings: 0,
          graphMode: 'off',
          defaultMinConfidence: 0,
        },
        graphMode: 'off',
      },
      stubCli(),
      [unusedConfigSurfaceDetector, duplicateBodyCandidateDetector],
    );

    expect(outcome.session.passed).toBe(true);
    expect(outcome.envelope.verdict.passed).toBe(true);
    expect(outcome.envelope.units.map((u) => u.slug)).toEqual(['yagni:unused-config-surface']);
    expect(outcome.session.payload.summary.skippedDetectors).toEqual([
      {
        id: 'duplicate-body-candidate',
        slug: 'yagni:duplicate-body-candidate',
        reason: 'graph-required',
        detail: 'graph evidence unavailable',
      },
    ]);

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
      sessionSummary: outcome.session.payload.summary,
    });

    const expected = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    expect(actual).toEqual(expected);
  });
});