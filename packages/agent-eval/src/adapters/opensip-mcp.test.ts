import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HarnessPrerequisiteError } from '../runner/spawn.js';
import { extractImpactFiles } from '../tasks/context-surface-extractors.js';
import { taskRegistry } from '../tasks/index.js';

import { cumulativeMcpStdoutByteLimit, mcpRawFrameByteLimit } from './opensip-mcp-connection.js';
import {
  EXPECTED_MCP_SURFACE_EPOCH,
  McpArmSession,
  REQUIRED_MCP_TOOL_NAMES,
} from './opensip-mcp.js';

import type { McpConnection, McpConnectionFactory, McpConnectionOptions } from './opensip-mcp.js';
import type { ResolvedStrategyStep } from '../model/task.js';

const TOOL_NAMES = [
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
  'impact_files',
  'list_runs',
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
] as const;

const MCP_SETUP_TOOL_NAMES = [
  'get_agent_catalog',
  'get_architecture',
  'get_context_status',
] as const;

interface FakeConnectionOptions {
  readonly catalog?: Readonly<Record<string, unknown>>;
  readonly catalogResult?: unknown;
  readonly connectError?: Error;
  readonly listedNames?: readonly string[];
  readonly serverVersion?: { readonly name: string; readonly version: string };
  readonly stderrOnConnect?: string;
  readonly toolResults?: readonly unknown[];
}

interface FakeConnectionHarness {
  readonly calls: readonly {
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly name: string;
  }[];
  readonly close: ReturnType<typeof vi.fn>;
  readonly connection: McpConnection;
  readonly stderr: PassThrough;
}

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-mcp-test-'));
  roots.push(root);
  return root;
}

function textResult(payload: unknown, isError = false): unknown {
  return {
    content: [{ text: JSON.stringify(payload), type: 'text' }],
    ...(isError ? { isError: true } : {}),
  };
}

const COMPLETE_COVERAGE = {
  complete: true,
  evidence: { complete: true, reasons: [], requested: true, truncated: false },
  grouping: { complete: true, reasons: [], requested: false, truncated: false },
  inventory: { complete: true, reasons: [], requested: true, truncated: false },
  projection: {
    complete: true,
    reasons: [],
    requested: true,
    truncated: false,
  },
  reasons: [],
  truncated: false,
} as const;

function graphPayload(root: string, data: unknown): Readonly<Record<string, unknown>> {
  return {
    context: {
      catalog: { identity: 'g1:fixture', status: 'loaded' },
      project: { root, scope: 'project' },
    },
    coverage: COMPLETE_COVERAGE,
    data,
    freshness: { fresh: true, verification: 'complete' },
  };
}

function validCatalog(
  root: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    commands: [],
    mcp: {
      mutationPosture: 'read-only',
      project: { root, scope: 'project' },
      surfaceEpoch: EXPECTED_MCP_SURFACE_EPOCH,
      toolCount: TOOL_NAMES.length,
      toolNames: TOOL_NAMES,
      version: '0.6.0',
      ...overrides,
    },
  };
}

function fakeConnection(root: string, options: FakeConnectionOptions = {}): FakeConnectionHarness {
  const calls: {
    arguments: Readonly<Record<string, unknown>>;
    name: string;
  }[] = [];
  const toolResults = [...(options.toolResults ?? [])];
  const stderr = new PassThrough();
  const close = vi.fn(() => Promise.resolve());
  const connection: McpConnection = {
    callTool: (input) => {
      calls.push(input);
      if (input.name === 'get_agent_catalog') {
        return Promise.resolve(
          options.catalogResult ?? textResult(options.catalog ?? validCatalog(root)),
        );
      }
      return Promise.resolve(toolResults.shift());
    },
    close,
    connect: () => {
      if (options.stderrOnConnect !== undefined) {
        stderr.write(options.stderrOnConnect);
      }
      return options.connectError === undefined
        ? Promise.resolve()
        : Promise.reject(options.connectError);
    },
    listTools: () =>
      Promise.resolve({
        tools: (options.listedNames ?? TOOL_NAMES).map((name) => ({ name })),
      }),
    serverVersion: () => options.serverVersion ?? { name: 'opensip-cli-mcp', version: '0.6.0' },
    stderr,
  };
  return { calls, close, connection, stderr };
}

async function connectFake(
  root: string,
  harness: FakeConnectionHarness,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxResponseBytes?: number;
    readonly maxStderrBytes?: number;
    readonly maxToolCalls?: number;
    readonly targetStabilityCheck?: () => void;
  } = {},
): Promise<{
  readonly captured: McpConnectionOptions;
  readonly session: McpArmSession;
}> {
  let captured: McpConnectionOptions | undefined;
  const factory: McpConnectionFactory = (connectionOptions) => {
    captured = connectionOptions;
    return harness.connection;
  };
  const session = await McpArmSession.connect({
    cliDistResolver: () => '/built/opensip.js',
    connectionFactory: factory,
    workspaceRoot: root,
    ...options,
  });
  if (captured === undefined) throw new Error('connection options were not captured');
  return { captured, session };
}

function resolvedStep(
  extract: ResolvedStrategyStep['extract'] = () => [{ kind: 'file', path: 'src/index.ts' }],
): ResolvedStrategyStep {
  return {
    arguments: { detail: 'summary', query: 'entry' },
    expectedNonEmpty: true,
    extract,
    id: 'search-entry',
    rationale: 'Find the entry symbol',
    tool: 'search_symbols',
  };
}

function registeredOpenSipToolNames(): readonly string[] {
  const names = new Set<string>(MCP_SETUP_TOOL_NAMES);
  for (const task of Object.values(taskRegistry)) {
    const steps = [
      ...task.strategies.opensip.steps,
      ...(task.staleness?.postEditSteps.opensip ?? []),
      ...(task.staleness?.recoverySteps?.opensip ?? []),
    ];
    for (const step of steps) names.add(step.tool);
  }
  return [...names].sort();
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('McpArmSession handshake', () => {
  it('resolves the CLI entrypoint immediately before constructing the MCP transport', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root);
    const events: string[] = [];
    const session = await McpArmSession.connect({
      cliDistResolver: () => {
        events.push('resolve');
        return '/built/opensip.js';
      },
      connectionFactory: (options) => {
        events.push(`factory:${options.args[0]}`);
        return harness.connection;
      },
      workspaceRoot: root,
    });

    expect(events).toEqual(['resolve', 'factory:/built/opensip.js']);
    await session.close();
  });

  it('rejects installed-target mutation observed after the MCP process closes', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root);
    let checks = 0;
    const { session } = await connectFake(root, harness, {
      targetStabilityCheck: () => {
        checks += 1;
        if (checks > 1) {
          throw new HarnessPrerequisiteError(
            'The installed CLI private snapshot changed during the run.',
          );
        }
      },
    });

    expect(checks).toBe(1);
    await expect(session.close()).rejects.toThrow(/private snapshot changed/u);
    expect(checks).toBe(2);
  });

  it('verifies initialize, catalog, listTools, root, posture, and actively drains stderr', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, { stderrOnConnect: '123456789' });
    const { captured, session } = await connectFake(root, harness, {
      env: {
        HOME: join(root, 'isolated home'),
        OPENSIP_API_KEY: 'must-not-survive',
      },
      maxStderrBytes: 4,
    });

    expect(captured).toMatchObject({
      args: ['/built/opensip.js', 'mcp', '--cwd', root],
      command: process.execPath,
      cwd: root,
      maxFrameBytes: mcpRawFrameByteLimit(16 * 1024 * 1024),
      maxStdoutBytes: cumulativeMcpStdoutByteLimit(16 * 1024 * 1024, 16),
    });
    expect(captured.env.OPENSIP_API_KEY).toBeUndefined();
    expect(captured.env.HOME).toBe(join(root, 'isolated home'));
    expect(harness.calls).toEqual([{ arguments: {}, name: 'get_agent_catalog' }]);
    expect(session.provenance()).toMatchObject({
      mutationPosture: 'read-only',
      projectRootVerified: true,
      projectScope: 'project',
      stderr: { bytes: 9, truncated: true },
      surfaceEpoch: 7,
      surfaceVerified: true,
      toolCount: TOOL_NAMES.length,
      toolNames: [...TOOL_NAMES].sort(),
      version: '0.6.0',
    });
    expect(session.provenance()).not.toHaveProperty('projectRoot');

    await session.close();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('enforces the closed tool-call budget used to derive cumulative transport bytes', async () => {
    const root = temporaryRoot();
    const payload = textResult(graphPayload(root, {}));
    const harness = fakeConnection(root, { toolResults: [payload, payload] });
    const { captured, session } = await connectFake(root, harness, {
      maxResponseBytes: 4096,
      maxToolCalls: 2,
    });

    expect(captured.maxStdoutBytes).toBe(cumulativeMcpStdoutByteLimit(4096, 2));
    expect(captured.maxFrameBytes).toBe(mcpRawFrameByteLimit(4096));
    await session.callTool(resolvedStep());
    await session.callTool(resolvedStep());
    await expect(session.callTool(resolvedStep())).rejects.toThrow(/tool-call budget/u);
    await session.close();
  });

  it.each([
    ['surface epoch', { surfaceEpoch: 99 }, TOOL_NAMES],
    ['catalog name/count', { toolCount: TOOL_NAMES.length - 1 }, TOOL_NAMES],
    ['mutation posture', { mutationPosture: 'mutations-enabled' }, TOOL_NAMES],
  ])('rejects a %s mismatch and closes the connection', async (_label, mcp, listedNames) => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, {
      catalog: validCatalog(root, mcp),
      listedNames,
    });

    await expect(connectFake(root, harness)).rejects.toThrow(HarnessPrerequisiteError);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('tracks exactly the tools used by registered OpenSIP strategies and setup', () => {
    expect(REQUIRED_MCP_TOOL_NAMES).toEqual(registeredOpenSipToolNames());
  });

  it('rejects a same-count substitution of a required tool', async () => {
    const root = temporaryRoot();
    const substitutedNames = TOOL_NAMES.map((name) =>
      name === 'refresh_graph' ? 'future_read_tool' : name,
    );
    const harness = fakeConnection(root, {
      catalog: validCatalog(root, {
        toolCount: substitutedNames.length,
        toolNames: substitutedNames,
      }),
      listedNames: substitutedNames,
    });

    await expect(connectFake(root, harness)).rejects.toThrow(
      /missing required tools: refresh_graph/u,
    );
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('rejects a missing required tool even when catalog and listTools agree', async () => {
    const root = temporaryRoot();
    const names = TOOL_NAMES.filter((name) => name !== 'get_symbol');
    const harness = fakeConnection(root, {
      catalog: validCatalog(root, {
        toolCount: names.length,
        toolNames: names,
      }),
      listedNames: names,
    });

    await expect(connectFake(root, harness)).rejects.toThrow(/missing required tools: get_symbol/u);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('accepts additive tools when catalog and listTools agree', async () => {
    const root = temporaryRoot();
    const names = [...TOOL_NAMES, 'future_read_tool'];
    const harness = fakeConnection(root, {
      catalog: validCatalog(root, {
        toolCount: names.length,
        toolNames: names,
      }),
      listedNames: names,
    });

    const { session } = await connectFake(root, harness);

    expect(session.provenance()).toMatchObject({
      toolCount: names.length,
      toolNames: [...names].sort(),
    });
    await session.close();
  });

  it('rejects catalog and listTools inventories that do not agree exactly', async () => {
    const root = temporaryRoot();
    const listedNames = TOOL_NAMES.map((name) =>
      name === 'compare_to_baseline' ? 'future_read_tool' : name,
    );
    const harness = fakeConnection(root, { listedNames });

    await expect(connectFake(root, harness)).rejects.toThrow(
      /get_agent_catalog\/listTools mismatch/u,
    );
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('rejects an oversized catalog response before parsing its embedded JSON', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, {
      catalogResult: textResult({ padding: 'x'.repeat(8192) }),
    });

    await expect(connectFake(root, harness, { maxResponseBytes: 4096 })).rejects.toThrow(
      /get_agent_catalog response exceeded the handshake byte ceiling/u,
    );
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['tool cardinality', Array.from({ length: 257 }, (_, index) => `tool_${String(index)}`)],
    ['tool-name length', [...TOOL_NAMES, 'x'.repeat(129)]],
  ] as const)('rejects listTools %s beyond the handshake bounds', async (_label, listedNames) => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, { listedNames });

    await expect(connectFake(root, harness)).rejects.toThrow(/invalid .*list/u);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('applies the response-byte ceiling to listTools as well as catalog JSON', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, {
      listedNames: [...TOOL_NAMES, 'x'.repeat(5000)],
    });

    await expect(connectFake(root, harness, { maxResponseBytes: 4096 })).rejects.toThrow(
      /listTools response exceeded the handshake byte ceiling/u,
    );
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('turns connect failures into prerequisite errors and closes best-effort', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, {
      connectError: new Error('offline'),
    });

    await expect(connectFake(root, harness)).rejects.toThrow(/Unable to connect.*offline/u);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('owns and cleans a unique default HOME even when connection construction fails', async () => {
    const root = temporaryRoot();
    let ownedHome: string | undefined;

    await expect(
      McpArmSession.connect({
        cliDistResolver: () => '/built/opensip.js',
        connectionFactory: (options) => {
          ownedHome = options.env.HOME;
          throw new Error('factory failed');
        },
        workspaceRoot: root,
      }),
    ).rejects.toThrow(/Unable to connect.*factory failed/u);

    expect(ownedHome).toContain('opensip-agent-eval-home-');
    expect(ownedHome === undefined ? true : existsSync(ownedHome)).toBe(false);
  });

  it('removes its unique default HOME after a successful session closes', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root);
    const { captured, session } = await connectFake(root, harness);
    const ownedHome = captured.env.HOME;

    expect(ownedHome).toContain('opensip-agent-eval-home-');
    expect(existsSync(ownedHome)).toBe(true);
    await session.close();
    expect(existsSync(ownedHome)).toBe(false);
  });
});

describe('McpArmSession tool record mapping', () => {
  it('retains facts, freshness, catalog identity, four-facet coverage, and UTF-8 bytes', async () => {
    const root = temporaryRoot();
    const payload = {
      context: {
        catalog: { identity: 'g1:fixture', status: 'loaded' },
        project: { root, scope: 'project' },
      },
      coverage: {
        complete: false,
        evidence: {
          complete: true,
          reasons: [],
          requested: true,
          truncated: false,
        },
        grouping: {
          complete: true,
          reasons: [],
          requested: false,
          truncated: false,
        },
        inventory: {
          complete: false,
          reasons: ['inventory-cap'],
          requested: true,
          truncated: true,
        },
        projection: {
          complete: true,
          reasons: [],
          requested: true,
          truncated: false,
        },
        reasons: ['inventory-cap'],
        truncated: true,
      },
      data: { symbols: [{ filePath: 'src/é.ts' }] },
      freshness: {
        fresh: false,
        reasonCode: 'source-changed',
        verification: 'complete',
      },
    };
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);
    const step = resolvedStep((value) => {
      const record = value as typeof payload;
      return [{ kind: 'file', path: record.data.symbols[0]?.filePath ?? '' }];
    });

    const record = await session.callTool(step);

    expect(record).toMatchObject({
      catalogIdentity: 'g1:fixture',
      completeness: 'incomplete',
      coverage: {
        complete: false,
        hardCapReasons: ['inventory-cap'],
        truncated: true,
      },
      facts: [{ kind: 'file', path: 'src/é.ts' }],
      freshness: {
        fresh: false,
        reasonCode: 'source-changed',
        verification: 'complete',
      },
      noneOutcome: 'nonempty',
      truncated: true,
    });
    expect(record.coverage?.facets).toContainEqual({
      complete: false,
      hardCapReasons: ['inventory-cap'],
      name: 'inventory',
      requested: true,
      truncated: true,
    });
    expect(record.responseBytes).toBe(Buffer.byteLength(JSON.stringify(payload), 'utf8'));
    await session.close();
  });

  it('retains a next cursor and refuses to classify the page as exhaustive', async () => {
    const root = temporaryRoot();
    const payload = {
      ...graphPayload(root, { symbols: [] }),
      page: { limit: 20, nextCursor: 'r1:more' },
    };
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);

    const record = await session.callTool(resolvedStep(() => []));

    expect(record).toMatchObject({
      completeness: 'incomplete',
      nextCursor: 'r1:more',
      noneOutcome: 'empty-incomplete',
    });
    await session.close();
  });

  it('redacts workspace and host-temp prefixes from durable extractor failures', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, {
      toolResults: [textResult(graphPayload(root, { symbols: [] }))],
    });
    const { session } = await connectFake(root, harness);
    const record = await session.callTool(
      resolvedStep(() => {
        throw new Error(`extractor leaked ${root} from ${tmpdir()}`);
      }),
    );

    expect(record).toMatchObject({
      failure: {
        code: 'mcp-extractor-failure',
        message: expect.stringContaining('[redacted-path]'),
      },
      noneOutcome: 'failed',
    });
    expect(record.failure?.message).not.toContain(root);
    expect(record.failure?.message).not.toContain(tmpdir());
    await session.close();
  });

  it.each(['missing freshness', 'missing coverage facet'] as const)(
    'fails graph results with %s instead of trusting absence',
    async (label) => {
      const root = temporaryRoot();
      const complete = graphPayload(root, { symbols: [] });
      const payload =
        label === 'missing freshness'
          ? { ...complete, freshness: undefined }
          : {
              ...complete,
              coverage: { ...COMPLETE_COVERAGE, projection: undefined },
            };
      const harness = fakeConnection(root, {
        toolResults: [textResult(payload)],
      });
      const { session } = await connectFake(root, harness);
      const extract = vi.fn(() => []);

      const record = await session.callTool(resolvedStep(extract));

      expect(record).toMatchObject({
        failure: { code: 'invalid-graph-envelope', kind: 'protocol' },
        noneOutcome: 'failed',
      });
      expect(extract).not.toHaveBeenCalled();
      await session.close();
    },
  );

  it('accepts an honest missing-catalog graph envelope without treating it as malformed', async () => {
    const root = temporaryRoot();
    const payload = {
      ...graphPayload(root, { symbols: [] }),
      context: {
        catalog: { status: 'missing' },
        project: { root, scope: 'project' },
      },
      freshness: {
        fresh: false,
        reasonCode: 'missing',
        verification: 'missing',
      },
    };
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);

    const record = await session.callTool(resolvedStep(() => []));

    expect(record.failure).toBeUndefined();
    expect(record.catalogIdentity).toBeUndefined();
    expect(record).toMatchObject({
      completeness: 'incomplete',
      noneOutcome: 'empty-incomplete',
    });
    expect(record.freshness).toEqual({
      fresh: false,
      reasonCode: 'missing',
      verification: 'missing',
    });
    await session.close();
  });

  it('rejects inconsistent graph coverage rollups atomically', async () => {
    const root = temporaryRoot();
    const payload = {
      ...graphPayload(root, { symbols: [] }),
      coverage: {
        ...COMPLETE_COVERAGE,
        inventory: { ...COMPLETE_COVERAGE.inventory, complete: false },
      },
    };
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);

    const record = await session.callTool(resolvedStep(() => []));

    expect(record.failure?.code).toBe('invalid-graph-envelope');
    await session.close();
  });

  it('validates refresh_graph with the same graph-envelope trust contract', async () => {
    const root = temporaryRoot();
    const payload = {
      ...graphPayload(root, { action: 'rebuilt' }),
      freshness: undefined,
    };
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);
    const extract = vi.fn(() => []);

    const record = await session.callTool({
      ...resolvedStep(extract),
      tool: 'refresh_graph',
    });

    expect(record.failure?.code).toBe('invalid-graph-envelope');
    expect(extract).not.toHaveBeenCalled();
    await session.close();
  });

  it.each(['impact_files', 'select_tests'] as const)(
    'validates %s with the graph-envelope trust contract',
    async (tool) => {
      const root = temporaryRoot();
      const payload = { ...graphPayload(root, {}), coverage: undefined };
      const harness = fakeConnection(root, {
        toolResults: [textResult(payload)],
      });
      const { session } = await connectFake(root, harness);
      const extract = vi.fn(() => []);

      const record = await session.callTool({ ...resolvedStep(extract), tool });

      expect(record.failure?.code).toBe('invalid-graph-envelope');
      expect(extract).not.toHaveBeenCalled();
      await session.close();
    },
  );

  it.each([
    ['missing', undefined],
    [
      'inconsistent',
      {
        coverage: 'full',
        fallback: 'targeted',
        fullyVerified: false,
        uncertainties: [],
      },
    ],
    [
      'malformed uncertainty',
      {
        coverage: 'unknown',
        fallback: 'targeted',
        fullyVerified: false,
        uncertainties: [{ code: 'unknown-code', message: 'unknown', source: 'catalog' }],
      },
    ],
  ] as const)('rejects %s nested impact trust before extraction', async (_label, trust) => {
    const root = temporaryRoot();
    const payload = graphPayload(root, {
      impactedFiles: ['src/caller.ts'],
      impactedFunctions: [],
      impactedPackages: [],
      ...(trust === undefined ? {} : { trust }),
    });
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);
    const extract = vi.fn(() => [{ kind: 'file' as const, path: 'src/caller.ts' }]);

    const record = await session.callTool({
      ...resolvedStep(extract),
      tool: 'impact_files',
    });

    expect(record.failure?.code).toBe('invalid-graph-envelope');
    expect(extract).not.toHaveBeenCalled();
    await session.close();
  });

  it('records honest unverified impact as incomplete while retaining positive facts', async () => {
    const root = temporaryRoot();
    const payload = graphPayload(root, {
      impactedFiles: ['src/caller.ts'],
      impactedFunctions: [],
      impactedPackages: [],
      trust: {
        coverage: 'unknown',
        fallback: 'targeted',
        fullyVerified: false,
        uncertainties: [
          {
            code: 'graph-catalog-approximate',
            message: 'The graph contains approximate evidence.',
            source: 'catalog',
          },
        ],
      },
    });
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);

    const record = await session.callTool({
      ...resolvedStep(extractImpactFiles),
      tool: 'impact_files',
    });

    expect(record).toMatchObject({
      completeness: 'incomplete',
      facts: [{ kind: 'file', path: 'src/caller.ts', role: 'impacted' }],
      failure: undefined,
      noneOutcome: 'nonempty',
    });
    expect(record.coverage).toMatchObject({
      complete: false,
      hardCapReasons: ['graph-catalog-approximate'],
    });
    expect(record.coverage?.facets).toContainEqual(
      expect.objectContaining({
        complete: false,
        hardCapReasons: ['graph-catalog-approximate'],
        name: 'projection',
        requested: true,
      }),
    );
    await session.close();
  });

  it('projects impact facts normally when nested trust is fully verified', async () => {
    const root = temporaryRoot();
    const payload = graphPayload(root, {
      impactedFiles: ['src/caller.ts'],
      impactedFunctions: [],
      impactedPackages: [],
      trust: {
        coverage: 'full',
        fallback: 'targeted',
        fullyVerified: true,
        uncertainties: [],
      },
    });
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);

    const record = await session.callTool({
      ...resolvedStep(extractImpactFiles),
      tool: 'impact_files',
    });

    expect(record).toMatchObject({
      completeness: 'complete',
      facts: [{ kind: 'file', path: 'src/caller.ts', role: 'impacted' }],
      failure: undefined,
      noneOutcome: 'nonempty',
    });
    await session.close();
  });

  it('rejects a select_tests graph identity that differs from its outer catalog', async () => {
    const root = temporaryRoot();
    const payload = graphPayload(root, { graphIdentity: 'g1:stale' });
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);
    const extract = vi.fn(() => []);

    const record = await session.callTool({
      ...resolvedStep(extract),
      tool: 'select_tests',
    });

    expect(record.failure?.code).toBe('invalid-graph-envelope');
    expect(extract).not.toHaveBeenCalled();
    await session.close();
  });

  it('retains file-context inventory coverage and rejects malformed codebase metadata', async () => {
    const root = temporaryRoot();
    const valid = {
      status: 'found',
      file: { path: 'package.json' },
      inventoryIdentity: 'i1:fixture',
      project: { configIdentity: 'sha256:fixture', workspacePatterns: [] },
      coverage: { status: 'complete', reasonCodes: [], observed: 4, total: 4 },
      freshness: {
        capturedAt: '2026-07-13T00:00:00.000Z',
        fresh: true,
        reasonCodes: [],
        verification: 'complete',
      },
      reasonCodes: [],
      nextActions: [],
    };
    const harness = fakeConnection(root, {
      toolResults: [textResult(valid), textResult({ ...valid, freshness: undefined })],
    });
    const { session } = await connectFake(root, harness);
    const step = {
      ...resolvedStep(() => [{ kind: 'file', path: 'package.json' }]),
      tool: 'get_file_context',
    };

    const record = await session.callTool(step);
    expect(record).toMatchObject({
      completeness: 'complete',
      coverage: { complete: true, truncated: false },
      freshness: { fresh: true, verification: 'complete' },
      noneOutcome: 'nonempty',
    });

    const malformed = await session.callTool(step);
    expect(malformed.failure?.code).toBe('invalid-codebase-envelope');
    await session.close();
  });

  it('validates runtime-wiring trust metadata independently from graph envelopes', async () => {
    const root = temporaryRoot();
    const payload = {
      context: {
        project: { root, scope: 'project' },
        runtime: {
          capturedAt: '2026-07-12T00:00:00Z',
          identity: 'w1:fixture',
          kind: 'runtime-wiring',
        },
      },
      coverage: {
        complete: true,
        reasons: [],
        scope: 'captured-admitted-registry-and-command-inventory',
        truncated: false,
      },
      edges: [],
      groupTruncated: false,
      nodes: [],
      page: { edgeTruncated: false, hasMore: false, limit: 20 },
    };
    const harness = fakeConnection(root, {
      toolResults: [textResult(payload)],
    });
    const { session } = await connectFake(root, harness);

    const record = await session.callTool({
      ...resolvedStep(() => []),
      tool: 'get_runtime_wiring',
    });

    expect(record).toMatchObject({
      completeness: 'complete',
      coverage: { complete: true, truncated: false },
      failure: undefined,
    });
    await session.close();
  });

  it.each([
    ['edge', { edgeTruncated: true, groupTruncated: false }],
    ['group', { edgeTruncated: false, groupTruncated: true }],
  ] as const)(
    'rejects %s truncation hidden by a complete runtime rollup',
    async (_label, flags) => {
      const root = temporaryRoot();
      const payload = {
        context: {
          project: { root, scope: 'project' },
          runtime: {
            capturedAt: 'now',
            identity: 'w1:fixture',
            kind: 'runtime-wiring',
          },
        },
        coverage: {
          complete: true,
          reasons: [],
          scope: 'captured-admitted-registry-and-command-inventory',
          truncated: false,
        },
        groupTruncated: flags.groupTruncated,
        page: { edgeTruncated: flags.edgeTruncated, hasMore: false, limit: 20 },
      };
      const harness = fakeConnection(root, {
        toolResults: [textResult(payload)],
      });
      const { session } = await connectFake(root, harness);

      const record = await session.callTool({
        ...resolvedStep(() => []),
        tool: 'get_runtime_wiring',
      });

      expect(record.failure?.code).toBe('invalid-runtime-envelope');
      await session.close();
    },
  );

  it.each([
    ['missing content', {}],
    ['non-text content', { content: [{ data: 'abc', type: 'image' }] }],
    ['invalid JSON', { content: [{ text: 'not-json', type: 'text' }] }],
    ['SDK tool error', textResult({ error: { code: 'bad' } }, true)],
  ])('records %s as a failed step without calling the extractor', async (_label, result) => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, { toolResults: [result] });
    const { session } = await connectFake(root, harness);
    const extract = vi.fn(() => [{ kind: 'file' as const, path: 'wrong.ts' }]);

    const record = await session.callTool(resolvedStep(extract));

    expect(record.failure).toBeDefined();
    expect(record.facts).toEqual([]);
    expect(record.noneOutcome).toBe('failed');
    expect(extract).not.toHaveBeenCalled();
    await session.close();
  });

  it('records extractor exceptions as protocol failures', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, {
      toolResults: [textResult(graphPayload(root, {}))],
    });
    const { session } = await connectFake(root, harness);

    const record = await session.callTool(
      resolvedStep(() => {
        throw new Error('shape drift');
      }),
    );

    expect(record).toMatchObject({
      failure: { code: 'mcp-extractor-failure', kind: 'protocol' },
      noneOutcome: 'failed',
    });
    await session.close();
  });

  it('fails and bounds over-ceiling responses', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, {
      toolResults: [
        {
          content: [{ text: JSON.stringify({ data: 'é'.repeat(5000) }), type: 'text' }],
        },
      ],
    });
    const { session } = await connectFake(root, harness, {
      maxResponseBytes: 4096,
    });

    const record = await session.callTool(resolvedStep());

    expect(record).toMatchObject({
      failure: { code: 'mcp-response-limit' },
      truncated: true,
    });
    expect(record.responseBytes).toBeLessThanOrEqual(4096);
    expect(record.responseBytes).toBeGreaterThan(0);
    await session.close();
  });

  it('surfaces a dead server as a prerequisite error', async () => {
    const root = temporaryRoot();
    const harness = fakeConnection(root, {
      toolResults: [],
    });
    const original = harness.connection.callTool.bind(harness.connection);
    let calls = 0;
    harness.connection.callTool = (input, timeoutMs) => {
      calls += 1;
      if (calls === 1) return original(input, timeoutMs);
      return Promise.reject(new Error('transport closed'));
    };
    const { session } = await connectFake(root, harness);

    await expect(session.invoker()(resolvedStep())).rejects.toThrow(
      /became unavailable.*transport closed/u,
    );
    await session.close();
  });
});
