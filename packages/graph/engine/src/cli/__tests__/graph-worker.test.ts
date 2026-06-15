/**
 * `graph-run-worker` — the headless graph build forked by the live view
 * (`executeGraphWorker`, ADR-0028). It reads a serializable spec, re-derives
 * config + rules, runs `runGraph` headless, streams stage progress over the fork
 * IPC channel (`process.send`), and posts the slim {@link LiveGraphOutput}
 * (`{ signals, reportLines }`) — never the raw RunGraphResult, which can't cross
 * the boundary. A bad spec is reported as a `{ kind: 'error' }` message, not a throw.
 *
 * The test stubs `process.send` (the process is not actually forked under vitest)
 * and registers a fake language adapter so the build runs without real source.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { currentAdapterRegistry } from '../../lang-adapter/registry.js';
import { executeGraphWorker } from '../graph-worker.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type { LiveGraphOutput } from '../graph.js';
import type { ProgressEvent } from '@opensip-cli/cli-ui';
import type { ToolCliContext, WorkerMessage } from '@opensip-cli/core';

type Msg = WorkerMessage<ProgressEvent, LiveGraphOutput>;

function fakeAdapter(): GraphLanguageAdapter {
  return {
    id: 'typescript',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: '/unused',
      files: [],
      configPathAbs: undefined,
      compilerOptions: undefined,
    }),
    parseProject: (): ParseOutput => ({ project: { dummy: true }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {
        fn: [
          {
            bodyHash: 'h1',
            simpleName: 'fn',
            qualifiedName: 'pkg/a.fn',
            filePath: 'pkg/a.ts',
            line: 1,
            column: 0,
            endLine: 2,
            kind: 'function-declaration',
            params: [],
            returnType: null,
            enclosingClass: null,
            decorators: [],
            visibility: 'exported',
            inTestFile: false,
            definedInGenerated: false,
            calls: [],
          },
        ],
      },
      callSites: [],
      parseErrors: [],
    }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map([['h1', []]]),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => 'fake-graph-worker-v1',
  };
}

/** A ToolCliContext whose scope datastore is absent (the worker runs cache-free). */
function mockCli(): ToolCliContext {
  return { scope: { datastore: () => undefined } } as unknown as ToolCliContext;
}

let dir: string;
let messages: Msg[];

beforeEach(() => {
  enterScope(makeGraphTestScope());
  currentAdapterRegistry().register(fakeAdapter());
  dir = mkdtempSync(join(tmpdir(), 'graph-worker-test-'));
  messages = [];
  // The worker posts via process.send (a no-op when not forked); stub it to capture.
  // process.send is undefined under vitest, so deleting it in afterEach restores state.
  (process as { send?: unknown }).send = vi.fn((m: Msg) => {
    messages.push(m);
    return true;
  });
});

afterEach(() => {
  currentAdapterRegistry().clear();
  delete (process as { send?: unknown }).send;
  rmSync(dir, { recursive: true, force: true });
});

describe('executeGraphWorker', () => {
  it('runs the build and posts a slim LiveGraphOutput result over IPC', async () => {
    const specPath = join(dir, 'spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({ cwd: dir, resolution: 'exact', noCache: true }),
      'utf8',
    );

    await executeGraphWorker(specPath, mockCli());

    const result = messages.find((m) => m.kind === 'result');
    expect(result?.kind).toBe('result');
    if (result?.kind !== 'result') throw new Error('no result message');
    // The payload is the slim, plain-data shape — arrays only, no class instances/Maps.
    expect(Array.isArray(result.value.signals)).toBe(true);
    expect(Array.isArray(result.value.reportLines)).toBe(true);
    expect(result.value.reportLines.join('\n')).toContain('== Catalog ==');
    // No raw RunGraphResult fields leaked across the boundary.
    expect((result.value as { catalog?: unknown }).catalog).toBeUndefined();
    expect((result.value as { indexes?: unknown }).indexes).toBeUndefined();
  });

  it('streams stage progress events before the result', async () => {
    const specPath = join(dir, 'spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({ cwd: dir, resolution: 'exact', noCache: true }),
      'utf8',
    );

    await executeGraphWorker(specPath, mockCli());

    const progress = messages.filter((m) => m.kind === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    // Result is the last message — progress precedes it.
    expect(messages.at(-1)?.kind).toBe('result');
  });

  it('reports a bad spec path as an error message, not a throw', async () => {
    await expect(executeGraphWorker(join(dir, 'missing.json'), mockCli())).resolves.toBeUndefined();
    const err = messages.find((m) => m.kind === 'error');
    expect(err?.kind).toBe('error');
    expect(messages.some((m) => m.kind === 'result')).toBe(false);
  });
});
