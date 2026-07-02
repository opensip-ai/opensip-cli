/**
 * E2E stdio (Task 6.3) — the proof that scope survives the SDK round-trip.
 *
 * Spawns the REAL built CLI (`node packages/cli/dist/index.js mcp`) and drives it
 * with the MCP SDK client over a `StdioClientTransport`. This is the gap the
 * review flagged: an SDK handler dispatches off an EventEmitter, so a tool call
 * proves the captured `RunScope` (datastore + ports) survives a real
 * SDK-dispatched handler — not just `initialize`.
 *
 * Requires `dist/` (the real CLI + mcp) — it FAILS LOUDLY if missing (no silent
 * skip). Fixture A pre-seeds a real catalog + a fit session; fixture B has no
 * catalog (to prove `refresh_graph` builds once the bundled graph adapter loads
 * under the mcp-owned run — i.e. the real `loadOwningToolCapabilities` path).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  applyToolContributeScope,
  resolveProjectPaths,
  RunScope,
  runWithScope,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { currentAdapterRegistry, graphTool } from '@opensip-cli/graph';
import { runGraph } from '@opensip-cli/graph/internal';
import { typescriptGraphAdapter } from '@opensip-cli/graph-typescript';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StoredSession } from '@opensip-cli/contracts';
import type { Catalog } from '@opensip-cli/graph';

const CLI_DIST = fileURLToPath(new URL('../../../../packages/cli/dist/index.js', import.meta.url));

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
const CONFIG_YML = [
  'globalExcludes:',
  "  - 'node_modules/**'",
  'targets:',
  '  ts-source:',
  "    description: 'TypeScript source'",
  '    languages: [typescript]',
  '    concerns: [backend]',
  '    include:',
  "      - '**/*.ts'",
  'fitness:',
  '  failOnErrors: 0',
  '  failOnWarnings: 0',
  '  disabledChecks: []',
  '',
].join('\n');
const SOURCE = [
  'export function main(): number { return helper(); }',
  'function helper(): number { return 1; }',
  'function unused(): number { return 7; }',
  '',
].join('\n');

const SAFE_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
);

/** Materialize a fixture project layout; returns the project root. */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
  mkdirSync(join(root, 'opensip-cli', '.runtime'), { recursive: true });
  writeFileSync(join(root, 'opensip-cli.config.yml'), CONFIG_YML, 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG, 'utf8');
  writeFileSync(join(root, 'index.ts'), SOURCE, 'utf8');
  return root;
}

/** Open the project datastore at its canonical path. */
function openProjectStore(root: string): DataStore {
  const path = `${resolveProjectPaths(root).runtimeDir}/datastore.sqlite`;
  return DataStoreFactory.open({ backend: 'sqlite', path });
}

interface Connected {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  stderr: string;
}

/** Spawn `opensip mcp --cwd root` and connect an MCP client over stdio. */
async function connect(root: string): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_DIST, 'mcp', '--cwd', root],
    env: SAFE_ENV,
    cwd: root,
    stderr: 'pipe',
  });
  const conn: Connected = {
    client: new Client({ name: 'e2e', version: '0.0.0' }),
    transport,
    stderr: '',
  };
  transport.stderr?.on('data', (chunk: Buffer) => {
    conn.stderr += chunk.toString('utf8');
  });
  await conn.client.connect(transport);
  return conn;
}

/** Call a tool and parse its single JSON text payload. */
async function call(
  conn: Connected,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await conn.client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  const first = content[0];
  return JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
}

let fixtureA: string;
let fixtureB: string;
let helperSymbolId: string;
let helperFile: string;
let helperLine: number;

/**
 * A seeded run keyed by the per-tool LAYOUT KEY — the value `get_latest_findings`
 * / `show_run` accept and that sessions are stored under. `validToolIds` is now
 * built from `identity.layoutKey ?? identity.name`, so `fit`/`sim`/`graph`/`yagni`
 * all resolve + replay. `graph` (layoutKey `'graph'`) is used here.
 */
function graphSession(root: string): StoredSession {
  return {
    id: 'graph-e2e-1',
    tool: 'graph',
    startedAt: '2026-05-21T12:00:00.000Z',
    completedAt: '2026-05-21T12:00:30.000Z',
    cwd: root,
    recipe: 'default',
    score: 90,
    passed: true,
    durationMs: 30_000,
    payload: {
      summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 },
      checks: [
        {
          checkSlug: 'graph:large-function',
          passed: false,
          violationCount: 1,
          durationMs: 5,
          findings: [
            {
              ruleId: 'graph:large-function',
              message: 'a seeded finding',
              severity: 'warning',
              filePath: 'index.ts',
              line: 1,
              violationCount: 1,
            },
          ],
        },
      ],
    },
  };
}

beforeAll(async () => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(
      `e2e requires the built CLI at ${CLI_DIST}. Run \`pnpm build\` before the MCP test suite.`,
    );
  }

  // Fixture A: seed a REAL catalog + a fit session into the project datastore.
  fixtureA = scaffold();
  const store = openProjectStore(fixtureA);
  const scope = new RunScope();
  applyToolContributeScope(scope, graphTool);
  const outcome = await runWithScope(scope, () => {
    currentAdapterRegistry().register(typescriptGraphAdapter);
    return runGraph({ cwd: fixtureA, datastore: store });
  });
  const catalog: Catalog | null = outcome.catalog;
  if (catalog === null) throw new Error('e2e seeding failed: runGraph produced no catalog');
  // Recover helper's symbolId from the seeded catalog.
  for (const occs of Object.values(catalog.functions)) {
    for (const occ of occs) {
      if (occ.simpleName === 'helper') {
        helperSymbolId = `${occ.filePath}:${String(occ.line)}:${String(occ.column)}`;
        helperFile = occ.filePath;
        helperLine = occ.line;
      }
    }
  }
  new SessionRepo(store).save(graphSession(fixtureA));
  store.close();
  if (!helperSymbolId) throw new Error('e2e seeding failed: helper symbol not found in catalog');

  // Fixture B: a project with NO catalog (refresh_graph must build it).
  fixtureB = scaffold();
}, 120_000);

afterAll(() => {
  if (fixtureA) rmSync(fixtureA, { recursive: true, force: true });
  if (fixtureB) rmSync(fixtureB, { recursive: true, force: true });
});

describe('MCP e2e over real stdio', () => {
  it('handshakes and lists all 15 tools', async () => {
    const conn = await connect(fixtureA);
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools).toHaveLength(15);
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toContain('get_symbol');
      expect(names).toContain('who_calls');
      expect(names).toContain('get_latest_findings');
      expect(names).toContain('review_change');
      expect(names).toContain('compare_to_baseline');
      expect(names).toContain('refresh_graph');
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('survives an SDK-dispatched who_calls / get_symbol (scope reaches the handler)', async () => {
    const conn = await connect(fixtureA);
    try {
      // who_calls: proves the captured RunScope (datastore + graph port) reached
      // an EventEmitter-dispatched handler — not just `initialize`.
      const who = await call(conn, 'who_calls', { symbolId: helperSymbolId, depth: 5 });
      const callers = who.data as { qualifiedName: string }[];
      expect(callers.some((c) => c.qualifiedName.includes('main'))).toBe(true);

      // get_symbol over file+line resolves to a stable symbolId.
      const sym = await call(conn, 'get_symbol', { file: helperFile, line: helperLine });
      const resolved = (sym.data ?? (sym.candidates as unknown[])?.[0]) as { symbolId: string };
      expect(resolved.symbolId).toBe(helperSymbolId);
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('serves the result-first path: get_latest_findings replays a seeded run (never re-runs)', async () => {
    const conn = await connect(fixtureA);
    try {
      const out = await call(conn, 'get_latest_findings', { tool: 'graph' });
      const findings = out.data as { ruleId: string; message: string }[];
      expect(findings.some((f) => f.ruleId === 'graph:large-function')).toBe(true);
      expect(out.session).toMatchObject({ tool: 'graph' });
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('reports freshness.fresh === false after a tracked file is mutated (stale catalog)', async () => {
    // Mutate a tracked source file → the persisted fingerprint no longer matches.
    writeFileSync(
      join(fixtureA, 'index.ts'),
      SOURCE + '\nexport function added(): number { return 2; }\n',
      'utf8',
    );
    const conn = await connect(fixtureA);
    try {
      const arch = await call(conn, 'get_architecture', {});
      expect((arch.freshness as { fresh: boolean }).fresh).toBe(false);
    } finally {
      await conn.client.close();
    }
    // Restore so the fixture is reusable / idempotent.
    writeFileSync(join(fixtureA, 'index.ts'), SOURCE, 'utf8');
  }, 60_000);

  it('refresh_graph builds a catalog on a project that has none (adapters load under the mcp run)', async () => {
    const conn = await connect(fixtureB);
    try {
      const refreshed = await call(conn, 'refresh_graph', {});
      expect(typeof refreshed.builtAt).toBe('string');
      expect(typeof refreshed.durationMs).toBe('number');
      // After the rebuild, the catalog is fresh and queryable.
      const search = await call(conn, 'search_symbols', { query: 'helper' });
      expect((search.data as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await conn.client.close();
    }
  }, 120_000);

  it('exits cleanly on stdin close and keeps stdout pure JSON-RPC (diagnostics on stderr)', async () => {
    const conn = await connect(fixtureA);
    // Every prior frame parsed by the SDK is itself proof stdout carried only
    // JSON-RPC (a stray stdout line would break the framed parse). Diagnostics
    // ride stderr — assert the structured start event landed there.
    await conn.client.listTools();
    await conn.client.close();
    // A graceful close resolves; the child process is torn down by the transport.
    expect(conn.stderr).toContain('mcp.server.start');
  }, 60_000);
});
