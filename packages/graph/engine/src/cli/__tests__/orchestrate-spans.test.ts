/**
 * Graph stage-span — standalone no-op invariant.
 *
 * The graph engine carries NO OpenTelemetry SDK (only the `@opentelemetry/api`
 * no-op facade, via `@opensip-tools/core`'s `withSpan`). So this test proves the
 * load-bearing standalone guarantee at the graph layer: with no provider
 * registered, `runGraph` over a small fixture completes identically and the
 * stage spans it starts are non-recording (emit nothing).
 *
 * The span-CAPTURE assertion — that an enabled run produces the six
 * `opensip_tools.graph.<stage>` spans, in order, with the stage attributes —
 * lives in `opensip-tools`, where the SDK + InMemorySpanExporter
 * legitimately live (`packages/cli/src/telemetry/__tests__/graph-spans.test.ts`).
 * Keeping the SDK out of the tool package is the architectural constraint this
 * split exists to honor.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, getTracer } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { currentAdapterRegistry } from '../../lang-adapter/registry.js';
import { runGraph, GRAPH_STAGES } from '../orchestrate.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';

function fakeAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'fake',
    fileExtensions: ['.ts'],
    displayName: 'fake',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: projectDir,
      files: [join(projectDir, 'src', 'a.ts')],
      configPathAbs: undefined,
      compilerOptions: undefined,
    }),
    parseProject: (): ParseOutput => ({ project: { token: 'parsed' }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({ occurrences: {}, callSites: [], parseErrors: [] }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => 'fake-key-1',
    ruleHints: undefined,
  };
}

describe('graph stage spans — standalone no-op invariant', () => {
  let projectDir: string;

  beforeEach(() => {
    // No SDK provider is ever registered in the graph package (it carries no
    // SDK), so the global tracer stays the API's no-op facade for these tests.
    enterScope(makeGraphTestScope());
    projectDir = mkdtempSync(join(tmpdir(), 'orch-spans-'));
  });

  afterEach(() => {
    currentAdapterRegistry().clear();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('GRAPH_STAGES is the canonical seven-stage set the spans are named after', () => {
    expect(GRAPH_STAGES).toEqual(['discover', 'parse', 'walk', 'resolve', 'index', 'features', 'rules']);
  });

  it('runGraph completes normally and the stage spans are non-recording (emit nothing) with no SDK', async () => {
    currentAdapterRegistry().register(fakeAdapter(projectDir));

    // Capture whether ANY span started during the run is recording. With no
    // provider, every withSpan span is the no-op span → non-recording.
    const recordingFlags: boolean[] = [];
    const probeTracer = getTracer('probe');

    const result = await runGraph({
      cwd: projectDir,
      noCache: true,
      rules: [],
      onProgress: () => {
        probeTracer.startActiveSpan('probe', (span) => {
          recordingFlags.push(span.isRecording());
          span.end();
        });
      },
    });

    // Pipeline ran end-to-end, identical to the un-instrumented behavior.
    expect(result.catalog).not.toBeNull();
    expect(result.indexes).not.toBeNull();
    expect(result.signals).toEqual([]);
    expect(result.cacheHit).toBe(false);

    // Every probed span was non-recording — the standalone no-op guarantee.
    expect(recordingFlags.length).toBeGreaterThan(0);
    expect(recordingFlags.every((r) => r === false)).toBe(true);
  });
});
