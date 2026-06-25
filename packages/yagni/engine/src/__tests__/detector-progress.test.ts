import { describe, expect, it, vi } from 'vitest';

import { executeYagni } from '../cli/execute-yagni.js';
import { duplicateBodyCandidateDetector } from '../detectors/duplicate-body-candidate.js';
import { unusedConfigSurfaceDetector } from '../detectors/unused-config-surface.js';

import type { ToolCliContext } from '@opensip-cli/core';

const FIXTURE_ROOT = new URL('fixtures/unused-config-surface/pkg', import.meta.url).pathname;

function stubCli(): ToolCliContext {
  return {
    scope: { datastore: () => undefined },
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
  } as unknown as ToolCliContext;
}

describe('executeYagni detector progress callbacks (phases live view)', () => {
  it('reports start/done per detector that runs, and skipped for graph-gated ones', async () => {
    const started: string[] = [];
    const done: { slug: string; durationMs: number }[] = [];
    const skippedBatches: string[][] = [];

    await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: { graphMode: 'off', defaultMinConfidence: 'low' },
        graphMode: 'off', // no graph evidence → duplicate-body-candidate is gated out
        includeTests: true,
        onDetectorStart: (slug) => started.push(slug),
        onDetectorDone: (slug, durationMs) => done.push({ slug, durationMs }),
        onDetectorsSkipped: (slugs) => skippedBatches.push([...slugs]),
      },
      stubCli(),
      [unusedConfigSurfaceDetector, duplicateBodyCandidateDetector],
    );

    // unused-config-surface runs; duplicate-body-candidate needs the graph catalog.
    expect(started).toEqual(['yagni:unused-config-surface']);
    expect(done.map((d) => d.slug)).toEqual(['yagni:unused-config-surface']);
    expect(typeof done[0]?.durationMs).toBe('number');
    // The skipped batch is emitted once, before the run loop.
    expect(skippedBatches).toEqual([['yagni:duplicate-body-candidate']]);
  });

  it('start precedes done for the same detector', async () => {
    const events: string[] = [];
    await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: { graphMode: 'off', defaultMinConfidence: 'low' },
        graphMode: 'off',
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
});
