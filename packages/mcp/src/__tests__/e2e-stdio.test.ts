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

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildProjectInventorySnapshotIdentities,
  projectInventorySnapshotSchema,
} from '@opensip-cli/contracts';
import {
  applyToolContributeScope,
  resolveProjectPaths,
  RunScope,
  runWithScope,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { currentAdapterRegistry, graphTool } from '@opensip-cli/graph';
import { CatalogRepo, runGraph } from '@opensip-cli/graph/internal';
import { typescriptGraphAdapter } from '@opensip-cli/graph-typescript';
import { RunRepo, SessionRepo } from '@opensip-cli/session-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE_PROJECT_SOURCE, highFanInProjectSource } from './fixtures/high-fan-in-project.js';
import { PACKAGE_EVIDENCE_FILES } from './fixtures/package-evidence-project.js';

import type {
  StoredSession,
  TaskContextManifest,
  TaskContextSnapshotPointer,
} from '@opensip-cli/contracts';
import type { Catalog } from '@opensip-cli/graph';

const CLI_DIST = fileURLToPath(new URL('../../../../packages/cli/dist/index.js', import.meta.url));

interface SymbolSearchPayload {
  readonly detail: 'summary' | 'groups' | 'nodes';
  readonly symbols: readonly {
    symbolId: string;
    simpleName?: string;
    bodyHash?: string;
    package?: string;
    qualifiedName?: string;
  }[];
  readonly totalMatches: number;
}

function searchPayload(data: unknown): SymbolSearchPayload {
  return data as SymbolSearchPayload;
}

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
  'graph:',
  '  failOnErrors: 0',
  '  failOnWarnings: 0',
  '',
].join('\n');
const SOURCE = BASE_PROJECT_SOURCE;
const OVERSIZED_SESSION_ID = 'graph-e2e-oversized';

// A config with NON-EMPTY target conventions, so both transports emit an equal
// bounded `projectContext.targetConventions` for the same fixture (Plan 03,
// Task 2.2). Kept in a dedicated fixture so its conventions never perturb the
// graph/dead-code assertions of the shared fixtures.
const CATALOG_CONFIG_YML = [
  'globalExcludes:',
  "  - 'node_modules/**'",
  'targets:',
  '  app-src:',
  "    description: 'App source'",
  '    languages: [typescript]',
  '    concerns: [backend]',
  '    include:',
  "      - 'src/**/*.ts'",
  '    conventions:',
  '      entrypoints:',
  "        - 'src/routes/**'",
  "        - 'src/actions/**'",
  '      alwaysUsed:',
  "        - 'src/config/runtime.ts'",
  '      usedExports:',
  "        - file: 'src/routes/page.ts'",
  '          names:',
  '            - loader',
  '            - action',
  'fitness:',
  '  failOnErrors: 0',
  '  failOnWarnings: 0',
  '  disabledChecks: []',
  'graph:',
  '  failOnErrors: 0',
  '  failOnWarnings: 0',
  '',
].join('\n');

const SAFE_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
);

async function runBuiltCli(root: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, ...args], {
      cwd: root,
      env: SAFE_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `built CLI exited ${String(code)}: stdout=${stdout.slice(0, 2000)} stderr=${stderr.slice(0, 2000)}`,
          ),
        );
      }
    });
  });
}

/** Spawn the built CLI and return its captured stdout (fails loudly on nonzero exit). */
async function runBuiltCliCapture(root: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, ...args], {
      cwd: root,
      env: SAFE_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`built CLI exited ${String(code)}: stderr=${stderr.slice(0, 2000)}`));
    });
  });
}

/** Materialize a catalog-parity fixture with non-empty target conventions. */
function scaffoldCatalogFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-e2e-catalog-'));
  mkdirSync(join(root, 'opensip-cli', '.runtime'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@fixture/catalog', private: true }),
    'utf8',
  );
  writeFileSync(join(root, 'opensip-cli.config.yml'), CATALOG_CONFIG_YML, 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG, 'utf8');
  return root;
}

/** Materialize a fixture project layout; returns the project root. */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
  mkdirSync(join(root, 'opensip-cli', '.runtime'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@fixture/root',
      private: true,
      workspaces: ['packages/*'],
    }),
    'utf8',
  );
  writeFileSync(join(root, 'opensip-cli.config.yml'), CONFIG_YML, 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG, 'utf8');
  writeFileSync(join(root, 'index.ts'), SOURCE, 'utf8');
  for (const file of PACKAGE_EVIDENCE_FILES) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, 'utf8');
  }
  return root;
}

function scaffoldIsolated(
  files: readonly { readonly path: string; readonly content: string }[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-e2e-isolated-'));
  mkdirSync(join(root, 'opensip-cli', '.runtime'), { recursive: true });
  writeFileSync(join(root, 'opensip-cli.config.yml'), CONFIG_YML, 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG, 'utf8');
  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, 'utf8');
  }
  return root;
}

/** Open the project datastore at its canonical path. */
function openProjectStore(root: string): DataStore {
  return DataStoreFactory.open({
    backend: 'sqlite',
    path: projectDatabasePath(root),
  });
}

function projectDatabasePath(root: string): string {
  return `${resolveProjectPaths(root).runtimeDir}/datastore.sqlite`;
}

function withRawProjectDatabase<T>(root: string, use: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(projectDatabasePath(root));
  try {
    return use(database);
  } finally {
    database.close();
  }
}

/**
 * Model retention eviction while leaving a newer valid snapshot of the same
 * kind behind. The MCP assertion can then prove an exact pointer is not
 * rebound to that newer row.
 */
function evictContextSnapshotAndSeedNewer(
  root: string,
  pointer: TaskContextSnapshotPointer,
): string {
  return withRawProjectDatabase(root, (database) => {
    const row = database
      .prepare(
        'SELECT kind, schema_version, producer_version, source_identity, config_identity, payload ' +
          'FROM graph_context_snapshot WHERE id = ?',
      )
      .get(pointer.id) as
      | {
          kind?: unknown;
          schema_version?: unknown;
          producer_version?: unknown;
          source_identity?: unknown;
          config_identity?: unknown;
          payload?: unknown;
        }
      | undefined;
    if (
      typeof row?.kind !== 'string' ||
      typeof row.schema_version !== 'number' ||
      typeof row.producer_version !== 'string' ||
      typeof row.source_identity !== 'string' ||
      typeof row.config_identity !== 'string' ||
      typeof row.payload !== 'string'
    ) {
      throw new TypeError('task-context snapshot row is missing or malformed');
    }
    if (row.kind !== 'inventory' || row.schema_version !== 1) {
      throw new TypeError('expected an inventory context snapshot');
    }
    const previous = projectInventorySnapshotSchema.parse(JSON.parse(row.payload));
    const firstFile = previous.files[0];
    if (firstFile === undefined) {
      throw new TypeError('inventory snapshot fixture has no file facts');
    }
    const content = {
      schemaVersion: previous.schemaVersion,
      project: previous.project,
      packages: previous.packages,
      files: previous.files.map((file, index) =>
        index === 0 ? { ...file, modifiedMs: file.modifiedMs + 1 } : file,
      ),
      coverage: previous.coverage,
    };
    const identities = buildProjectInventorySnapshotIdentities(content);
    const payload = { ...content, ...identities };
    const newerId = payload.snapshotId;
    const encoded = JSON.stringify(payload);
    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          `INSERT INTO graph_context_snapshot
            (id, kind, schema_version, producer_version, created_at, source_identity,
             config_identity, byte_count, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newerId,
          row.kind,
          row.schema_version,
          row.producer_version,
          '2099-01-01T00:00:00.000Z',
          payload.metadataIdentity,
          row.config_identity,
          Buffer.byteLength(encoded, 'utf8'),
          encoded,
        );
      database.prepare('DELETE FROM graph_context_snapshot WHERE id = ?').run(pointer.id);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return newerId;
  });
}

function countLogEvent(stderr: string, event: string): number {
  return stderr.split(event).length - 1;
}

function concurrentRefreshSource(epoch: 'old' | 'new', count = 500): string {
  const marker = `${epoch}Epoch`;
  return [
    `export function ${marker}(): number { return 1; }`,
    ...Array.from(
      { length: count },
      (_, index) =>
        `export function ${epoch}Caller${String(index)}(): number { return ${marker}(); }`,
    ),
    '',
  ].join('\n');
}

interface Connected {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  stderr: string;
}

/** Spawn `opensip mcp --cwd root` and connect an MCP client over stdio. */
async function connect(
  root: string,
  opts: { readonly allowMutations?: boolean } = {},
): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      CLI_DIST,
      'mcp',
      '--cwd',
      root,
      ...(opts.allowMutations === true ? ['--allow-mutations'] : []),
    ],
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

async function expectValidationError(
  conn: Connected,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const result = await conn.client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  const content = result.content as { type: string; text?: string }[];
  expect(content[0]?.text).toMatch(/input validation.*unrecognized/is);
  expect(content[0]?.text).toContain('unexpected');
}

let fixtureA: string;
let fixtureB: string;
let lifecycleFixture: string;
let contextFixture: string;
let catalogFixture: string;
let contextRunId: string;
let contextManifest: TaskContextManifest;
let entrySymbolId: string;
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
    suiteRunId: 'suite-e2e-1',
    suiteName: 'audit',
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

function oversizedGraphSession(root: string): StoredSession {
  const count = 8500;
  return {
    ...graphSession(root),
    id: OVERSIZED_SESSION_ID,
    startedAt: '2026-05-20T12:00:00.000Z',
    completedAt: '2026-05-20T12:00:30.000Z',
    suiteRunId: 'suite-oversized',
    suiteName: 'oversized',
    payload: {
      summary: {
        total: count,
        passed: 0,
        failed: count,
        errors: 0,
        warnings: count,
      },
      checks: [
        {
          checkSlug: 'graph:large-function',
          passed: false,
          violationCount: count,
          durationMs: 5,
          findings: Array.from({ length: count }, (_, index) => ({
            ruleId: 'graph:large-function',
            message: 'x'.repeat(512),
            severity: 'warning',
            filePath: `oversized-${String(index)}.ts`,
            line: 1,
            violationCount: 1,
          })),
        },
      ],
    },
  };
}

function withTraversalEvidenceFixture(catalog: Catalog): Catalog {
  return {
    ...catalog,
    functions: Object.fromEntries(
      Object.entries(catalog.functions).map(([name, occurrences]) => [
        name,
        occurrences.map((occurrence) => {
          if (occurrence.simpleName === 'main') {
            return {
              ...occurrence,
              calls: occurrence.calls.map((edge) => ({
                ...edge,
                resolution: 'semantic' as const,
                confidence: 'high' as const,
                crossShard: true,
              })),
            };
          }
          if (occurrence.simpleName === 'entry') {
            return {
              ...occurrence,
              calls: occurrence.calls.map((edge) => ({
                ...edge,
                confidence: 'medium' as const,
              })),
            };
          }
          return occurrence;
        }),
      ]),
    ),
  };
}

function expectUnavailableStoredReview(
  review: Record<string, unknown>,
  suiteRunId = 'suite-e2e-1',
): void {
  expect(review.data).toMatchObject({
    reviewBrief: { version: 1 },
    source: { suiteRunId, sessionIds: ['graph-e2e-1'] },
    freshness: {
      graph: {
        fresh: false,
        verification: 'partial',
        reasonCode: 'verification-unavailable',
        reason: 'Graph status unavailable',
      },
    },
  });
  const serialized = JSON.stringify(review);
  expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(64 * 1024);
  expect(serialized).not.toMatch(/GRAPH\.READ|catalog-(?:identity|generation|sync)-failed/i);
}

function expectScrubbedDiagnostics(conn: Connected, root: string): void {
  expect(conn.stderr).not.toContain(root);
  expect(conn.stderr).not.toMatch(/\s+at\s+.*:\d+/u);
  expect(Buffer.byteLength(conn.stderr, 'utf8')).toBeLessThan(64 * 1024);
}

async function seedLifecycleFixture(root: string): Promise<void> {
  const store = openProjectStore(root);
  try {
    const scope = new RunScope();
    applyToolContributeScope(scope, graphTool);
    const outcome = await runWithScope(scope, () => {
      currentAdapterRegistry().register(typescriptGraphAdapter);
      return runGraph({ cwd: root, datastore: store });
    });
    if (outcome.catalog === null) {
      throw new Error('lifecycle e2e seeding failed: runGraph produced no catalog');
    }
    new SessionRepo(store).save(graphSession(root));
  } finally {
    store.close();
  }
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
  const builtCatalog: Catalog | null = outcome.catalog;
  if (builtCatalog === null) throw new Error('e2e seeding failed: runGraph produced no catalog');
  // Keep the stdio projection proof deterministic: the catalog still comes
  // from the real adapter, with two edge labels varied to exercise transport.
  const catalog = withTraversalEvidenceFixture(builtCatalog);
  new CatalogRepo(store).replaceAll(catalog);
  // Recover helper's symbolId from the seeded catalog.
  for (const occs of Object.values(catalog.functions)) {
    for (const occ of occs) {
      if (occ.simpleName === 'helper') {
        helperSymbolId = `${occ.filePath}:${String(occ.line)}:${String(occ.column)}`;
        helperFile = occ.filePath;
        helperLine = occ.line;
      }
      if (occ.simpleName === 'entry') {
        entrySymbolId = `${occ.filePath}:${String(occ.line)}:${String(occ.column)}`;
      }
    }
  }
  const sessions = new SessionRepo(store);
  sessions.save(oversizedGraphSession(fixtureA));
  sessions.save(graphSession(fixtureA));
  store.close();
  if (!helperSymbolId) throw new Error('e2e seeding failed: helper symbol not found in catalog');
  if (!entrySymbolId) throw new Error('e2e seeding failed: entry symbol not found in catalog');

  // Fixture B: a project with NO catalog (refresh_graph must build it).
  fixtureB = scaffold();

  // Catalog-parity fixture: a project whose config declares non-empty target
  // conventions, so `agent-catalog --json` and `get_agent_catalog` can be proven
  // byte-identical over the common body (Plan 03, Task 2.2).
  catalogFixture = scaffoldCatalogFixture();

  // Dedicated fixture for destructive/transient catalog lifecycle faults.
  lifecycleFixture = scaffold();
  await seedLifecycleFixture(lifecycleFixture);

  // Dedicated fixture produced through the real hidden graph commands and
  // host-owned agent-context ledger. Later tests can destructively replace
  // its graph/snapshot evidence without coupling to fixture A.
  contextFixture = scaffold();
  await runBuiltCli(contextFixture, [
    'suite',
    'run',
    'agent-context',
    '--cwd',
    contextFixture,
    '--files',
    'packages/b/src/index.ts',
    '--json',
  ]);
  const contextStore = openProjectStore(contextFixture);
  try {
    const contextRun = new RunRepo(contextStore).listRuns({
      cwd: realpathSync(contextFixture),
      name: 'agent-context',
      limit: 1,
    })[0];
    if (contextRun?.contextManifest === undefined) {
      throw new Error('task-context e2e seeding failed: parent Run manifest not found');
    }
    contextRunId = contextRun.id;
    contextManifest = contextRun.contextManifest;
  } finally {
    contextStore.close();
  }
}, 120_000);

afterAll(() => {
  if (fixtureA) rmSync(fixtureA, { recursive: true, force: true });
  if (fixtureB) rmSync(fixtureB, { recursive: true, force: true });
  if (lifecycleFixture) rmSync(lifecycleFixture, { recursive: true, force: true });
  if (contextFixture) rmSync(contextFixture, { recursive: true, force: true });
  if (catalogFixture) rmSync(catalogFixture, { recursive: true, force: true });
});

describe('MCP e2e over real stdio', () => {
  it('handshakes and lists the complete default tool surface', async () => {
    const conn = await connect(fixtureA);
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools).toHaveLength(25);
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'blast_radius',
          'callees_of',
          'compare_to_baseline',
          'find_dead_code',
          'get_agent_catalog',
          'get_architecture',
          'get_context_status',
          'get_file_context',
          'get_latest_findings',
          'get_runtime_wiring',
          'get_symbol',
          'list_runs',
          'impact_files',
          'package_cycles',
          'package_dependencies',
          'references_to',
          'refresh_graph',
          'review_change',
          'search_declarations',
          'search_symbols',
          'select_tests',
          'show_run',
          'trace_path',
          'who_calls',
          'why_depends',
        ].sort(),
      );
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('serves an agent catalog whose common body equals `agent-catalog --json` (Plan 03 parity)', async () => {
    // The CLI transport: run the built `agent-catalog --json` with cwd = fixture
    // (agent-catalog is scope:'none', so it has no --cwd flag; the subprocess cwd
    // supplies the project so scope.targets — hence conventions — resolve).
    const cliRaw = await runBuiltCliCapture(catalogFixture, ['agent-catalog', '--json']);
    const cliCatalog = (JSON.parse(cliRaw) as { data: { catalog: Record<string, unknown> } }).data
      .catalog;

    const conn = await connect(catalogFixture);
    try {
      const toolList = await conn.client.listTools();
      const listed = toolList.tools.map((tool) => tool.name).sort();
      const response = await call(conn, 'get_agent_catalog', {});

      // Split off ONLY the named top-level `mcp` overlay — no wildcard omission.
      const { mcp, ...common } = response;

      // Full-object parity: the common body is byte-for-byte the CLI catalog
      // (reserved roots/suites, bounded target counts, entry points, notes,
      // hostSupport). A divergence in ANY common field fails here.
      expect(common).toEqual(cliCatalog);

      // Bounded, non-empty target conventions rode through both transports.
      expect((common.projectContext as { targetConventions: unknown[] }).targetConventions).toEqual(
        [{ target: 'app-src', entrypointCount: 2, alwaysUsedCount: 1, usedExportCount: 2 }],
      );
      // Reserved facts present + identical on both sides.
      expect(common.reservedNames as { suiteNames: string[]; rootCommands: string[] }).toEqual(
        cliCatalog.reservedNames,
      );
      expect((common.reservedNames as { suiteNames: string[] }).suiteNames).toEqual([
        'audit',
        'agent-context',
      ]);
      // The honest Plan 02 hostSupport is present and identical across transports.
      expect(common.hostSupport).toEqual(cliCatalog.hostSupport);
      expect(common.hostSupport).not.toBeUndefined();

      // The additive `mcp` overlay matches initialize/listTools/epoch/posture/root.
      const overlay = mcp as {
        version: string;
        surfaceEpoch: number;
        toolNames: string[];
        toolCount: number;
        mutationPosture: string;
        project: { root: string; scope: string };
      };
      expect(overlay.surfaceEpoch).toBe(7);
      expect(overlay.mutationPosture).toBe('read-only');
      expect(overlay.project).toEqual({ root: realpathSync(catalogFixture), scope: 'project' });
      expect([...overlay.toolNames].sort()).toEqual(listed);
      expect(overlay.toolCount).toBe(listed.length);
      expect(overlay.version).toBe(conn.client.getServerVersion()?.version);

      // No absolute fixture path leaks into the common catalog body.
      const commonSerialized = JSON.stringify(common);
      expect(commonSerialized).not.toContain(catalogFixture);
      expect(commonSerialized).not.toContain(realpathSync(catalogFixture));
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('rejects unknown arguments for every default tool at the real SDK boundary', async () => {
    const conn = await connect(fixtureA);
    try {
      const calls: readonly [string, Record<string, unknown>][] = [
        ['blast_radius', { symbolId: 'src/a.ts:1:0' }],
        ['callees_of', { symbolId: 'src/a.ts:1:0' }],
        ['compare_to_baseline', { tool: 'fit' }],
        ['find_dead_code', {}],
        ['get_agent_catalog', {}],
        ['get_architecture', {}],
        ['get_context_status', {}],
        ['get_file_context', { file: 'src/a.ts' }],
        ['get_latest_findings', { tool: 'fit' }],
        ['get_runtime_wiring', {}],
        ['get_symbol', { file: 'src/a.ts', line: 1 }],
        ['list_runs', {}],
        ['impact_files', { files: ['src/a.ts'] }],
        ['package_cycles', {}],
        ['package_dependencies', {}],
        ['references_to', { declarationId: 'd1|fixture' }],
        ['refresh_graph', {}],
        ['review_change', {}],
        ['search_declarations', { query: 'a' }],
        ['search_symbols', { query: 'a' }],
        ['select_tests', { files: ['src/a.ts'] }],
        ['show_run', { ref: 'latest', tool: 'fit' }],
        ['trace_path', { fromSymbolId: 'src/a.ts:1:0', toSymbolId: 'src/b.ts:1:0' }],
        ['who_calls', { symbolId: 'src/a.ts:1:0' }],
        ['why_depends', { fromPackage: 'a', toPackage: 'b' }],
      ];
      for (const [name, args] of calls) {
        await expectValidationError(conn, name, { ...args, unexpected: true });
      }
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('rejects hostile enum, path, array, and limit inputs at the real SDK boundary', async () => {
    const conn = await connect(fixtureA);
    try {
      const hostileCalls: readonly [string, Record<string, unknown>, RegExp][] = [
        ['search_symbols', { query: 'helper', match: 'regex' }, /match|enum|option/i],
        ['search_symbols', { query: 'helper', filePath: '../private.ts' }, /filePath|traversal/i],
        [
          'search_symbols',
          { query: 'helper', filePrefix: '\\\\server\\share\\private.ts' },
          /filePrefix|traversal/i,
        ],
        [
          'search_symbols',
          {
            query: 'helper',
            packages: Array.from({ length: 51 }, (_, index) => `@fixture/pkg-${String(index)}`),
          },
          /packages|array|50/i,
        ],
        ['search_symbols', { query: 'helper', limit: 501 }, /limit|500|number/i],
        [
          'get_context_status',
          {
            files: Array.from({ length: 129 }, (_, index) => `src/${String(index)}.ts`),
          },
          /files|array|128/i,
        ],
        ['impact_files', { files: ['src\\a.ts', 'src/a.ts'] }, /files|unique|normalization/i],
        ['impact_files', { files: ['src/a.ts'], depth: 6 }, /depth|5|number/i],
        ['impact_files', { files: ['src/a.ts'], top: 501 }, /top|500|number/i],
        ['get_symbol', { file: 'src/a.ts', line: 1, detail: 'nodes' }, /detail|enum|option/i],
        ['select_tests', { files: ['src/a.ts'], tier: 'repository' }, /tier|enum|option/i],
        ['select_tests', { files: ['src/a.ts'], proofDetail: 'full' }, /proofDetail|enum|option/i],
        ['select_tests', { files: ['src/a.ts'], limit: 501 }, /limit|500|number/i],
        ['select_tests', { files: ['src/a.ts'], commandLimit: 101 }, /commandLimit|100|number/i],
        ['select_tests', { files: ['src/a.ts'], proofLimit: 7 }, /proofLimit|6|number/i],
      ];

      for (const [name, args, expected] of hostileCalls) {
        const result = await conn.client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        const serialized = JSON.stringify(result.content);
        expect(serialized).toMatch(/input validation/i);
        expect(serialized).toMatch(expected);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(4 * 1024 * 1024);
      }
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('lists repair_apply_verify only when mutation mode is enabled', async () => {
    const conn = await connect(fixtureA, { allowMutations: true });
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools).toHaveLength(26);
      const names = tools.tools.map((tool) => tool.name);
      expect(new Set(names)).toEqual(
        new Set([
          'blast_radius',
          'callees_of',
          'compare_to_baseline',
          'find_dead_code',
          'get_agent_catalog',
          'get_architecture',
          'get_context_status',
          'get_file_context',
          'get_latest_findings',
          'get_runtime_wiring',
          'get_symbol',
          'list_runs',
          'impact_files',
          'package_cycles',
          'package_dependencies',
          'references_to',
          'refresh_graph',
          'repair_apply_verify',
          'review_change',
          'search_declarations',
          'search_symbols',
          'select_tests',
          'show_run',
          'trace_path',
          'who_calls',
          'why_depends',
        ]),
      );
      await expectValidationError(conn, 'repair_apply_verify', {
        ref: 'latest',
        tool: 'fit',
        signal: 'index:0',
        action: 'fixture',
        unexpected: true,
      });
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('survives an SDK-dispatched who_calls / get_symbol (scope reaches the handler)', async () => {
    const conn = await connect(fixtureA);
    try {
      // who_calls: proves the captured RunScope (datastore + graph port) reached
      // an EventEmitter-dispatched handler — not just `initialize`.
      const who = await call(conn, 'who_calls', {
        symbolId: helperSymbolId,
        depth: 5,
      });
      const traversal = who.data as
        | { symbol: { qualifiedName: string } }[]
        | { nodes?: { symbol: { qualifiedName: string } }[] };
      const callers = Array.isArray(traversal) ? traversal : (traversal.nodes ?? []);
      expect(callers.some((caller) => caller.symbol.qualifiedName.includes('main'))).toBe(true);

      // get_symbol over file+line resolves to a stable symbolId.
      const sym = await call(conn, 'get_symbol', {
        file: helperFile,
        line: helperLine,
      });
      const resolved = (sym.data ?? (sym.candidates as unknown[])?.[0]) as {
        symbolId: string;
      };
      expect(resolved.symbolId).toBe(helperSymbolId);
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('serves positive bounded task context through the captured stdio ports', async () => {
    const conn = await connect(contextFixture);
    try {
      const agentCatalog = await call(conn, 'get_agent_catalog', {});
      expect(agentCatalog).toMatchObject({
        mcp: {
          project: { root: realpathSync(contextFixture), scope: 'project' },
          surfaceEpoch: 7,
          mutationPosture: 'read-only',
          toolNames: expect.arrayContaining([
            'get_context_status',
            'get_file_context',
            'impact_files',
            'select_tests',
          ]),
        },
      });
      const graphPointer = contextManifest.planes.find((plane) => plane.kind === 'graph')?.pointer;
      const inventoryPointer = contextManifest.planes.find(
        (plane) => plane.kind === 'inventory',
      )?.pointer;
      if (graphPointer === undefined || inventoryPointer === undefined) {
        throw new Error('task-context fixture is missing graph or inventory pointers');
      }

      const file = await call(conn, 'get_file_context', {
        file: 'packages/b/src/index.ts',
      });
      expect(file).toMatchObject({
        status: 'found',
        file: {
          path: 'packages/b/src/index.ts',
          roles: expect.arrayContaining(['production']),
          packageName: '@fixture/b',
        },
        package: { name: '@fixture/b', root: 'packages/b' },
        inventoryIdentity: inventoryPointer.id,
        freshness: { fresh: true, verification: 'complete' },
      });
      expect(JSON.stringify(file)).not.toContain('export function fromB');

      const impact = await call(conn, 'impact_files', {
        files: ['packages/b/src/index.ts'],
        depth: 3,
        top: 50,
      });
      const impactData = impact.data as {
        changedFunctions: { qualifiedName: string }[];
        impactedFunctions: { qualifiedName: string }[];
        matchedFiles: string[];
        requestedFiles: string[];
        trust: { fullyVerified: boolean };
      };
      expect(impactData.requestedFiles).toEqual(['packages/b/src/index.ts']);
      expect(impactData.matchedFiles).toEqual(['packages/b/src/index.ts']);
      expect(
        impactData.changedFunctions.some((item) => item.qualifiedName.endsWith('.fromB')),
      ).toBe(true);
      expect(
        impactData.changedFunctions.some((item) => item.qualifiedName.endsWith('.cycleB')),
      ).toBe(true);
      expect(
        impactData.impactedFunctions.some((item) => item.qualifiedName.endsWith('.target')),
      ).toBe(true);
      expect(impactData.trust.fullyVerified).toBe(true);
      expect((impact.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        graphPointer.id,
      );

      const selection = await call(conn, 'select_tests', {
        files: ['packages/b/src/index.ts'],
        tier: 'focused',
        depth: 3,
        proofDetail: 'paths',
        limit: 50,
        commandLimit: 10,
        proofLimit: 4,
      });
      const selectionData = selection.data as {
        files: string[];
        tests: {
          path: string;
          basis: string;
          observed: boolean;
          proof: string[];
        }[];
        graphIdentity: string;
        inventoryIdentity: string;
      };
      expect(selectionData.files).toEqual(['packages/b/src/index.ts']);
      expect(selectionData.tests).toContainEqual(
        expect.objectContaining({
          path: 'packages/b/src/twin.test.ts',
          observed: false,
          proof: expect.any(Array),
        }),
      );
      expect(selectionData.graphIdentity).toBe(graphPointer.id);
      expect(selectionData.inventoryIdentity).toBe(inventoryPointer.id);
      expect((selection.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        graphPointer.id,
      );

      const entity = await call(conn, 'get_symbol', {
        file: 'index.ts',
        line: 2,
        detail: 'entity',
      });
      expect(entity.data).toMatchObject({
        symbol: {
          simpleName: 'helper',
          filePath: 'index.ts',
          line: 2,
        },
        endLine: 2,
        parameters: [],
        returnType: 'number',
        decorators: [],
      });
      expect(entity.data).not.toHaveProperty('source');
      expect((entity.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        graphPointer.id,
      );

      const status = await call(conn, 'get_context_status', {
        runId: contextRunId,
        files: ['packages/b/src/index.ts'],
      });
      expect(status).toMatchObject({
        status: 'available',
        run: {
          id: contextRunId,
          name: 'agent-context',
          source: 'built-in-suite',
        },
        manifest: {
          runId: contextRunId,
          graphIdentity: graphPointer.id,
          inventoryIdentity: inventoryPointer.id,
          fileScope: {
            mode: 'explicit',
            fileCount: 1,
            filesIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
        fileScope: {
          status: 'matched',
          requested: {
            mode: 'explicit',
            fileCount: 1,
            filesIdentity: contextManifest.fileScope.filesIdentity,
          },
          recorded: contextManifest.fileScope,
        },
      });
      expect(JSON.stringify(status)).not.toContain('packages/b/src/index.ts');
      const pointers = status.pointers as {
        pointer: TaskContextSnapshotPointer;
        status: string;
        reasonCodes: string[];
      }[];
      expect(pointers).toHaveLength(contextManifest.planes.length);
      expect(pointers.every((pointer) => pointer.status === 'available')).toBe(true);
      expect(pointers.map((pointer) => pointer.pointer.id)).toEqual(
        contextManifest.planes.flatMap((plane) =>
          plane.pointer === undefined ? [] : [plane.pointer.id],
        ),
      );
    } finally {
      await conn.client.close();
    }
  }, 120_000);

  it('keeps an exact context Run bound to stale and evicted pointers without latest rebinding', async () => {
    const graphPointer = contextManifest.planes.find((plane) => plane.kind === 'graph')?.pointer;
    const inventoryPointer = contextManifest.planes.find(
      (plane) => plane.kind === 'inventory',
    )?.pointer;
    if (graphPointer === undefined || inventoryPointer === undefined) {
      throw new Error('task-context fixture is missing graph or inventory pointers');
    }
    const conn = await connect(contextFixture);
    try {
      writeFileSync(
        join(contextFixture, 'index.ts'),
        `${SOURCE}export function replacementGeneration(): number { return helper(); }\n`,
        'utf8',
      );
      await runBuiltCli(contextFixture, [
        'graph',
        '--cwd',
        contextFixture,
        '--language',
        'typescript',
        '--exact',
        '--no-cache',
      ]);
      const newerInventoryId = evictContextSnapshotAndSeedNewer(contextFixture, inventoryPointer);

      const status = await call(conn, 'get_context_status', {
        runId: contextRunId,
        files: ['packages/b/src/index.ts'],
      });
      expect(status).toMatchObject({
        status: 'available',
        run: { id: contextRunId },
        fileScope: { status: 'matched' },
        manifest: {
          runId: contextRunId,
          graphIdentity: graphPointer.id,
          inventoryIdentity: inventoryPointer.id,
        },
      });
      const pointers = status.pointers as {
        pointer: TaskContextSnapshotPointer;
        status: string;
        reasonCodes: string[];
        currentGraphIdentity?: string;
      }[];
      const graphStatus = pointers.find((pointer) => pointer.pointer.kind === 'graph');
      expect(graphStatus).toMatchObject({
        pointer: { id: graphPointer.id },
        status: 'stale',
        reasonCodes: ['graph-generation-replaced'],
        currentGraphIdentity: expect.stringMatching(/^g1:[a-f0-9]{64}$/),
      });
      expect(graphStatus?.currentGraphIdentity).not.toBe(graphPointer.id);

      const inventoryStatus = pointers.find((pointer) => pointer.pointer.kind === 'inventory');
      expect(inventoryStatus).toMatchObject({
        pointer: { id: inventoryPointer.id },
        status: 'missing',
        reasonCodes: ['context-snapshot-missing'],
      });
      expect(JSON.stringify(status)).not.toContain(newerInventoryId);
      withRawProjectDatabase(contextFixture, (database) => {
        const newer = database
          .prepare('SELECT id FROM graph_context_snapshot WHERE id = ?')
          .get(newerInventoryId) as { id?: unknown } | undefined;
        expect(newer?.id).toBe(newerInventoryId);
      });
    } finally {
      writeFileSync(join(contextFixture, 'index.ts'), SOURCE, 'utf8');
      await conn.client.close();
    }
  }, 120_000);

  it('preserves mixed-confidence and cross-shard evidence through a built stdio trace', async () => {
    const conn = await connect(fixtureA);
    try {
      const trace = await call(conn, 'trace_path', {
        fromSymbolId: entrySymbolId,
        toSymbolId: helperSymbolId,
        depth: 5,
      });
      const data = trace.data as {
        found: boolean;
        weakestConfidence?: string;
        hops?: {
          evidence: { confidence: string; crossShard: boolean }[];
        }[];
      };
      expect(data.found).toBe(true);
      const evidence = (data.hops ?? []).flatMap((hop) => hop.evidence);
      expect(evidence.map((edge) => edge.confidence)).toEqual(
        expect.arrayContaining(['high', 'medium']),
      );
      expect(evidence.some((edge) => edge.crossShard)).toBe(true);
      expect(data.weakestConfidence).toBe('medium');
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('auto-swaps an externally written generation and serves all four audit additions', async () => {
    const conn = await connect(fixtureA);
    try {
      const before = await call(conn, 'get_architecture', {});
      const beforeCatalog = (before.context as { catalog: { identity?: string } }).catalog;
      expect(beforeCatalog.identity).toMatch(/^g1:[a-f0-9]{64}$/);

      writeFileSync(join(fixtureA, 'index.ts'), highFanInProjectSource(), 'utf8');
      await runBuiltCli(fixtureA, ['graph', '--cwd', fixtureA]);

      const after = await call(conn, 'get_architecture', {});
      const afterCatalog = (
        after.context as {
          catalog: { identity?: string; generationSource?: string };
        }
      ).catalog;
      expect(afterCatalog.identity).toMatch(/^g1:[a-f0-9]{64}$/);
      expect(afterCatalog.identity).not.toBe(beforeCatalog.identity);
      expect(afterCatalog.generationSource).toBe('persisted-auto-swap');
      expect((after.context as { project: { root: string } }).project.root).toBe(
        realpathSync(fixtureA),
      );
      expect(conn.stderr).not.toContain('mcp.graph.refresh.completed');

      const packageDeps = await call(conn, 'package_dependencies', {
        edgeKind: 'combined',
        sourceScope: 'all',
        generated: 'include',
        limit: 100,
      });
      const packageData = packageDeps.data as {
        edgeKind: string;
        calls: { fromPackage: string; toPackage: string }[];
        imports: {
          fromPackage: string;
          target: string;
          toPackage: string | null;
          resolution: string;
        }[];
      };
      expect(packageData.edgeKind).toBe('combined');
      expect(packageData.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromPackage: '@fixture/a',
            toPackage: '@fixture/b',
          }),
          expect.objectContaining({
            fromPackage: '@fixture/b',
            toPackage: '@fixture/a',
          }),
        ]),
      );
      expect(packageData.imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromPackage: '@fixture/a',
            target: '@fixture/b',
          }),
          expect.objectContaining({
            fromPackage: '@fixture/b',
            target: '@fixture/a',
          }),
          // The bare `node:path` builtin resolves external end-to-end.
          expect.objectContaining({
            fromPackage: '@fixture/b',
            target: 'node:path',
            toPackage: null,
            resolution: 'external',
          }),
        ]),
      );
      const why = await call(conn, 'why_depends', {
        fromPackage: '@fixture/a',
        toPackage: '@fixture/b',
        edgeKind: 'combined',
        sourceScope: 'all',
        generated: 'include',
        evidenceLimit: 100,
      });
      const whyData = why.data as {
        edgeKind: string;
        calls: { from: { package: string }; to: { package: string } }[];
        imports: { fromPackage: string; toPackage: string | null }[];
        totalMatchingEvidence: number;
      };
      expect(whyData.edgeKind).toBe('combined');
      expect(whyData.totalMatchingEvidence).toBeGreaterThanOrEqual(2);
      expect(whyData.calls).toContainEqual(
        expect.objectContaining({
          from: expect.objectContaining({ package: '@fixture/a' }),
          to: expect.objectContaining({ package: '@fixture/b' }),
        }),
      );
      expect(whyData.imports).toContainEqual(
        expect.objectContaining({
          fromPackage: '@fixture/a',
          toPackage: '@fixture/b',
        }),
      );
      const cycles = await call(conn, 'package_cycles', {
        edgeKind: 'combined',
        sourceScope: 'all',
        generated: 'include',
        proofLimit: 50,
      });
      const cycleData = cycles.data as {
        edgeKind: string;
        components: { packages: string[]; proofEdges: { kind: string }[] }[];
      };
      expect(cycleData.edgeKind).toBe('combined');
      expect(cycleData.components).toContainEqual(
        expect.objectContaining({
          packages: ['@fixture/a', '@fixture/b'],
          proofEdges: expect.arrayContaining([
            expect.objectContaining({ kind: 'call' }),
            expect.objectContaining({ kind: 'import' }),
          ]),
        }),
      );

      const wiring = await call(conn, 'get_runtime_wiring', {
        tool: 'graph',
        detail: 'nodes',
        limit: 100,
      });
      expect(wiring.context).toMatchObject({
        project: { root: realpathSync(fixtureA), scope: 'project' },
        runtime: {
          kind: 'runtime-wiring',
          identity: expect.stringMatching(/^w1:/),
        },
        projectKey: expect.any(String),
        snapshotKey: expect.stringMatching(/^w1:/),
      });
      expect(Array.isArray(wiring.nodes)).toBe(true);
      expect(wiring.coverage).toMatchObject({
        scope: 'captured-admitted-registry-and-command-inventory',
      });
      expect((wiring.coverage as { reasons: string[] }).reasons).not.toContain(
        'top-level-host-commands-outside-port',
      );
      const wiringEdges = wiring.edges as {
        from: string;
        to: string;
        kind: string;
        source: string;
        confidence: string;
        staticBridge: string;
      }[];
      expect(wiringEdges.map((edge) => edge.kind)).toEqual(
        expect.arrayContaining([
          'manifest-admits-tool',
          'registry-owns-command',
          'command-nests-under',
          'host-mounts-command',
          'command-dispatches-handler',
        ]),
      );
      expect(
        wiringEdges.every(
          (edge) =>
            edge.source.length > 0 && edge.confidence.length > 0 && edge.staticBridge.length > 0,
        ),
      ).toBe(true);
      expect(wiringEdges).toContainEqual(
        expect.objectContaining({
          kind: 'command-dispatches-handler',
          source: 'command-spec',
          staticBridge: 'unresolved',
        }),
      );
      const runtimeNodes = wiring.nodes as { id: string; kind: string }[];
      const dispatchEdge = wiringEdges.find((edge) => edge.kind === 'command-dispatches-handler');
      expect(runtimeNodes.find((node) => node.id === dispatchEdge?.from)?.kind).toBe('host-mount');
      expect(runtimeNodes.find((node) => node.id === dispatchEdge?.to)?.kind).toBe('handler');

      const firstSearch = await call(conn, 'search_symbols', {
        query: 'caller',
        match: 'substring',
        filePath: 'index.ts',
        filePrefix: 'index.ts',
        sourceScope: 'production',
        generated: 'exclude',
        // detail defaults to nodes (port); MCP schema exposure is Task 2.7
        limit: 5,
      });
      const firstSymbols = searchPayload(firstSearch.data).symbols;
      const searchCursor = (firstSearch.page as { nextCursor?: string }).nextCursor;
      expect(firstSymbols).toHaveLength(5);
      expect(firstSymbols.every((symbol) => (symbol.simpleName ?? '').startsWith('caller'))).toBe(
        true,
      );
      expect(searchCursor).toBeTypeOf('string');
      // Exclusive nodes mode omits groups; detail=groups is exposed in Task 2.7.
      expect(firstSearch.groups).toBeUndefined();
      if (searchCursor === undefined) throw new Error('high-fan-in search did not page');

      const cursorPayload = JSON.parse(Buffer.from(searchCursor, 'base64url').toString('utf8')) as {
        projectKey: string;
        generationKey: string;
        integrity: string;
      };
      expect(cursorPayload.projectKey).not.toBe(cursorPayload.generationKey);
      expect(cursorPayload.generationKey).toBe(afterCatalog.identity);

      const secondSearch = await call(conn, 'search_symbols', {
        query: 'caller',
        match: 'substring',
        filePath: 'index.ts',
        filePrefix: 'index.ts',
        sourceScope: 'production',
        generated: 'exclude',
        limit: 5,
        cursor: searchCursor,
      });
      const secondSymbols = searchPayload(secondSearch.data).symbols;
      const firstIds = new Set(firstSymbols.map((symbol) => symbol.symbolId));
      expect(secondSymbols).toHaveLength(5);
      expect(secondSymbols.every((symbol) => !firstIds.has(symbol.symbolId))).toBe(true);

      const exactHelper = await call(conn, 'search_symbols', {
        query: 'helper',
        match: 'exact',
        filePath: 'index.ts',
      });
      const helper = searchPayload(exactHelper.data).symbols[0] as
        { symbolId: string; qualifiedName: string } | undefined;
      expect(helper).toBeDefined();
      if (helper === undefined) throw new Error('exact helper search returned no symbol');
      const qualifiedHelper = await call(conn, 'search_symbols', {
        query: helper.qualifiedName,
        match: 'qualified',
        filePath: 'index.ts',
      });
      expect(searchPayload(qualifiedHelper.data).symbols).toEqual(
        expect.arrayContaining([expect.objectContaining({ symbolId: helper.symbolId })]),
      );

      const fanIn = await call(conn, 'who_calls', {
        symbolId: helper.symbolId,
        depth: 1,
        limit: 10,
        // default detail=nodes; groupBy must be none for exclusive nodes mode
      });
      const fanInNodes = (fanIn.data as { nodes: { symbol: { symbolId: string } }[] }).nodes;
      const fanInCursor = (fanIn.page as { nextCursor?: string }).nextCursor;
      expect(fanInNodes).toHaveLength(10);
      expect(fanInCursor).toBeTypeOf('string');
      expect(fanIn.groups).toBeUndefined();
      if (fanInCursor === undefined) throw new Error('high-fan-in traversal did not page');
      const fanInNext = await call(conn, 'who_calls', {
        symbolId: helper.symbolId,
        depth: 1,
        limit: 10,
        cursor: fanInCursor,
      });
      const firstFanInIds = new Set(fanInNodes.map((node) => node.symbol.symbolId));
      const nextFanInNodes = (fanInNext.data as { nodes: { symbol: { symbolId: string } }[] })
        .nodes;
      expect(nextFanInNodes.every((node) => !firstFanInIds.has(node.symbol.symbolId))).toBe(true);

      const unused = await call(conn, 'search_symbols', {
        query: 'unused',
        match: 'exact',
      });
      const unusedSymbol = searchPayload(unused.data).symbols[0];
      expect(unusedSymbol).toBeDefined();
      if (unusedSymbol === undefined) throw new Error('unused symbol not found');
      const noPath = await call(conn, 'trace_path', {
        fromSymbolId: helper.symbolId,
        toSymbolId: unusedSymbol.symbolId,
        depth: 5,
      });
      expect(noPath.data).toMatchObject({ found: false });
      expect(noPath.coverage).toMatchObject({
        complete: true,
        truncated: false,
      });

      const twinSearch = await call(conn, 'search_symbols', {
        query: 'sharedTwin',
        match: 'exact',
        sourceScope: 'all',
      });
      const twins = searchPayload(twinSearch.data).symbols as {
        symbolId: string;
        bodyHash: string;
        filePath: string;
      }[];
      const productionTwin = twins.find((symbol) => symbol.filePath.endsWith('/twin.ts'));
      const testTwin = twins.find((symbol) => symbol.filePath.endsWith('/twin.test.ts'));
      expect(productionTwin?.bodyHash).toBe(testTwin?.bodyHash);
      if (productionTwin === undefined) throw new Error('production twin not found');
      const productionTwinWalk = await call(conn, 'callees_of', {
        symbolId: productionTwin.symbolId,
        identity: 'body-twin-union',
        depth: 2,
        sourceScope: 'production',
        generated: 'exclude',
      });
      const productionTwinNames = (
        productionTwinWalk.data as {
          nodes: { symbol: { simpleName: string } }[];
        }
      ).nodes.map((node) => node.symbol.simpleName);
      expect(productionTwinNames).toContain('fromA');
      expect(productionTwinNames).not.toContain('fromB');
      const allTwinWalk = await call(conn, 'callees_of', {
        symbolId: productionTwin.symbolId,
        identity: 'body-twin-union',
        depth: 2,
        sourceScope: 'all',
        generated: 'include',
      });
      const allTwinNames = (
        allTwinWalk.data as { nodes: { symbol: { simpleName: string } }[] }
      ).nodes.map((node) => node.symbol.simpleName);
      expect(allTwinNames).toEqual(expect.arrayContaining(['fromA', 'fromB']));

      const tamperedPayload = { ...cursorPayload, integrity: '0'.repeat(32) };
      const tampered = Buffer.from(JSON.stringify(tamperedPayload), 'utf8').toString('base64url');
      const badCursor = await conn.client.callTool({
        name: 'search_symbols',
        arguments: { query: 'caller', limit: 5, cursor: tampered },
      });
      expect(badCursor.isError).toBe(true);
      expect(JSON.stringify(badCursor.content)).toContain('cursor-invalid');

      const runtimePage = await call(conn, 'get_runtime_wiring', {
        detail: 'nodes',
        limit: 1,
      });
      const runtimeCursor = (runtimePage.page as { nextCursor?: string }).nextCursor;
      expect(runtimeCursor).toBeTypeOf('string');
      if (runtimeCursor === undefined) throw new Error('runtime wiring did not page');
      const otherProject = await connect(fixtureB);
      try {
        const wrongProject = await otherProject.client.callTool({
          name: 'get_runtime_wiring',
          arguments: { detail: 'nodes', limit: 1, cursor: runtimeCursor },
        });
        expect(wrongProject.isError).toBe(true);
        expect(JSON.stringify(wrongProject.content)).toContain('cursor-project-mismatch');
      } finally {
        await otherProject.client.close();
      }

      const badGraphCall = await conn.client.callTool({
        name: 'who_calls',
        arguments: { symbolId: helperSymbolId, depth: 99 },
      });
      expect(badGraphCall.isError).toBe(true);
      expect(JSON.stringify(badGraphCall.content)).toMatch(/depth|expected number to be <=5/i);
      const runs = await call(conn, 'list_runs', { tool: 'graph' });
      expect(Array.isArray(runs.runs)).toBe(true);
    } finally {
      writeFileSync(join(fixtureA, 'index.ts'), SOURCE, 'utf8');
      await conn.client.close();
    }
  }, 120_000);

  it('tracks forced and auto adapter selection as multi-language dominance changes', async () => {
    const root = scaffoldIsolated([
      {
        path: 'index.ts',
        content: 'export function typescriptOnly(): number { return 1; }\n',
      },
      { path: 'python_one.py', content: 'def python_one():\n    return 1\n' },
      { path: 'python_two.py', content: 'def python_two():\n    return 2\n' },
      {
        path: 'python_three.py',
        content: 'def python_three():\n    return 3\n',
      },
    ]);
    let conn: Connected | undefined;
    try {
      await runBuiltCli(root, [
        'graph',
        '--cwd',
        root,
        '--language',
        'typescript',
        '--exact',
        '--no-cache',
      ]);
      conn = await connect(root);

      const forced = await call(conn, 'get_architecture', {});
      const forcedCatalog = (
        forced.context as {
          catalog: {
            identity?: string;
            language?: string;
            engineMode?: string;
          };
        }
      ).catalog;
      expect(forcedCatalog).toMatchObject({
        language: 'typescript',
        engineMode: 'exact',
      });
      expect(forcedCatalog.identity).toMatch(/^g1:[a-f0-9]{64}$/);
      expect(forced.freshness).toMatchObject({
        fresh: true,
        verification: 'complete',
      });

      await runBuiltCli(root, ['graph', '--cwd', root, '--exact', '--no-cache']);
      const autoPython = await call(conn, 'get_architecture', {});
      const pythonCatalog = (
        autoPython.context as {
          catalog: {
            identity?: string;
            language?: string;
            generationSource?: string;
          };
        }
      ).catalog;
      expect(pythonCatalog).toMatchObject({
        language: 'python',
        generationSource: 'persisted-auto-swap',
      });
      expect(pythonCatalog.identity).not.toBe(forcedCatalog.identity);
      expect(autoPython.freshness).toMatchObject({
        fresh: true,
        verification: 'complete',
      });

      rmSync(join(root, 'python_two.py'));
      rmSync(join(root, 'python_three.py'));
      for (let index = 0; index < 3; index++) {
        writeFileSync(
          join(root, `typescript_${String(index)}.ts`),
          `export function typescript${String(index)}(): number { return ${String(index)}; }\n`,
          'utf8',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2200));

      const dominanceDrift = await call(conn, 'get_architecture', {});
      expect(dominanceDrift.freshness).toMatchObject({
        fresh: false,
        verification: 'complete',
        reasonCode: 'selection-changed',
      });
      expect((dominanceDrift.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        pythonCatalog.identity,
      );

      await runBuiltCli(root, ['graph', '--cwd', root, '--exact', '--no-cache']);
      const autoTypescript = await call(conn, 'get_architecture', {});
      const finalCatalog = (
        autoTypescript.context as {
          catalog: {
            identity?: string;
            language?: string;
            generationSource?: string;
          };
        }
      ).catalog;
      expect(finalCatalog).toMatchObject({
        language: 'typescript',
        generationSource: 'persisted-auto-swap',
      });
      expect(finalCatalog.identity).not.toBe(pythonCatalog.identity);
      expect(autoTypescript.freshness).toMatchObject({
        fresh: true,
        verification: 'complete',
      });
      expect(conn.stderr).not.toContain('mcp.graph.refresh.completed');
    } finally {
      await conn?.client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('keeps a pre-feature catalog queryable with partial verification until external replacement', async () => {
    const root = scaffoldIsolated([
      {
        path: 'index.ts',
        content: [
          'export function legacyEntry(): number { return legacyHelper(); }',
          'function legacyHelper(): number { return 1; }',
          '',
        ].join('\n'),
      },
    ]);
    let conn: Connected | undefined;
    try {
      await runBuiltCli(root, [
        'graph',
        '--cwd',
        root,
        '--language',
        'typescript',
        '--exact',
        '--no-cache',
      ]);
      withRawProjectDatabase(root, (database) => {
        const row = database.prepare('SELECT payload FROM graph_catalog WHERE id = 1').get() as
          { payload?: unknown } | undefined;
        if (typeof row?.payload !== 'string') throw new Error('legacy catalog payload is missing');
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        delete payload.adapterSelection;
        delete payload.engineMode;
        delete payload.shardCacheInputs;
        database
          .prepare('UPDATE graph_catalog SET payload = ? WHERE id = 1')
          .run(JSON.stringify(payload));
      });

      conn = await connect(root);
      const legacy = await call(conn, 'search_symbols', {
        query: 'legacyHelper',
        match: 'exact',
      });
      expect(searchPayload(legacy.data).symbols).toHaveLength(1);
      expect(legacy.freshness).toMatchObject({
        fresh: false,
        verification: 'partial',
        reasonCode: 'verification-unavailable',
      });
      const legacyIdentity = (legacy.context as { catalog: { identity?: string } }).catalog
        .identity;
      expect(legacyIdentity).toMatch(/^g1:[a-f0-9]{64}$/);

      await runBuiltCli(root, [
        'graph',
        '--cwd',
        root,
        '--language',
        'typescript',
        '--exact',
        '--no-cache',
      ]);
      const replaced = await call(conn, 'search_symbols', {
        query: 'legacyHelper',
        match: 'exact',
      });
      expect(searchPayload(replaced.data).symbols).toHaveLength(1);
      expect(replaced.freshness).toMatchObject({
        fresh: true,
        verification: 'complete',
      });
      expect(replaced.context).toMatchObject({
        catalog: {
          language: 'typescript',
          engineMode: 'exact',
          generationSource: 'persisted-auto-swap',
        },
      });
      expect((replaced.context as { catalog: { identity?: string } }).catalog.identity).not.toBe(
        legacyIdentity,
      );
      expect(conn.stderr).not.toContain('mcp.graph.refresh.completed');
    } finally {
      await conn?.client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('serves the result-first path: get_latest_findings replays a seeded run (never re-runs)', async () => {
    const conn = await connect(fixtureA);
    try {
      const out = await call(conn, 'get_latest_findings', { tool: 'graph' });
      expect(Array.isArray(out.data)).toBe(true);
      expect(out.session).toMatchObject({ tool: 'graph' });
      const seeded = await call(conn, 'show_run', { ref: 'graph-e2e-1' });
      expect(JSON.stringify(seeded)).toContain('a seeded finding');
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('enforces the final 4 MiB result ceiling without emitting partial content', async () => {
    const conn = await connect(fixtureA);
    try {
      const result = await conn.client.callTool({
        name: 'show_run',
        arguments: { ref: OVERSIZED_SESSION_ID },
      });
      expect(result.isError).toBe(true);
      const serialized = JSON.stringify(result.content);
      expect(serialized).toContain('response-too-large');
      expect(serialized).toContain('Lower limit or narrow filters');
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(4096);
      expect(serialized).not.toContain('oversized-8499.ts');
    } finally {
      await conn.client.close();
    }
  }, 60_000);

  it('reports exact add/modify/delete drift and forced-selection config drift', async () => {
    const deletedFixture = PACKAGE_EVIDENCE_FILES.find(
      (file) => file.path === 'packages/a/src/twin.ts',
    );
    if (deletedFixture === undefined) throw new Error('deleted-file fixture is missing');
    const addedPath = join(fixtureA, 'added.ts');
    const deletedPath = join(fixtureA, deletedFixture.path);

    writeFileSync(
      join(fixtureA, 'index.ts'),
      SOURCE + '\nexport function added(): number { return 2; }\n',
      'utf8',
    );
    writeFileSync(addedPath, 'export function newlyAdded(): number { return 3; }\n', 'utf8');
    rmSync(deletedPath);
    const conn = await connect(fixtureA);
    try {
      const arch = await call(conn, 'get_architecture', {});
      expect(arch.freshness).toMatchObject({
        fresh: false,
        verification: 'complete',
        reasonCode: 'files-changed',
        changes: { added: 1, modified: 1, deleted: 1 },
      });
    } finally {
      await conn.client.close();
    }

    writeFileSync(join(fixtureA, 'index.ts'), SOURCE, 'utf8');
    rmSync(addedPath);
    writeFileSync(deletedPath, deletedFixture.content, 'utf8');

    await runBuiltCli(fixtureA, [
      'graph',
      '--cwd',
      fixtureA,
      '--language',
      'typescript',
      '--exact',
    ]);
    const forcedConn = await connect(fixtureA);
    try {
      const fresh = await call(forcedConn, 'get_architecture', {});
      expect(fresh.freshness).toMatchObject({
        fresh: true,
        verification: 'complete',
      });
    } finally {
      await forcedConn.client.close();
    }

    writeFileSync(join(fixtureA, 'tsconfig.json'), TSCONFIG.replace('ES2022', 'ES2021'), 'utf8');
    const driftConn = await connect(fixtureA);
    try {
      const configDrift = await call(driftConn, 'get_architecture', {});
      expect(configDrift.freshness).toMatchObject({
        fresh: false,
        verification: 'complete',
        reasonCode: 'cache-key-changed',
      });
    } finally {
      writeFileSync(join(fixtureA, 'tsconfig.json'), TSCONFIG, 'utf8');
      await driftConn.client.close();
    }
  }, 180_000);

  it('refresh_graph builds a catalog on a project that has none (adapters load under the mcp run)', async () => {
    const conn = await connect(fixtureB);
    try {
      const beforeRuns = await call(conn, 'list_runs', { tool: 'graph' });
      expect(beforeRuns.runs).toEqual([]);
      const refreshed = await call(conn, 'refresh_graph', {});
      const refreshData = refreshed.data as {
        generation: { builtAt: string };
        durationMs: number;
        action: string;
      };
      expect(typeof refreshData.generation.builtAt).toBe('string');
      expect(typeof refreshData.durationMs).toBe('number');
      expect(refreshData.action).toBe('rebuilt');
      expect(refreshed.context).toBeDefined();

      const noOp = await call(conn, 'refresh_graph', {});
      expect((noOp.data as { action: string }).action).toBe('no-op');

      writeFileSync(
        join(fixtureB, 'index.ts'),
        `${SOURCE}export function externalReload(): number { return helper(); }\n`,
        'utf8',
      );
      await runBuiltCli(fixtureB, ['graph', '--cwd', fixtureB, '--language', 'typescript']);
      const afterExternalRun = await call(conn, 'list_runs', { tool: 'graph' });
      expect(afterExternalRun.runs).toHaveLength(1);
      const reloaded = await call(conn, 'refresh_graph', {});
      expect((reloaded.data as { action: string }).action).toBe('reloaded');

      const forced = await call(conn, 'refresh_graph', { forceRebuild: true });
      expect((forced.data as { action: string }).action).toBe('rebuilt');
      // After the rebuild, the catalog is fresh and queryable.
      const search = await call(conn, 'search_symbols', { query: 'helper' });
      expect(searchPayload(search.data).symbols.length).toBeGreaterThan(0);
      const afterRuns = await call(conn, 'list_runs', { tool: 'graph' });
      expect(afterRuns.runs).toEqual(afterExternalRun.runs);
    } finally {
      await conn.client.close();
    }
  }, 120_000);

  it('single-flights concurrent refreshes across an old-reader/new-reader boundary', async () => {
    const root = scaffoldIsolated([{ path: 'index.ts', content: concurrentRefreshSource('old') }]);
    let conn: Connected | undefined;
    try {
      await runBuiltCli(root, [
        'graph',
        '--cwd',
        root,
        '--language',
        'typescript',
        '--exact',
        '--no-cache',
      ]);
      conn = await connect(root);
      const before = await call(conn, 'search_symbols', {
        query: 'oldEpoch',
        match: 'exact',
      });
      const oldIdentity = (before.context as { catalog: { identity?: string } }).catalog.identity;
      expect(oldIdentity).toMatch(/^g1:[a-f0-9]{64}$/);
      expect(searchPayload(before.data).symbols).toHaveLength(1);

      writeFileSync(join(root, 'index.ts'), concurrentRefreshSource('new'), 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const stderrOffset = conn.stderr.length;

      // Keep these calls in one turn: the reader captures the immutable old
      // generation while both forced mutations join the controller's flight.
      const delayedOldReader = call(conn, 'get_architecture', { limit: 500 });
      const firstRefresh = call(conn, 'refresh_graph', { forceRebuild: true });
      const secondRefresh = call(conn, 'refresh_graph', { forceRebuild: true });
      const [oldReader, first, second] = await Promise.all([
        delayedOldReader,
        firstRefresh,
        secondRefresh,
      ]);

      expect((oldReader.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        oldIdentity,
      );
      expect(oldReader.freshness).toMatchObject({
        fresh: false,
        verification: 'complete',
        reasonCode: 'files-changed',
      });
      const firstData = first.data as {
        action: string;
        generation: { identity: string };
      };
      const secondData = second.data as {
        action: string;
        generation: { identity: string };
      };
      expect(firstData.action).toBe('rebuilt');
      expect(secondData.action).toBe('rebuilt');
      expect(firstData.generation.identity).toBe(secondData.generation.identity);
      expect(firstData.generation.identity).not.toBe(oldIdentity);
      expect(countLogEvent(conn.stderr.slice(stderrOffset), 'graph.edges.start')).toBe(1);

      const newReader = await call(conn, 'search_symbols', {
        query: 'newEpoch',
        match: 'exact',
      });
      expect(searchPayload(newReader.data).symbols).toHaveLength(1);
      expect((newReader.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        firstData.generation.identity,
      );
      expect(newReader.freshness).toMatchObject({
        fresh: true,
        verification: 'complete',
      });
      const oldAfterSwap = await call(conn, 'search_symbols', {
        query: 'oldEpoch',
        match: 'exact',
      });
      expect(searchPayload(oldAfterSwap.data).symbols).toEqual([]);

      const followUp = await call(conn, 'refresh_graph', {});
      expect((followUp.data as { action: string }).action).toBe('no-op');
    } finally {
      await conn?.client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('retains the prior generation and persisted result tools after a forced refresh failure', async () => {
    const conn = await connect(fixtureA);
    try {
      const before = await call(conn, 'get_architecture', {});
      const priorIdentity = (before.context as { catalog: { identity?: string } }).catalog.identity;
      expect(priorIdentity).toMatch(/^g1:[a-f0-9]{64}$/);
      const beforeRuns = await call(conn, 'list_runs', { tool: 'graph' });

      writeFileSync(join(fixtureA, 'tsconfig.json'), '{"compilerOptions":', 'utf8');
      const failedRefresh = await conn.client.callTool({
        name: 'refresh_graph',
        arguments: { forceRebuild: true },
      });
      expect(failedRefresh.isError).toBe(true);
      const failedText = JSON.stringify(failedRefresh.content);
      expect(failedText).toMatch(/refresh|rebuild/i);
      expect(failedText).not.toContain(fixtureA);
      expect(failedText).not.toMatch(/\s+at\s+.*:\d+/u);
      expect(Buffer.byteLength(failedText, 'utf8')).toBeLessThan(4096);

      const runs = await call(conn, 'list_runs', { tool: 'graph' });
      const shown = await call(conn, 'show_run', { ref: 'graph-e2e-1' });
      const latest = await call(conn, 'get_latest_findings', { tool: 'graph' });
      const review = await call(conn, 'review_change', {
        suiteRunId: 'suite-e2e-1',
      });
      expect(runs.runs).toEqual(beforeRuns.runs);
      expect(JSON.stringify(shown)).toContain('a seeded finding');
      expect(latest.session).toMatchObject({ tool: 'graph' });
      expect(review.data).toMatchObject({
        reviewBrief: { version: 1 },
        source: { suiteRunId: 'suite-e2e-1', sessionIds: ['graph-e2e-1'] },
        freshness: { graph: expect.any(Object) },
      });

      writeFileSync(join(fixtureA, 'tsconfig.json'), TSCONFIG, 'utf8');
      const after = await call(conn, 'get_architecture', {});
      expect((after.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        priorIdentity,
      );
    } finally {
      writeFileSync(join(fixtureA, 'tsconfig.json'), TSCONFIG, 'utf8');
      await conn.client.close();
    }
  }, 120_000);

  it('degrades stored review replay on an identity-read fault and resumes the prior generation', async () => {
    const conn = await connect(lifecycleFixture);
    let catalogRenamed = false;
    try {
      const beforeRuns = await call(conn, 'list_runs', { tool: 'graph' });
      const before = await call(conn, 'get_architecture', {});
      const priorIdentity = (before.context as { catalog: { identity?: string } }).catalog.identity;
      expect(priorIdentity).toMatch(/^g1:[a-f0-9]{64}$/);

      withRawProjectDatabase(lifecycleFixture, (database) => {
        database.exec('ALTER TABLE graph_catalog RENAME TO graph_catalog_identity_fault');
      });
      catalogRenamed = true;

      const review = await call(conn, 'review_change', {
        suiteRunId: 'suite-e2e-1',
      });
      expectUnavailableStoredReview(review);
      const afterRuns = await call(conn, 'list_runs', { tool: 'graph' });
      expect(afterRuns.runs).toEqual(beforeRuns.runs);
      expectScrubbedDiagnostics(conn, lifecycleFixture);

      withRawProjectDatabase(lifecycleFixture, (database) => {
        database.exec('ALTER TABLE graph_catalog_identity_fault RENAME TO graph_catalog');
      });
      catalogRenamed = false;

      const recovered = await call(conn, 'search_symbols', {
        query: 'helper',
        match: 'exact',
      });
      expect(searchPayload(recovered.data).symbols.length).toBeGreaterThan(0);
      expect((recovered.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        priorIdentity,
      );
    } finally {
      if (catalogRenamed) {
        withRawProjectDatabase(lifecycleFixture, (database) => {
          database.exec('ALTER TABLE graph_catalog_identity_fault RENAME TO graph_catalog');
        });
      }
      await conn.client.close();
    }
  }, 120_000);

  it('degrades stored review replay on initial generation-load failure and recovers in place', async () => {
    let originalPayload = '';
    withRawProjectDatabase(lifecycleFixture, (database) => {
      const row = database.prepare('SELECT payload FROM graph_catalog WHERE id = 1').get() as
        { payload?: unknown } | undefined;
      if (typeof row?.payload !== 'string') throw new Error('lifecycle catalog payload is missing');
      originalPayload = row.payload;
      database
        .prepare('UPDATE graph_catalog SET payload = ? WHERE id = 1')
        .run('{"version":"3.0","functions":');
    });

    const conn = await connect(lifecycleFixture);
    try {
      // Result-only calls do not initialize a graph generation. The first graph
      // touch is review_change, so this exercises load/sync with no prior snapshot.
      const beforeRuns = await call(conn, 'list_runs', { tool: 'graph' });
      const review = await call(conn, 'review_change', {
        suiteRunId: 'suite-e2e-1',
      });
      expectUnavailableStoredReview(review);
      const afterRuns = await call(conn, 'list_runs', { tool: 'graph' });
      expect(afterRuns.runs).toEqual(beforeRuns.runs);
      expectScrubbedDiagnostics(conn, lifecycleFixture);

      withRawProjectDatabase(lifecycleFixture, (database) => {
        database.prepare('UPDATE graph_catalog SET payload = ? WHERE id = 1').run(originalPayload);
      });
      originalPayload = '';

      const recovered = await call(conn, 'search_symbols', {
        query: 'helper',
        match: 'exact',
      });
      expect(searchPayload(recovered.data).symbols.length).toBeGreaterThan(0);
      expect(
        (recovered.context as { catalog: { generationSource?: string } }).catalog.generationSource,
      ).toBe('initial-load');
    } finally {
      if (originalPayload.length > 0) {
        withRawProjectDatabase(lifecycleFixture, (database) => {
          database
            .prepare('UPDATE graph_catalog SET payload = ? WHERE id = 1')
            .run(originalPayload);
        });
      }
      await conn.client.close();
    }
  }, 120_000);

  it('degrades stored review replay on verifier failure and keeps the generation queryable', async () => {
    const conn = await connect(lifecycleFixture);
    try {
      const beforeRuns = await call(conn, 'list_runs', { tool: 'graph' });
      const before = await call(conn, 'get_architecture', {});
      const priorIdentity = (before.context as { catalog: { identity?: string } }).catalog.identity;
      expect(priorIdentity).toMatch(/^g1:[a-f0-9]{64}$/);

      writeFileSync(join(lifecycleFixture, 'tsconfig.json'), '{"compilerOptions":', 'utf8');
      // Let the bounded successful-verification burst expire so review_change
      // must execute the real verifier against the malformed config.
      await new Promise((resolve) => setTimeout(resolve, 2200));

      const review = await call(conn, 'review_change', {
        suiteRunId: 'suite-e2e-1',
      });
      expectUnavailableStoredReview(review);
      const afterRuns = await call(conn, 'list_runs', { tool: 'graph' });
      expect(afterRuns.runs).toEqual(beforeRuns.runs);
      expectScrubbedDiagnostics(conn, lifecycleFixture);

      writeFileSync(join(lifecycleFixture, 'tsconfig.json'), TSCONFIG, 'utf8');
      const recovered = await call(conn, 'search_symbols', {
        query: 'helper',
        match: 'exact',
      });
      expect(searchPayload(recovered.data).symbols.length).toBeGreaterThan(0);
      expect((recovered.context as { catalog: { identity?: string } }).catalog.identity).toBe(
        priorIdentity,
      );
    } finally {
      writeFileSync(join(lifecycleFixture, 'tsconfig.json'), TSCONFIG, 'utf8');
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
    expect(conn.stderr).not.toContain(fixtureA);
    expect(Buffer.byteLength(conn.stderr, 'utf8')).toBeLessThan(64 * 1024);
  }, 60_000);
});
