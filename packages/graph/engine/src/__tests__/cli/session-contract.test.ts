/**
 * D12: one CLI invocation = one session.
 *
 * Regression test asserting that every dispatch branch of executeGraph
 * either CONTRIBUTES exactly one session or zero (for opt-out modes). The
 * commit 2ed25d3 contract must not regress.
 *
 * host-owned-run-timing Phase 3: graph no longer writes the generic session
 * row itself — `executeGraph` RETURNS a `GraphRunOutcome` whose optional
 * `session` the HOST persists after the handler resolves. So "one invocation =
 * one session" is now pinned on the RETURNED contribution (present ⇔ the host
 * persists one row; absent ⇔ opt-out). The payload-shape test persists the
 * returned contribution inline (as the host would) to verify it round-trips
 * through the StoredSession contract.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, generatePrefixedId, LanguageRegistry } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { executeGraph } from '../../cli/graph.js';
import { currentAdapterRegistry } from '../../lang-adapter/registry.js';
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type { GraphSessionPayload } from '../../persistence/session-payload.js';
import type { StoredSession } from '@opensip-cli/contracts';
import type {
  LanguageAdapter,
  ToolCliContext,
  ToolSessionContribution,
  WorkspaceUnit,
} from '@opensip-cli/core';

function fakeAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'fake',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: projectDir,
      files: [join(projectDir, 'src', 'a.ts')],
    }),
    parseProject: (): ParseOutput => ({ project: { dummy: true }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {
        fn: [
          {
            bodyHash: 'h1',
            bodySize: 100,
            simpleName: 'fn',
            qualifiedName: 'src/a.fn',
            filePath: 'src/a.ts',
            line: 1,
            column: 0,
            endLine: 5,
            kind: 'function-declaration',
            params: [],
            returnType: null,
            enclosingClass: null,
            decorators: [],
            visibility: 'module-local',
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
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => 'fake-v1',
  };
}

function mockCli(datastore: DataStore, languages?: LanguageRegistry): ToolCliContext {
  return {
    datastore,
    setExitCode: vi.fn(),
    render: () => Promise.resolve(),
    scope: {
      datastore: () => datastore,
      languages: languages ?? new LanguageRegistry(),
    },
  } as unknown as ToolCliContext;
}

function workspaceLangRegistry(units: readonly WorkspaceUnit[]): LanguageRegistry {
  const r = new LanguageRegistry();
  const adapter: LanguageAdapter = {
    id: 'typescript',
    fileExtensions: ['.ts'],
    parse: () => null,
    stripStrings: (s) => s,
    stripComments: (s) => s,
    // eslint-disable-next-line @typescript-eslint/require-await
    discoverWorkspaceUnits: async () => units,
  };
  r.register(adapter);
  return r;
}

/**
 * Persist a returned {@link ToolSessionContribution} exactly as the host run
 * plane would (stamping `startedAt`/`completedAt`/`durationMs`/`id` — timing is
 * host-owned now). Mirrors the StoredSession contract so the payload-shape test
 * exercises the same round-trip the production host path produces.
 */
function hostPersist(datastore: DataStore, contribution: ToolSessionContribution): void {
  const now = '2026-01-01T00:00:00.000Z';
  const row: StoredSession = {
    id: generatePrefixedId('graph'),
    tool: contribution.tool,
    startedAt: now,
    completedAt: now,
    ...(contribution.recipe === undefined ? {} : { recipe: contribution.recipe }),
    cwd: contribution.cwd,
    score: contribution.score,
    passed: contribution.passed,
    durationMs: 0,
    ...(contribution.payload === undefined ? {} : { payload: contribution.payload }),
  };
  new SessionRepo(datastore).save(row);
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let projectDir: string;
let datastore: DataStore;

beforeEach(() => {
  enterScope(makeGraphTestScope());
  projectDir = mkdtempSync(join(tmpdir(), 'graph-session-'));
  datastore = DataStoreFactory.open({ backend: 'memory' });
  currentAdapterRegistry().register(fakeAdapter(projectDir));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  currentAdapterRegistry().clear();
  datastore.close();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('D12 — one CLI invocation = one session', () => {
  it('default run contributes exactly one session', async () => {
    const outcome = await executeGraph({ cwd: projectDir, noCache: true }, mockCli(datastore));
    expect(outcome?.session).toBeDefined();
    expect(outcome?.session?.tool).toBe('graph');
  });

  it('single positional path contributes exactly one session', async () => {
    mkdirSync(join(projectDir, 'sub'));
    const outcome = await executeGraph(
      { cwd: projectDir, noCache: true, paths: [join(projectDir, 'sub')] },
      mockCli(datastore),
    );
    expect(outcome?.session).toBeDefined();
  });

  it('multiple positional paths contribute exactly one aggregate session', async () => {
    mkdirSync(join(projectDir, 'a'));
    mkdirSync(join(projectDir, 'b'));
    const outcome = await executeGraph(
      {
        cwd: projectDir,
        noCache: true,
        paths: [join(projectDir, 'a'), join(projectDir, 'b')],
      },
      mockCli(datastore),
    );
    // One aggregate contribution for the whole multi-path invocation.
    expect(outcome?.session).toBeDefined();
  });

  it('--workspace contributes exactly one aggregate session (not one per unit)', async () => {
    const pkgA = join(projectDir, 'packages', 'a');
    mkdirSync(pkgA, { recursive: true });
    writeFileSync(join(pkgA, 'tsconfig.json'), '{}');
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}');
    const fakeCliPath = join(projectDir, 'fake.cjs');
    writeFileSync(
      fakeCliPath,
      `process.stdout.write(JSON.stringify({version:'1.0',tool:'graph',timestamp:new Date().toISOString(),recipe:'graph',score:100,passed:true,summary:{total:0,passed:0,failed:0,errors:0,warnings:0},checks:[],durationMs:0}));process.exit(0);`,
    );
    const units: WorkspaceUnit[] = [
      { id: 'a', rootDir: pkgA, configPath: join(pkgA, 'tsconfig.json') },
    ];
    const outcome = await executeGraph(
      {
        cwd: projectDir,
        noCache: true,
        workspace: true,
        cliScript: fakeCliPath,
        concurrency: 1,
      },
      mockCli(datastore, workspaceLangRegistry(units)),
    );
    // One aggregate contribution, and NO deliverable envelope (audit P1-2).
    expect(outcome?.session).toBeDefined();
    expect(outcome?.envelope).toBeUndefined();
  });

  it('--json opts out of session contribution', async () => {
    const outcome = await executeGraph(
      { cwd: projectDir, noCache: true, json: true },
      mockCli(datastore),
    );
    expect(outcome?.session).toBeUndefined();
  });

  it('--gate-save opts out of session contribution', async () => {
    const outcome = await executeGraph(
      { cwd: projectDir, noCache: true, gateSave: true },
      mockCli(datastore),
    );
    expect(outcome?.session).toBeUndefined();
  });

  it('--report-to opts out of session contribution (even on failure)', async () => {
    const outcome = await executeGraph(
      { cwd: projectDir, noCache: true, reportTo: 'http://127.0.0.1:1' },
      mockCli(datastore),
    );
    expect(outcome?.session).toBeUndefined();
  });
});

describe('graph session payload — rule-grouped detail is persisted', () => {
  it('default run contributes a payload with summary + checks (not summary-only)', async () => {
    const outcome = await executeGraph({ cwd: projectDir, noCache: true }, mockCli(datastore));
    expect(outcome?.session).toBeDefined();

    // Persist the returned contribution exactly as the host run plane would,
    // then verify it round-trips through the StoredSession contract.
    hostPersist(datastore, outcome!.session!);

    const session = new SessionRepo(datastore).latest();
    expect(session).not.toBeNull();

    const payload = session?.payload as GraphSessionPayload | undefined;
    expect(payload).toBeDefined();

    // The native signal summary is carried verbatim from the run's SignalEnvelope.
    expect(payload?.summary).toEqual(
      expect.objectContaining({
        total: expect.any(Number),
        passed: expect.any(Number),
        failed: expect.any(Number),
        errors: expect.any(Number),
        warnings: expect.any(Number),
      }),
    );

    // The rule-grouped detail (`checks`) is what the Code Paths → Sessions
    // panel renders, and the reason the payload is no longer summary-only.
    // A regression to `{ summary }` (the pre-extension shape) drops this key —
    // session count stays 1, so only this assertion catches it.
    expect(payload).toHaveProperty('checks');
    expect(Array.isArray(payload?.checks)).toBe(true);
  });
});
