import { describe, expect, it, vi } from 'vitest';

import { executeYagni } from '../cli/execute-yagni.js';
import { detectorDoneEvent, detectorLabel, detectorStartEvent } from '../cli/yagni-progress.js';
import { unusedConfigSurfaceDetector } from '../detectors/unused-config-surface.js';

import type { YagniDetector } from '../detectors/types.js';
import type { ToolCliContext } from '@opensip-cli/core';

const FIXTURE_ROOT = new URL('fixtures/unused-config-surface/pkg', import.meta.url).pathname;

function stubCli(): ToolCliContext {
  return {
    scope: { datastore: () => undefined },
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
}

const disabledStub: YagniDetector = {
  id: 'disabled-stub',
  slug: 'yagni:disabled-stub',
  description: 'stub detector disabled via config (test only)',
  run: () => Promise.resolve({ signals: [], durationMs: 0 }),
};

const throwingStub: YagniDetector = {
  id: 'throwing-stub',
  slug: 'yagni:throwing-stub',
  description: 'stub detector that throws (test only)',
  run: () => Promise.reject(new Error('detector exploded')),
};

describe('executeYagni detector progress callbacks (phases live view)', () => {
  it('formats detector labels and progress events', () => {
    expect(detectorLabel('yagni:unused-config-surface')).toBe('Unused Config Surface');
    expect(detectorLabel('yagni:multi--dash')).toBe('Multi  Dash');
    expect(detectorStartEvent('yagni:unused-config-surface')).toEqual({
      type: 'stage-start',
      stage: 'yagni:unused-config-surface',
      label: 'Unused Config Surface',
    });
    expect(detectorDoneEvent('yagni:unused-config-surface', 12)).toEqual({
      type: 'stage-done',
      stage: 'yagni:unused-config-surface',
      durationMs: 12,
    });
    expect(detectorDoneEvent('yagni:unused-config-surface', 0, 'skipped')).toEqual({
      type: 'stage-done',
      stage: 'yagni:unused-config-surface',
      durationMs: 0,
      detail: 'skipped',
    });
  });

  it('reports start/done per detector that runs, and skips disabled detectors', async () => {
    const started: string[] = [];
    const done: { slug: string; durationMs: number }[] = [];
    const skippedBatches: string[][] = [];

    await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: {
          defaultMinConfidence: 'low',
          disabledDetectors: ['yagni:disabled-stub'],
        },
        includeTests: true,
        onDetectorStart: (slug) => started.push(slug),
        onDetectorDone: (slug, durationMs) => done.push({ slug, durationMs }),
        onDetectorsSkipped: (slugs) => skippedBatches.push([...slugs]),
      },
      stubCli(),
      [unusedConfigSurfaceDetector, disabledStub],
    );

    expect(started).toEqual(['yagni:unused-config-surface']);
    expect(done.map((d) => d.slug)).toEqual(['yagni:unused-config-surface']);
    expect(typeof done[0]?.durationMs).toBe('number');
    expect(skippedBatches).toEqual([['yagni:disabled-stub']]);
  });

  it('start precedes done for the same detector', async () => {
    const events: string[] = [];
    await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: { defaultMinConfidence: 'low' },
        includeTests: true,
        onDetectorStart: (slug) => events.push(`start:${slug}`),
        onDetectorDone: (slug) => events.push(`done:${slug}`),
      },
      stubCli(),
      [unusedConfigSurfaceDetector],
    );
    expect(events).toEqual([
      'start:yagni:unused-config-surface',
      'done:yagni:unused-config-surface',
    ]);
  });

  it('records a failed unit when a detector throws', async () => {
    const events: string[] = [];
    const outcome = await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: { defaultMinConfidence: 'low' },
        includeTests: true,
        onDetectorStart: (slug) => events.push(`start:${slug}`),
        onDetectorDone: (slug) => events.push(`done:${slug}`),
      },
      stubCli(),
      [throwingStub],
    );

    expect(events).toEqual(['start:yagni:throwing-stub', 'done:yagni:throwing-stub']);
    expect(outcome.envelope.units).toHaveLength(1);
    expect(outcome.envelope.units[0]).toMatchObject({
      slug: 'yagni:throwing-stub',
      passed: false,
      error: 'detector exploded',
    });
  });
});
