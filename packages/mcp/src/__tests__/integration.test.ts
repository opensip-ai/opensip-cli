/**
 * MCP integration (Task 6.2) — real adapter registrar + real catalog build +
 * real read ports, in-process.
 *
 * Exercises the genuine capability wiring a recent core fix enables: MCP's own
 * `registerMcpGraphAdapter` routes the bundled `graph-*` adapter into the
 * scope-owned adapter registry (`currentAdapterRegistry()`), so `runGraph`'s
 * `pickAdapter()` finds it under an mcp-owned run — BEFORE any `refresh_graph`.
 * Then it builds a real catalog over a tiny TS fixture and drives the SQLite
 * `GraphReadPort` end-to-end (search → get_symbol → who_calls → blast →
 * dead_code), and seeds sessions to drive the session-backed `ResultsReadPort`
 * (list → latest → show) over a real `DataStore`.
 *
 * The full host bootstrap (`loadOwningToolCapabilities` driving the
 * `mcp-graph-adapter` domain from the manifest) is proven against the REAL built
 * CLI in e2e-stdio.test.ts; this suite proves the registrar + ports in-process
 * without coupling the package to the composition root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyToolContributeScope,
  RunScope,
  runWithScope,
  runWithScopeSync,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { currentAdapterRegistry, graphTool } from '@opensip-cli/graph';
import { runGraph } from '@opensip-cli/graph/internal';
import { typescriptGraphAdapter } from '@opensip-cli/graph-typescript';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workingTreeContextFromCatalog } from '../freshness.js';
import { registerMcpGraphAdapter } from '../register-mcp-graph-adapters.js';
import { SessionResultsReadPort } from '../session-results-read-port.js';
import { SqliteGraphReadPort } from '../sqlite-graph-read-port.js';

import type { GraphReadPort } from '../graph-read-port.js';
import type { CommandResult, StoredSession, ToolSessionReplay } from '@opensip-cli/contracts';
import type { Catalog } from '@opensip-cli/graph';
import type { SessionReplayFn } from '@opensip-cli/session-store';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    strict: true,
    rootDir: '.',
  },
  include: ['**/*.ts'],
});

const SOURCE = [
  'export function main(): number { return helper(); }',
  'function helper(): number { return 1; }',
  'function unused(): number { return 7; }',
  '',
].join('\n');

let dir: string;
let store: DataStore;
let scope: RunScope;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-int-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');
  writeFileSync(join(dir, 'index.ts'), SOURCE, 'utf8');
  store = DataStoreFactory.open({ backend: 'memory' });
  scope = new RunScope();
  applyToolContributeScope(scope, graphTool);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

/** Build the graph read port whose rebuild runs the real engine under the scope. */
function buildGraphPort(): GraphReadPort {
  const rebuild = async (): Promise<Catalog> => {
    const outcome = await runWithScope(scope, () => runGraph({ cwd: dir, datastore: store }));
    if (outcome.catalog === null) throw new Error('graph build produced no catalog');
    return outcome.catalog;
  };
  return new SqliteGraphReadPort({
    store,
    freshnessContext: workingTreeContextFromCatalog,
    rebuild,
  });
}

describe('MCP integration — adapter load + real catalog', () => {
  it('routes the bundled graph adapter into the scope registry BEFORE a build', () => {
    runWithScopeSync(scope, () => {
      expect(currentAdapterRegistry().size).toBe(0);
      registerMcpGraphAdapter(typescriptGraphAdapter);
      expect(currentAdapterRegistry().size).toBeGreaterThan(0);
      expect(currentAdapterRegistry().getById('typescript')).toBeDefined();
    });
  });

  it('refresh_graph builds a real catalog, then the port answers structural queries', async () => {
    runWithScopeSync(scope, () => registerMcpGraphAdapter(typescriptGraphAdapter));
    const graph = buildGraphPort();

    // refresh_graph: a project without a loaded catalog → build it.
    const refreshed = await graph.refresh();
    expect(refreshed.ok).toBe(true);

    // search → get_symbol
    const search = graph.searchSymbols('helper');
    expect(search.ok).toBe(true);
    const helperRef = search.ok
      ? search.value.data.find((r) => r.qualifiedName.includes('helper'))
      : undefined;
    expect(helperRef).toBeDefined();

    const span = graph.findBySpan(helperRef!.filePath, helperRef!.line);
    expect(span.ok && span.value.data.some((r) => r.bodyHash === helperRef!.bodyHash)).toBe(true);

    // who_calls (reverse adjacency): main calls helper.
    const callers = graph.callerGraph();
    expect(callers.ok).toBe(true);
    if (callers.ok) {
      const callerHashes = callers.value.data.edges.get(helperRef!.bodyHash) ?? [];
      const callerNames = callerHashes
        .map((h) => callers.value.data.resolve(h)?.qualifiedName ?? '')
        .join(',');
      expect(callerNames).toContain('main');
    }

    // blast: helper has at least one direct caller.
    const blast = graph.blast(helperRef!.symbolId);
    expect(blast.ok).toBe(true);
    expect(blast.ok && (blast.value.data?.direct ?? 0)).toBeGreaterThanOrEqual(1);

    // dead_code: `unused` is unreachable.
    const dead = graph.deadCode();
    expect(dead.ok).toBe(true);
    const deadNames = dead.ok ? dead.value.data.map((d) => d.symbol.qualifiedName) : [];
    expect(deadNames.some((n) => n.includes('unused'))).toBe(true);
  });
});

// ── session-backed ResultsReadPort over a real DataStore ─────────────

function makeSession(over: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'fit-int-1',
    tool: 'fit',
    startedAt: '2026-05-21T12:00:00.000Z',
    completedAt: '2026-05-21T12:00:30.000Z',
    cwd: dir,
    recipe: 'default',
    score: 88,
    passed: true,
    durationMs: 30_000,
    payload: { summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 } },
    ...over,
  };
}

const buildStubReplay: SessionReplayFn = (stored): ToolSessionReplay<CommandResult> => ({
  result: {} as CommandResult,
  envelope: {
    schemaVersion: 2,
    tool: stored.tool,
    runId: 'r',
    createdAt: stored.startedAt,
    verdict: {
      score: stored.score,
      passed: stored.passed,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
    baselineIdentity: { fingerprintStrategyId: 'x', fingerprintStrategyVersion: 1 },
  },
  fidelity: 'projection',
});

const stubResolver: (tool: string) => SessionReplayFn | undefined = () => buildStubReplay;

describe('MCP integration — session replay over a real DataStore', () => {
  it('lists, replays latest, and shows a seeded run (replay only, never re-run)', async () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-int-1' }));
    new SessionRepo(store).save(
      makeSession({
        id: 'fit-int-2',
        startedAt: '2026-05-22T00:00:00.000Z',
        completedAt: '2026-05-22T00:00:30.000Z',
      }),
    );
    const results = new SessionResultsReadPort({ store, replayFor: stubResolver });

    const list = results.listRuns();
    expect(list.ok && list.value.map((r) => r.id)).toEqual(['fit-int-2', 'fit-int-1']);

    const latest = await results.latestFindings({ tool: 'fit' });
    expect(latest.ok).toBe(true);
    expect(latest.ok && latest.value.session?.id).toBe('fit-int-2');

    const shown = await results.showRun({ ref: 'fit-int-1' });
    expect(shown.ok && shown.value.session?.id).toBe('fit-int-1');
    expect(shown.ok && shown.value.data.fidelity).toBe('projection');
  });
});
