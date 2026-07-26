import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_BASELINE_IDENTITY,
  EXIT_CODES,
  buildTaskContextFileScope,
  mapToolErrorToExitCode,
  type SignalEnvelope,
  type SuiteStepSummary,
} from '@opensip-cli/contracts';
import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  PluginIncompatibleError,
  RunScope,
  SystemError,
  TimeoutError,
  ValidationError,
  currentScope,
  defineCommand,
  ok,
  runWithScope,
  type EvidenceSnapshotContribution,
  type Tool,
  type ToolCliContext,
  type ToolError,
  type ToolProvenance,
  type ToolRunCompletion,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { commitEvidenceBundle, RunRepo, SessionRepo } from '@opensip-cli/session-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeDispatchHostCtx } from '../../../__tests__/harness/dispatch-host-ctx.js';
import {
  createRunActionHooks,
  createRunPlaneFactory,
  type RunActionHooks,
  type RunPlaneDeps,
} from '../../../bootstrap/run-plane.js';
import { hostErrorCatalog } from '../../../errors/host-error-catalog.js';
import { runCommandSpecAction } from '../../run-command-spec-action.js';
import {
  BUILT_IN_AGENT_CONTEXT_PLANES,
  BUILT_IN_AGENT_CONTEXT_SUITE,
  BUILT_IN_GRAPH_PACKAGE_NAME,
  BUILT_IN_GRAPH_TOOL_ID,
} from '../built-in-suites.js';
import { deriveSuiteAggregate, runSuite, type RunSuiteInput } from '../orchestrator.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const SUITE_INVALID = hostErrorCatalog.require('CLI.SUITE.INVALID');

const dispatchSpy = vi.hoisted(() => vi.fn());
const loadCapabilitiesSpy = vi.hoisted(() => vi.fn().mockResolvedValue(0));
vi.mock('../../../bootstrap/dispatch-external-tool-command.js', () => ({
  dispatchExternalToolCommand: (args: unknown) => dispatchSpy(args),
}));
vi.mock('../../../bootstrap/load-tool-capabilities.js', () => ({
  loadOwningToolCapabilities: (args: unknown) => loadCapabilitiesSpy(args),
}));

const TOOL_ID = '00000000-0000-4000-8000-000000000111';
const OTHER_TOOL_ID = '00000000-0000-4000-8000-000000000222';
const EXTERNAL_TOOL_ID = '00000000-0000-4000-8000-000000000333';
const CONTEXT_INVENTORY_ID = `i1:${'1'.repeat(64)}`;
const CONTEXT_GRAPH_ID = `g1:${'2'.repeat(64)}`;
const CONTEXT_SELECTION_ID = `ts1:${'3'.repeat(64)}`;
const tempDirs: string[] = [];

function suiteRunHooks(
  overrides: RunActionHooks = {},
  deps: Partial<RunPlaneDeps> = {},
): RunActionHooks {
  const base = createRunActionHooks(
    createRunPlaneFactory({
      getDatastore: () => currentScope()?.datastore() as DataStore | undefined,
      ...deps,
    }),
  );
  return {
    ...base,
    ...overrides,
    resetRun: () => {
      base.resetRun?.();
      overrides.resetRun?.();
    },
    completeRun: (value) => {
      base.completeRun?.(value);
      overrides.completeRun?.(value);
    },
  };
}

function sessionCommand(
  name: string,
  beforeReturn?: (
    opts: Readonly<Record<string, unknown>>,
    cli: ToolCliContext,
  ) => void | Promise<void>,
): NonNullable<Tool['commandSpecs']>[number] {
  return defineCommand<unknown, ToolCliContext>({
    name,
    description: 'fixture session producer',
    commonFlags: ['cwd', 'open'],
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'host-orchestrated-evidence',
    producesVerdict: true,
    handler: async (opts, cli) => {
      const commandOptions = opts as Readonly<Record<string, unknown>>;
      await beforeReturn?.(commandOptions, cli);
      const envelope = signalEnvelope({ passed: true, findings: 0 });
      cli.emitEnvelope(envelope);
      return {
        envelope,
        session: {
          tool: 'fit',
          cwd: typeof commandOptions.cwd === 'string' ? commandOptions.cwd : '/repo',
          score: 100,
          passed: true,
          payload: { __version: 1, command: name },
        },
      } satisfies ToolRunCompletion;
    },
  });
}

function contextSnapshotId(kind: (typeof BUILT_IN_AGENT_CONTEXT_PLANES)[number]['kind']): string {
  if (kind === 'inventory') return CONTEXT_INVENTORY_ID;
  if (kind === 'graph') return CONTEXT_GRAPH_ID;
  return CONTEXT_SELECTION_ID;
}

function contextSnapshotKind(id: string): 'inventory' | 'test-selection' | undefined {
  if (id === CONTEXT_INVENTORY_ID) return 'inventory';
  if (id === CONTEXT_SELECTION_ID) return 'test-selection';
  return undefined;
}

function contextPointerGraphScope(options: { readonly evictAfterValidation?: boolean } = {}) {
  let inventoryReads = 0;
  return {
    contextCatalog: {
      generationIdentity: () => ok(CONTEXT_GRAPH_ID),
    },
    contextSnapshots: {
      get: (id: string) => {
        const kind = contextSnapshotKind(id);
        let evicted = false;
        if (kind === 'inventory') {
          inventoryReads += 1;
          evicted = options.evictAfterValidation === true && inventoryReads > 1;
        }
        if (kind !== undefined && !evicted) {
          return {
            id,
            kind,
            schemaVersion: 1,
            producerVersion: '0.6.0',
            createdAt: '2026-07-13T00:00:00.000Z',
            sourceIdentity: 'fixture-source',
            configIdentity: 'fixture-config',
            byteCount: 2,
            payload: {},
          };
        }
        return null;
      },
    },
  };
}

function tool(id: string, name: string, specs: Tool['commandSpecs']): Tool {
  return {
    identity: { name },
    metadata: {
      id,
      name,
      version: '0.0.0',
      description: 'fixture',
    },
    commands: (specs ?? []).map((spec) => ({
      name: spec.name,
      description: spec.description,
    })),
    commandSpecs: specs,
  };
}

function helpCommand(
  name: string,
  handler: (opts: unknown, cli: ToolCliContext) => { type: 'help' } | Promise<{ type: 'help' }>,
): NonNullable<Tool['commandSpecs']>[number] {
  return defineCommand<unknown, ToolCliContext>({
    name,
    description: 'fixture',
    commonFlags: [],
    scope: 'project',
    output: 'command-result',
    producesVerdict: true,
    handler,
  });
}

function evidenceCommand(
  name: string,
  handler: (opts: unknown, cli: ToolCliContext) => unknown,
): NonNullable<Tool['commandSpecs']>[number] {
  return defineCommand<unknown, ToolCliContext>({
    name,
    description: 'fixture evidence producer',
    commonFlags: [],
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'host-orchestrated-evidence',
    producesEvidenceSnapshot: true,
    handler,
  });
}

function contextContribution(
  kind: (typeof BUILT_IN_AGENT_CONTEXT_PLANES)[number]['kind'],
  command: string,
): ToolRunCompletion {
  const snapshotId = contextSnapshotId(kind);
  const contribution: EvidenceSnapshotContribution = {
    schemaVersion: 1,
    kind,
    snapshotId,
    snapshotSchemaVersion: kind === 'graph' ? 3 : 1,
    producer: { toolId: BUILT_IN_GRAPH_TOOL_ID, command, version: '0.6.0' },
    status: 'rebuilt',
    freshness: { status: 'current' },
    coverage: { status: 'complete', items: 1, total: 1 },
    ...(kind === 'test-selection'
      ? {
          inputs: [
            { kind: 'inventory', snapshotId: CONTEXT_INVENTORY_ID },
            { kind: 'graph', snapshotId: CONTEXT_GRAPH_ID },
          ],
        }
      : {}),
  };
  return { evidenceSnapshots: [contribution] };
}

function contextGraphTool(observeOpts?: (opts: Readonly<Record<string, unknown>>) => void): Tool {
  const commandSpecs = BUILT_IN_AGENT_CONTEXT_PLANES.map((plane) =>
    defineCommand<unknown, ToolCliContext>({
      name: plane.command,
      visibility: 'internal',
      description: 'fixture context producer',
      commonFlags: ['cwd'],
      ...(plane.kind === 'test-selection'
        ? {
            options: [
              {
                flag: '--files',
                value: '<path>',
                description: 'files',
                arrayDefault: [],
                parse: (raw: string, prior: unknown) => [
                  ...(Array.isArray(prior) ? prior : []),
                  raw,
                ],
              },
            ],
          }
        : {}),
      staticHandler: {
        package: BUILT_IN_GRAPH_PACKAGE_NAME,
        path: 'packages/graph/engine/src/cli/context/context-command-specs.ts',
        declaration: plane.declaration,
      },
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'host-orchestrated-evidence',
      producesEvidenceSnapshot: true,
      handler: (opts) => {
        observeOpts?.(opts as Readonly<Record<string, unknown>>);
        return contextContribution(plane.kind, plane.command);
      },
    }),
  );
  return {
    ...tool(BUILT_IN_GRAPH_TOOL_ID, 'graph', commandSpecs),
    metadata: {
      id: BUILT_IN_GRAPH_TOOL_ID,
      name: 'graph',
      version: '0.6.0',
      description: 'fixture',
    },
  };
}

function signalEnvelope(input: {
  readonly tool?: SignalEnvelope['tool'];
  readonly passed: boolean;
  readonly faulted?: boolean;
  readonly errors?: number;
  readonly warnings?: number;
  readonly findings?: number;
  readonly ruleId?: string;
  readonly message?: string;
  readonly filePath?: string;
  readonly metadata?: Record<string, unknown>;
}): SignalEnvelope {
  const errors = input.errors ?? 0;
  const warnings = input.warnings ?? 0;
  const findings = input.findings ?? errors + warnings;
  const signals = Array.from({ length: findings }, (_, index) => ({
    id: `sig_${index}`,
    source: 'fixture-check',
    provider: 'fixture',
    severity: index < errors ? 'high' : 'low',
    category: 'quality',
    ruleId: input.ruleId ?? 'fixture-rule',
    message: input.message ?? `fixture finding ${index}`,
    filePath: input.filePath ?? 'src/fixture.ts',
    metadata: input.metadata ?? {},
    fingerprint: `${input.ruleId ?? 'fixture-rule'}|${input.filePath ?? 'src/fixture.ts'}|${index + 1}|0`,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  return {
    schemaVersion: 2,
    tool: input.tool ?? 'fit',
    runId: `run-${input.tool ?? 'fit'}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      score: input.passed ? 100 : 0,
      passed: input.passed,
      ...(input.faulted === undefined ? {} : { faulted: input.faulted }),
      summary: {
        total: 1,
        passed: input.passed ? 1 : 0,
        failed: input.passed ? 0 : 1,
        errors,
        warnings,
      },
    },
    units: [],
    signals,
    baselineIdentity: DEFAULT_BASELINE_IDENTITY,
  } as SignalEnvelope;
}

function emitPassingEvidence(cli: ToolCliContext): void {
  cli.emitEnvelope(signalEnvelope({ passed: true, findings: 0 }));
}

function externalProvenance(): ToolProvenance {
  return {
    source: 'installed',
    id: 'external-fixture',
    stableId: EXTERNAL_TOOL_ID,
    version: '0.0.0',
    manifestHash: 'hash',
  };
}

afterEach(() => {
  dispatchSpy.mockReset();
  loadCapabilitiesSpy.mockReset();
  loadCapabilitiesSpy.mockResolvedValue(0);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(cwd: string, relative: string, content: string): void {
  const path = join(cwd, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeChangedGitFixture(): string {
  const dir = makeTempDir('suite-orchestrator-git-');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'suite-orchestrator@example.test']);
  git(dir, ['config', 'user.name', 'Suite Orchestrator Test']);
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'initial']);
  write(dir, 'src/a.ts', 'export const a = 2;\n');
  write(dir, 'src/b.ts', 'export const b = 1;\n');
  return dir;
}

describe('runSuite', () => {
  it('does not grant a forged configured agent-context source built-in aggregation authority', async () => {
    const spec = helpCommand('fit', (_opts, cli) => {
      emitPassingEvidence(cli);
      return { type: 'help' };
    });

    const result = await runWithScope(new RunScope({ toolProvenance: [] }), () =>
      runSuite({
        name: 'agent-context',
        suite: { steps: [{ tool: TOOL_ID, command: 'fit' }] },
        source: 'configured',
        tools: [tool(TOOL_ID, 'fitness', [spec])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: { files: ['src/configured-suite-input.ts'] },
      }),
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(result.contextManifest).toBeUndefined();
    expect(result.reviewBrief).toBeDefined();
  });

  it.each([
    { suiteOpts: { changed: true }, defaultChanged: false },
    { suiteOpts: { since: 'origin/main' }, defaultChanged: false },
    { suiteOpts: {}, defaultChanged: true },
  ])(
    'rejects deferred Git selectors for the built-in agent-context suite',
    async ({ suiteOpts, defaultChanged }) => {
      await expect(
        runWithScope(new RunScope({}), () =>
          runSuite({
            name: 'agent-context',
            suite: BUILT_IN_AGENT_CONTEXT_SUITE,
            source: 'built-in',
            tools: [contextGraphTool()],
            ctx: makeDispatchHostCtx().ctx,
            runActionHooks: suiteRunHooks(),
            suiteOpts,
            defaultChanged,
          }),
        ),
      ).rejects.toMatchObject({
        name: 'ConfigurationError',
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'context-selector' },
      });
    },
  );

  it('fails with a typed configuration error when the built-in context root cannot be canonicalized', async () => {
    const graph = contextGraphTool();
    const scope = new RunScope({
      toolProvenance: [
        {
          source: 'bundled',
          id: 'graph',
          stableId: BUILT_IN_GRAPH_TOOL_ID,
          version: '0.6.0',
          packageName: BUILT_IN_GRAPH_PACKAGE_NAME,
          manifestHash: 'fixture-manifest-hash',
        },
      ],
    });
    Object.assign(scope, {
      projectContext: {
        projectRoot: join(makeTempDir('suite-orchestrator-missing-'), 'missing'),
        scope: 'project',
      },
    });

    await expect(
      runWithScope(scope, () =>
        runSuite({
          name: 'agent-context',
          suite: BUILT_IN_AGENT_CONTEXT_SUITE,
          source: 'built-in',
          tools: [graph],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: {},
        }),
      ),
    ).rejects.toMatchObject({
      name: 'ConfigurationError',
      code: SUITE_INVALID.code,
      definition: SUITE_INVALID,
      metadata: { condition: 'context-project-root' },
    });
  });

  it('builds trusted context only from exact bundled contributions without persisting or logging file args', async () => {
    const physicalCwd = makeChangedGitFixture();
    const linkParent = makeTempDir('suite-orchestrator-link-');
    const cwd = join(linkParent, 'project-link');
    symlinkSync(physicalCwd, cwd, process.platform === 'win32' ? 'junction' : 'dir');
    const privatePath = 'src/private-customer-task.ts';
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const observedCwds: unknown[] = [];
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const graph = contextGraphTool((opts) => observedCwds.push(opts.cwd));
    const scope = new RunScope({
      datastore: () => datastore,
      logger: { info, warn, error, debug: vi.fn() },
      toolProvenance: [
        {
          source: 'bundled',
          id: 'graph',
          stableId: BUILT_IN_GRAPH_TOOL_ID,
          version: '0.6.0',
          packageName: BUILT_IN_GRAPH_PACKAGE_NAME,
          manifestHash: 'fixture-manifest-hash',
        },
      ],
    });
    Object.assign(scope, {
      projectContext: { projectRoot: cwd, scope: 'project' },
      graph: contextPointerGraphScope(),
    });
    let snapshots: readonly EvidenceSnapshotContribution[] = [];
    const runActionHooks = suiteRunHooks({
      resetRun: () => {
        snapshots = [];
      },
      completeRun: (value: unknown) => {
        snapshots = (value as ToolRunCompletion | undefined)?.evidenceSnapshots ?? [];
      },
      currentEvidenceSnapshots: () => snapshots,
    });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'agent-context',
          suite: BUILT_IN_AGENT_CONTEXT_SUITE,
          source: 'built-in',
          tools: [graph],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks,
          suiteOpts: { cwd, files: [privatePath] },
        }),
      );

      expect(result.contextManifest).toMatchObject({
        readiness: 'ready',
        inventoryIdentity: CONTEXT_INVENTORY_ID,
        graphIdentity: CONTEXT_GRAPH_ID,
        fileScope: buildTaskContextFileScope([privatePath]),
      });
      expect(result.contextManifest?.planes).toHaveLength(3);
      expect(JSON.stringify(result)).not.toContain(privatePath);
      const persisted = new RunRepo(datastore).listStepsForRun(result.runId ?? '');
      expect(persisted).toHaveLength(3);
      expect(persisted.every((step) => step.effectiveArgs?.files === undefined)).toBe(true);
      expect(observedCwds).toEqual(Array.from({ length: 3 }, () => realpathSync(cwd)));
      expect(new RunRepo(datastore).getRun(result.runId ?? '')?.cwd).toBe(realpathSync(cwd));
      const serializedLogs = JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls]);
      expect(serializedLogs).not.toContain(privatePath);
    } finally {
      datastore.close();
    }
  });

  it('withholds a ready ledger when a pointer disappears before the locked commit check', async () => {
    const cwd = makeChangedGitFixture();
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const graph = contextGraphTool();
    const scope = new RunScope({
      datastore: () => datastore,
      toolProvenance: [
        {
          source: 'bundled',
          id: 'graph',
          stableId: BUILT_IN_GRAPH_TOOL_ID,
          version: '0.6.0',
          packageName: BUILT_IN_GRAPH_PACKAGE_NAME,
          manifestHash: 'fixture-manifest-hash',
        },
      ],
    });
    Object.assign(scope, {
      projectContext: { projectRoot: cwd, scope: 'project' },
      graph: contextPointerGraphScope({ evictAfterValidation: true }),
    });
    let snapshots: readonly EvidenceSnapshotContribution[] = [];

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'agent-context',
          suite: BUILT_IN_AGENT_CONTEXT_SUITE,
          source: 'built-in',
          tools: [graph],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks({
            resetRun: () => {
              snapshots = [];
            },
            completeRun: (value: unknown) => {
              snapshots = (value as ToolRunCompletion | undefined)?.evidenceSnapshots ?? [];
            },
            currentEvidenceSnapshots: () => snapshots,
          }),
          suiteOpts: { cwd, files: ['src/a.ts'] },
        }),
      );

      expect(result).toMatchObject({
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        contextManifest: {
          readiness: 'unavailable',
          reasonCodes: expect.arrayContaining(['ledger-persist-failed']),
        },
      });
      expect(result.runId).toBeUndefined();
      expect(new RunRepo(datastore).listRuns()).toEqual([]);
    } finally {
      datastore.close();
    }
  });

  it.each(['transaction-rollback', 'owner-poison', 'datastore-unavailable'] as const)(
    'fails agent-context closed without a child or parent prefix: %s',
    async (failure) => {
      const cwd = makeChangedGitFixture();
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      const graph = contextGraphTool();
      const scope = new RunScope({
        datastore: () => datastore,
        toolProvenance: [
          {
            source: 'bundled',
            id: 'graph',
            stableId: BUILT_IN_GRAPH_TOOL_ID,
            version: '0.6.0',
            packageName: BUILT_IN_GRAPH_PACKAGE_NAME,
            manifestHash: 'fixture-manifest-hash',
          },
        ],
      });
      Object.assign(scope, {
        projectContext: { projectRoot: cwd, scope: 'project' },
        graph: contextPointerGraphScope(),
      });
      let deps: Partial<RunPlaneDeps>;
      if (failure === 'transaction-rollback') {
        deps = {
          commitEvidence: () => ({ status: 'failed', reason: 'write-failed' }),
        };
      } else if (failure === 'owner-poison') {
        deps = { evidenceLimits: { maxBytes: 1 } };
      } else {
        deps = { getDatastore: () => undefined };
      }

      try {
        const result = await runWithScope(scope, () =>
          runSuite({
            name: 'agent-context',
            suite: BUILT_IN_AGENT_CONTEXT_SUITE,
            source: 'built-in',
            tools: [graph],
            ctx: makeDispatchHostCtx().ctx,
            runActionHooks: suiteRunHooks({}, deps),
            suiteOpts: { cwd, files: ['src/a.ts'] },
          }),
        );

        expect(result.exitCode).toBeGreaterThanOrEqual(EXIT_CODES.RUNTIME_ERROR);
        expect(result.runId).toBeUndefined();
        expect(result.contextManifest).toMatchObject({
          readiness: 'unavailable',
          reasonCodes: expect.arrayContaining(['ledger-persist-failed']),
          nextActions: ['opensip suite run agent-context --files <same-explicit-files> --json'],
        });
        expect(new RunRepo(datastore).listRuns()).toEqual([]);
        expect(new SessionRepo(datastore).count()).toBe(0);
      } finally {
        datastore.close();
      }
    },
  );

  it('returns the authoritative persisted run ID from the single ledger transaction', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const spec = helpCommand('fit', (_opts, cli) => {
      emitPassingEvidence(cli);
      return { type: 'help' };
    });
    const scope = new RunScope({ datastore: () => datastore });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'audit',
          suite: { steps: [{ tool: TOOL_ID, command: 'fit' }] },
          source: 'built-in',
          tools: [tool(TOOL_ID, 'fitness', [spec])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      const runs = new RunRepo(datastore).listRuns();
      expect(runs).toHaveLength(1);
      expect(result.runId).toBe(runs[0]?.id);
      expect(runs[0]?.legacySuiteRunId).toBe(result.suiteRunId);
    } finally {
      datastore.close();
    }
  });

  it('accepts a return-only in-process envelope in human mode as complete verdict evidence', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const envelope = signalEnvelope({ passed: true, findings: 0 });
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'return-envelope',
      description: 'return-only envelope fixture',
      commonFlags: [],
      scope: 'project',
      output: 'signal-envelope',
      producesVerdict: true,
      handler: () => envelope,
    });

    try {
      const result = await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runSuite({
          name: 'return-only-suite',
          suite: { steps: [{ tool: TOOL_ID, command: spec.name }] },
          tools: [tool(TOOL_ID, 'fitness', [spec])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        outcome: 'passed',
        verdict: { passed: true, errors: 0, warnings: 0, findings: 0 },
      });
      const persisted = new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0];
      expect(persisted?.evidence).toMatchObject({
        kind: 'signal-envelope',
        runId: envelope.runId,
      });
    } finally {
      datastore.close();
    }
  });

  it('commits every accepted child Session and the parent in preallocated step order', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const first = sessionCommand('first');
    const second = sessionCommand('second');
    const scope = new RunScope({ datastore: () => datastore });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'atomic-suite',
          suite: {
            steps: [
              { tool: TOOL_ID, command: first.name },
              { tool: TOOL_ID, command: second.name },
            ],
          },
          tools: [tool(TOOL_ID, 'fitness', [first, second])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks({}, { evidenceLimits: { maxSessions: 2 } }),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.runId).toMatch(/^RUN_/u);
      const sessions = new SessionRepo(datastore).list();
      const steps = new RunRepo(datastore).listStepsForRun(result.runId!);
      expect(sessions).toHaveLength(2);
      expect(steps.map((step) => step.command)).toEqual(['first', 'second']);
      expect(steps.map((step) => step.ordinal)).toEqual([0, 1]);
      expect(steps.every((step) => sessions.some((session) => session.id === step.sessionId))).toBe(
        true,
      );
    } finally {
      datastore.close();
    }
  });

  it('rolls back every staged child Session and its parent without changing an ordinary suite verdict', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const first = sessionCommand('first');
    const second = sessionCommand('second');
    const commitEvidence = vi.fn<typeof commitEvidenceBundle>(() => ({
      status: 'failed',
      reason: 'write-failed',
    }));
    const scope = new RunScope({ datastore: () => datastore });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'rollback-suite',
          suite: {
            steps: [
              { tool: TOOL_ID, command: first.name },
              { tool: TOOL_ID, command: second.name },
            ],
          },
          tools: [tool(TOOL_ID, 'fitness', [first, second])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks({}, { commitEvidence }),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(result.runId).toBeUndefined();
      expect(commitEvidence).toHaveBeenCalledOnce();
      const attemptedBundle = commitEvidence.mock.calls[0]?.[1];
      expect(attemptedBundle?.sessions.map((entry) => entry.session.payload)).toEqual([
        { __version: 1, command: 'first' },
        { __version: 1, command: 'second' },
      ]);
      expect(attemptedBundle?.run?.run).toMatchObject({ name: 'rollback-suite' });
      expect(attemptedBundle?.run?.steps.map((step) => step.command)).toEqual(['first', 'second']);
      expect(new SessionRepo(datastore).count()).toBe(0);
      expect(new RunRepo(datastore).listRuns()).toEqual([]);
    } finally {
      datastore.close();
    }
  });

  it('commits a suite larger than the retention keep before the one post-commit prune', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const first = sessionCommand('first');
    const second = sessionCommand('second');
    const retentionPolicy = vi.fn(() => ({
      source: 'scope' as const,
      keep: 1,
      maxAgeDays: 0,
      maxSizeMb: 0,
    }));
    const scope = new RunScope({ datastore: () => datastore });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'retained-suite',
          suite: {
            steps: [
              { tool: TOOL_ID, command: first.name },
              { tool: TOOL_ID, command: second.name },
            ],
          },
          tools: [tool(TOOL_ID, 'fitness', [first, second])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks({}, { sessionRetentionPolicy: retentionPolicy }),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.runId).toMatch(/^RUN_/u);
      expect(retentionPolicy).toHaveBeenCalledOnce();
      expect(new SessionRepo(datastore).count()).toBe(1);
      const steps = new RunRepo(datastore).listStepsForRun(result.runId!);
      expect(steps).toHaveLength(2);
      expect(steps.filter((step) => step.sessionId !== undefined)).toHaveLength(1);
    } finally {
      datastore.close();
    }
  });

  it('poisons an over-limit suite without committing a child prefix or changing its verdict', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const first = sessionCommand('first');
    const second = sessionCommand('second');
    const scope = new RunScope({ datastore: () => datastore });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'bounded-suite',
          suite: {
            steps: [
              { tool: TOOL_ID, command: first.name },
              { tool: TOOL_ID, command: second.name },
            ],
          },
          tools: [tool(TOOL_ID, 'fitness', [first, second])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks({}, { evidenceLimits: { maxSessions: 1 } }),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(result.runId).toBeUndefined();
      expect(new SessionRepo(datastore).count()).toBe(0);
      expect(new RunRepo(datastore).listRuns()).toEqual([]);
    } finally {
      datastore.close();
    }
  });

  it('opens one exact suite report only after the atomic bundle commits', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const observedOpts: Readonly<Record<string, unknown>>[] = [];
    const spec = sessionCommand('fit', async (opts, cli) => {
      observedOpts.push(opts);
      await cli.maybeOpenReport({ openRequested: true, jsonOutput: false });
    });
    const order: string[] = [];
    const commitEvidence = vi.fn((...args: Parameters<typeof commitEvidenceBundle>) => {
      order.push('commit');
      return commitEvidenceBundle(...args);
    });
    const executeReportEffect = vi.fn(() => {
      order.push('report');
      return Promise.resolve();
    });
    const originalTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const originalEnv = {
      CI: process.env.CI,
      SSH_CONNECTION: process.env.SSH_CONNECTION,
      SSH_CLIENT: process.env.SSH_CLIENT,
    };
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    delete process.env.CI;
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_CLIENT;

    try {
      const factory = createRunPlaneFactory({
        getDatastore: () => currentScope()?.datastore() as DataStore | undefined,
        commitEvidence,
        executeReportEffect,
      });
      const host = makeDispatchHostCtx();
      const ctx = {
        ...host.ctx,
        maybeOpenReport: (request: {
          readonly openRequested: boolean;
          readonly jsonOutput: boolean;
        }) => {
          if (request.openRequested && !request.jsonOutput) {
            factory.queueReportEffect({ kind: 'compose-and-open' });
          }
          return Promise.resolve();
        },
      } satisfies ToolCliContext;
      const result = await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runSuite({
          name: 'audit',
          source: 'built-in',
          suite: { steps: [{ tool: TOOL_ID, command: spec.name }] },
          tools: [tool(TOOL_ID, 'fitness', [spec])],
          ctx,
          runActionHooks: createRunActionHooks(factory),
          suiteOpts: { cwd: '/repo', open: true },
        }),
      );

      expect(order).toEqual(['commit', 'report']);
      expect(executeReportEffect).toHaveBeenCalledOnce();
      expect(executeReportEffect).toHaveBeenCalledWith({
        kind: 'compose-and-open',
        selection: { view: 'change-impact', runId: result.runId },
      });
      expect(observedOpts[0]).not.toHaveProperty('open');
    } finally {
      if (originalTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, 'isTTY', originalTty);
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      datastore.close();
    }
  });

  it.each([
    { label: 'no open request', suiteOpts: { cwd: '/repo' } },
    { label: 'JSON output', suiteOpts: { cwd: '/repo', open: true, json: true } },
  ])(
    'clears a child report request when the parent policy resolves to $label',
    async ({ suiteOpts }) => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      const executeReportEffect = vi.fn(() => Promise.resolve());
      const factory = createRunPlaneFactory({
        getDatastore: () => currentScope()?.datastore() as DataStore | undefined,
        executeReportEffect,
      });
      const host = makeDispatchHostCtx();
      const ctx = {
        ...host.ctx,
        maybeOpenReport: (request: {
          readonly openRequested: boolean;
          readonly jsonOutput: boolean;
        }) => {
          if (request.openRequested && !request.jsonOutput) {
            factory.queueReportEffect({ kind: 'compose-and-open' });
          }
          return Promise.resolve();
        },
      } satisfies ToolCliContext;
      const spec = sessionCommand('fit', (_opts, cli) =>
        cli.maybeOpenReport({ openRequested: true, jsonOutput: false }),
      );

      try {
        const result = await runWithScope(new RunScope({ datastore: () => datastore }), () =>
          runSuite({
            name: 'audit',
            source: 'built-in',
            suite: { steps: [{ tool: TOOL_ID, command: spec.name }] },
            tools: [tool(TOOL_ID, 'fitness', [spec])],
            ctx,
            runActionHooks: createRunActionHooks(factory),
            suiteOpts,
          }),
        );

        expect(result.runId).toMatch(/^RUN_/u);
        expect(executeReportEffect).not.toHaveBeenCalled();
      } finally {
        datastore.close();
      }
    },
  );

  it('does not hold the evidence write lock while a suite child is paused', async () => {
    const root = makeTempDir('suite-atomic-concurrency-');
    const datastore = DataStoreFactory.open({
      backend: 'sqlite',
      path: join(root, 'runtime.sqlite'),
    });
    let enterChild!: () => void;
    let releaseChild!: () => void;
    const childEntered = new Promise<void>((resolve) => {
      enterChild = resolve;
    });
    const childRelease = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const paused = sessionCommand('paused', async () => {
      enterChild();
      await childRelease;
    });
    const standalone = sessionCommand('standalone');
    const scope = new RunScope({ datastore: () => datastore });
    const suiteHooks = suiteRunHooks();
    const standaloneHooks = suiteRunHooks();

    try {
      const result = await runWithScope(scope, async () => {
        const suitePromise = runSuite({
          name: 'paused-suite',
          suite: { steps: [{ tool: TOOL_ID, command: paused.name }] },
          tools: [tool(TOOL_ID, 'fitness', [paused])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteHooks,
          suiteOpts: { cwd: root },
        });
        await childEntered;

        await runCommandSpecAction(
          standalone,
          { cwd: root },
          [],
          makeDispatchHostCtx().ctx,
          standaloneHooks,
        );
        const beforeResume = new RunRepo(datastore).listRuns();
        expect(beforeResume).toHaveLength(1);
        expect(new SessionRepo(datastore).count()).toBe(1);

        releaseChild();
        return suitePromise;
      });

      expect(result.runId).toMatch(/^RUN_/u);
      const runs = new RunRepo(datastore).listRuns();
      expect(runs).toHaveLength(2);
      expect(new SessionRepo(datastore).count()).toBe(2);
      expect(new RunRepo(datastore).listStepsForRun(result.runId!)[0]?.sessionId).toMatch(/^FIT_/u);
    } finally {
      releaseChild();
      datastore.close();
    }
  });

  it('discards a thrown orchestration owner before the same hooks are reused', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const spec = sessionCommand('fit');
    const retentionPolicy = vi.fn(() => ({
      source: 'scope' as const,
      keep: 200,
      maxAgeDays: 60,
      maxSizeMb: 150,
    }));
    const hooks = suiteRunHooks({}, { sessionRetentionPolicy: retentionPolicy });
    const input = {
      name: 'cleanup-suite',
      suite: { steps: [{ tool: TOOL_ID, command: spec.name }] },
      tools: [tool(TOOL_ID, 'fitness', [spec])],
      ctx: makeDispatchHostCtx().ctx,
      runActionHooks: hooks,
      suiteOpts: { cwd: '/repo' },
    } satisfies RunSuiteInput;

    try {
      await expect(
        runWithScope(new RunScope({ datastore: () => datastore }), () =>
          runSuite({
            ...input,
            onStepEvent: (event) => {
              if (event.phase === 'done') {
                throw new Error('fixture orchestration sink failed');
              }
            },
          }),
        ),
      ).rejects.toThrow('fixture orchestration sink failed');
      expect(new SessionRepo(datastore).count()).toBe(0);
      expect(new RunRepo(datastore).listRuns()).toEqual([]);
      expect(retentionPolicy).toHaveBeenCalledOnce();

      const result = await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runSuite(input),
      );
      expect(result.runId).toMatch(/^RUN_/u);
      expect(new SessionRepo(datastore).count()).toBe(1);
      expect(new RunRepo(datastore).listRuns()).toHaveLength(1);
      expect(retentionPolicy).toHaveBeenCalledTimes(2);
    } finally {
      datastore.close();
    }
  });

  it('faults a verdict step that returns undeclared snapshots and withholds both output legs', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const completion = contextContribution('inventory', 'verdict-with-snapshot');
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'verdict-with-snapshot',
      description: 'misdeclared fixture',
      commonFlags: [],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'host-orchestrated-evidence',
      producesVerdict: true,
      handler: (_opts, cli) => {
        emitPassingEvidence(cli);
        return completion;
      },
    });
    let snapshots: readonly EvidenceSnapshotContribution[] = [];
    const completeRun = vi.fn((value: unknown) => {
      snapshots = (value as ToolRunCompletion | undefined)?.evidenceSnapshots ?? [];
    });
    const scope = new RunScope({ datastore: () => datastore });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'capability-mismatch',
          suite: { steps: [{ tool: TOOL_ID, command: spec.name }] },
          tools: [tool(TOOL_ID, 'fitness', [spec])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks({
            resetRun: () => {
              snapshots = [];
            },
            completeRun,
            currentEvidenceSnapshots: () => snapshots,
          }),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        outcome: 'faulted',
        errorCode: 'RUN.CAPABILITY.MISMATCH',
      });
      expect(result.steps[0]?.verdict).toBeUndefined();
      expect(completeRun).toHaveBeenCalledWith({});
      const persisted = new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0];
      expect(persisted?.evidence).toBeUndefined();
      expect(persisted?.sessionId).toBeUndefined();
    } finally {
      datastore.close();
    }
  });

  it('bounds a malformed in-process verdict envelope as missing evidence instead of throwing orchestration', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const malformed = {
      ...signalEnvelope({ passed: true, findings: 0 }),
      units: undefined,
    } as unknown as SignalEnvelope;
    const spec = helpCommand('malformed-envelope', (_opts, cli) => {
      cli.emitEnvelope(malformed);
      return { type: 'help' };
    });

    try {
      const result = await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runSuite({
          name: 'malformed-suite',
          suite: { steps: [{ tool: TOOL_ID, command: spec.name }] },
          tools: [tool(TOOL_ID, 'fitness', [spec])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        outcome: 'faulted',
        errorCode: 'RUN.EVIDENCE.MISSING',
      });
      expect(result.steps[0]?.verdict).toBeUndefined();
      const persisted = new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0];
      expect(persisted?.evidence).toBeUndefined();
      expect(persisted?.sessionId).toBeUndefined();
    } finally {
      datastore.close();
    }
  });

  it('ignores malformed in-process impact trust without aborting the completed suite', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const envelope = {
      ...signalEnvelope({ passed: true, findings: 0 }),
      verification: {
        coverage: 'partial',
        fallback: 'full-run',
        fullyVerified: false,
        uncertainties: [null],
      },
    } as unknown as SignalEnvelope;
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'malformed-impact-trust',
      description: 'malformed optional trust fixture',
      commonFlags: [],
      scope: 'project',
      output: 'signal-envelope',
      producesVerdict: true,
      handler: () => envelope,
    });

    try {
      const result = await runWithScope(new RunScope({ datastore: () => datastore }), () =>
        runSuite({
          name: 'malformed-trust-suite',
          suite: { steps: [{ tool: TOOL_ID, command: spec.name }] },
          tools: [tool(TOOL_ID, 'fitness', [spec])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        outcome: 'passed',
      });
      expect(result.steps[0]?.verification).toBeUndefined();
      expect(new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0]?.evidence).toBeDefined();
    } finally {
      datastore.close();
    }
  });

  it('faults an evidence step that emits a verdict/session and withholds every contribution', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const evidence = contextContribution('inventory', 'evidence-with-verdict');
    const spec = evidenceCommand('evidence-with-verdict', (_opts, cli) => {
      emitPassingEvidence(cli);
      return {
        ...evidence,
        session: { tool: 'graph', cwd: '/repo', score: 100, passed: true },
      } satisfies ToolRunCompletion;
    });
    let snapshots: readonly EvidenceSnapshotContribution[] = [];
    const completeRun = vi.fn((value: unknown) => {
      snapshots = (value as ToolRunCompletion | undefined)?.evidenceSnapshots ?? [];
    });
    const scope = new RunScope({ datastore: () => datastore });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'capability-mismatch',
          suite: { steps: [{ tool: TOOL_ID, command: spec.name }] },
          tools: [tool(TOOL_ID, 'fitness', [spec])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks({
            resetRun: () => {
              snapshots = [];
            },
            completeRun,
            currentEvidenceSnapshots: () => snapshots,
          }),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        outcome: 'faulted',
        readiness: 'unavailable',
        errorCode: 'RUN.CAPABILITY.MISMATCH',
      });
      expect(result.steps[0]?.verdict).toBeUndefined();
      expect(completeRun).toHaveBeenCalledWith(evidence);
      const persisted = new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0];
      expect(persisted?.evidence).toBeUndefined();
      expect(persisted?.sessionId).toBeUndefined();
    } finally {
      datastore.close();
    }
  });

  it('omits runId without failing the completed suite when persistence is unavailable', async () => {
    const spec = helpCommand('fit', (_opts, cli) => {
      emitPassingEvidence(cli);
      return { type: 'help' };
    });
    const scope = new RunScope({
      datastore: () => {
        throw new Error('datastore offline');
      },
    });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'audit',
        suite: { steps: [{ tool: TOOL_ID, command: 'fit' }] },
        source: 'built-in',
        tools: [tool(TOOL_ID, 'fitness', [spec])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: { cwd: '/repo' },
      }),
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(result.runId).toBeUndefined();
  });

  it('assembles step opts from CommandSpec options plus shared suite flags', async () => {
    const seen: Record<string, unknown>[] = [];
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'fit',
      description: 'fixture',
      commonFlags: ['cwd', 'json'],
      options: [
        {
          flag: '--tag',
          value: '<slug>',
          description: 'tag',
          arrayDefault: [],
          parse: (raw, prev) => [...(Array.isArray(prev) ? prev : []), raw],
        },
        {
          flag: '--count',
          value: '<n>',
          description: 'count',
          parse: (raw) => Number.parseInt(raw, 10),
        },
      ],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });
    const host = makeDispatchHostCtx();

    await runSuite({
      name: 'security',
      suite: {
        steps: [
          {
            tool: TOOL_ID,
            command: 'fit',
            args: { tag: ['security', 'perf'], count: '3', _args: ['src'] },
          },
        ],
      },
      tools: [tool(TOOL_ID, 'fitness', [spec])],
      ctx: host.ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: { cwd: '/repo', json: false },
    });

    expect(seen).toEqual([
      {
        cwd: '/repo',
        json: false,
        tag: ['security', 'perf'],
        count: 3,
        _args: ['src'],
      },
    ]);
  });

  it('projects impact trust metadata onto suite step verification', async () => {
    const trust = {
      coverage: 'partial',
      fallback: 'full-run',
      fullyVerified: false,
      uncertainties: [
        {
          code: 'graph-catalog-unavailable',
          source: 'catalog',
          message: 'Graph catalog is unavailable for --include-impacted.',
        },
      ],
    };
    const spec = helpCommand('graph-impact', async (_opts, cli) => {
      await cli.deliverSignals(
        signalEnvelope({
          passed: true,
          warnings: 1,
          findings: 1,
          metadata: { trust },
        }),
        { cwd: '/repo' },
      );
      return { type: 'help' };
    });

    const result = await runSuite({
      name: 'impact',
      suite: { steps: [{ tool: TOOL_ID, command: 'graph-impact' }] },
      tools: [tool(TOOL_ID, 'fitness', [spec])],
      ctx: makeDispatchHostCtx().ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: {},
    });

    expect(result.steps[0]?.verification).toEqual(trust);
    expect(result.reviewBrief?.degraded).toContainEqual(
      expect.objectContaining({
        code: 'impact-verification-partial',
        stepIndex: 0,
      }),
    );
    expect(result.reviewBrief?.verdict).toBe('warn');
  });

  it("loads each step tool's capability domains before handlers run", async () => {
    const order: string[] = [];
    loadCapabilitiesSpy.mockImplementation((args: unknown) => {
      const owningTool = (args as { owningTool: Tool }).owningTool;
      order.push(`load:${owningTool.metadata.id}`);
      return Promise.resolve(1);
    });
    const fit = helpCommand('fit', (_opts, cli) => {
      order.push('run:fit');
      emitPassingEvidence(cli);
      return { type: 'help' };
    });
    const impact = helpCommand('impact', (_opts, cli) => {
      order.push('run:impact');
      emitPassingEvidence(cli);
      return { type: 'help' };
    });
    const fitness = tool(TOOL_ID, 'fitness', [fit]);
    const graph = tool(OTHER_TOOL_ID, 'graph', [impact]);
    const scope = new RunScope();
    Object.assign(scope, {
      capabilities: {},
      projectContext: { projectRoot: '/repo' },
      configDocument: {
        plugins: { graphAdapters: ['@opensip-cli/graph-typescript'] },
      },
    });
    const host = makeDispatchHostCtx();

    await runWithScope(scope, () =>
      runSuite({
        name: 'audit',
        suite: {
          steps: [
            { tool: TOOL_ID, command: 'fit' },
            { tool: OTHER_TOOL_ID, command: 'impact' },
            { tool: TOOL_ID, command: 'fit' },
          ],
        },
        tools: [fitness, graph],
        ctx: host.ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: { cwd: '/repo', json: true },
      }),
    );

    expect(loadCapabilitiesSpy).toHaveBeenCalledTimes(2);
    expect(loadCapabilitiesSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        owningTool: fitness,
        projectDir: '/repo',
        pluginsConfig: { graphAdapters: ['@opensip-cli/graph-typescript'] },
      }),
    );
    expect(loadCapabilitiesSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        owningTool: graph,
        projectDir: '/repo',
        pluginsConfig: { graphAdapters: ['@opensip-cli/graph-typescript'] },
      }),
    );
    expect(order).toEqual([
      `load:${TOOL_ID}`,
      `load:${OTHER_TOOL_ID}`,
      'run:fit',
      'run:impact',
      'run:fit',
    ]);
  });

  it('propagates suite selectors only to commands that declare them', async () => {
    const seen: Record<string, unknown>[] = [];
    const fit = defineCommand<unknown, ToolCliContext>({
      name: 'fit',
      description: 'fixture',
      commonFlags: [],
      options: [
        { flag: '--changed', description: 'changed', default: false },
        { flag: '--since', value: '<ref>', description: 'since' },
      ],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });
    const impact = defineCommand<unknown, ToolCliContext>({
      name: 'impact',
      description: 'fixture',
      commonFlags: [],
      options: [
        { flag: '--changed', description: 'changed', default: false },
        { flag: '--since', value: '<ref>', description: 'since' },
        {
          flag: '--files',
          value: '<path>',
          description: 'files',
          arrayDefault: [],
          parse: (raw, prev) => [...(Array.isArray(prev) ? prev : []), raw],
        },
      ],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });
    const yagni = defineCommand<unknown, ToolCliContext>({
      name: 'yagni',
      description: 'fixture',
      commonFlags: [],
      options: [
        {
          flag: '--min-confidence',
          value: '<level>',
          description: 'confidence',
        },
      ],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });

    await runSuite({
      name: 'audit',
      suite: {
        steps: [
          { tool: TOOL_ID, command: 'fit', args: { changed: false } },
          { tool: OTHER_TOOL_ID, command: 'impact' },
          {
            tool: EXTERNAL_TOOL_ID,
            command: 'yagni',
            args: { minConfidence: 'high' },
          },
        ],
      },
      tools: [
        tool(TOOL_ID, 'fitness', [fit]),
        tool(OTHER_TOOL_ID, 'graph', [impact]),
        tool(EXTERNAL_TOOL_ID, 'yagni', [yagni]),
      ],
      ctx: makeDispatchHostCtx().ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: { changed: true, since: 'origin/main', files: ['src/a.ts'] },
    });

    expect(seen).toEqual([
      { changed: false, since: 'origin/main', _args: [] },
      {
        changed: true,
        since: 'origin/main',
        files: ['src/a.ts'],
        _args: [],
      },
      { minConfidence: 'high', _args: [] },
    ]);
  });

  it('applies default changed only when no explicit selector was supplied', async () => {
    const cwd = makeChangedGitFixture();
    const seen: Record<string, unknown>[] = [];
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'impact',
      description: 'fixture',
      commonFlags: [],
      options: [
        { flag: '--changed', description: 'changed', default: false },
        { flag: '--since', value: '<ref>', description: 'since' },
        {
          flag: '--files',
          value: '<path>',
          description: 'files',
          arrayDefault: [],
          parse: (raw, prev) => [...(Array.isArray(prev) ? prev : []), raw],
        },
      ],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });
    const suite = { steps: [{ tool: TOOL_ID, command: 'impact' }] };
    const tools = [tool(TOOL_ID, 'graph', [spec])];
    const ctx = makeDispatchHostCtx().ctx;

    await runSuite({
      name: 'audit',
      suite,
      tools,
      ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: { cwd },
      defaultChanged: true,
    });
    await runSuite({
      name: 'audit',
      suite,
      tools,
      ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: { cwd, since: 'origin/main' },
      defaultChanged: true,
    });

    expect(seen).toEqual([
      { changed: true, files: [], _args: [] },
      // `since: origin/main` fails in this fixture (no remote) → full fallback.
      // Full scope clears failed selectors so steps do not re-receive `since`.
      { changed: false, files: [], _args: [] },
    ]);
  });

  it('gates the changed default on git scope and stamps the result', async () => {
    const cwd = makeChangedGitFixture();
    const seen: Record<string, unknown>[] = [];
    const debug = vi.fn();
    const warn = vi.fn();
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'impact',
      description: 'fixture',
      commonFlags: [],
      options: [
        { flag: '--changed', description: 'changed', default: false },
        {
          flag: '--files',
          value: '<path>',
          description: 'files',
          arrayDefault: [],
          parse: (raw, prev) => [...(Array.isArray(prev) ? prev : []), raw],
        },
      ],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });
    const scope = new RunScope({
      logger: { info: vi.fn(), debug, warn, error: vi.fn() },
    });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'audit',
        suite: { steps: [{ tool: TOOL_ID, command: 'impact' }] },
        tools: [tool(TOOL_ID, 'graph', [spec])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: { cwd },
        defaultChanged: true,
      }),
    );

    expect(seen).toEqual([{ changed: true, files: [], _args: [] }]);
    expect(result.scope).toEqual({
      mode: 'changed',
      source: 'default',
      changedFiles: 2,
    });
    expect(result.reviewBrief?.changedFiles).toBe(2);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.scope.resolved',
        mode: 'changed',
        source: 'default',
        changedFiles: 2,
      }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.suite.scope.fallback' }),
    );
  });

  it('falls the changed default back to full scope outside git', async () => {
    const cwd = makeTempDir('suite-orchestrator-nongit-');
    const seen: Record<string, unknown>[] = [];
    const debug = vi.fn();
    const warn = vi.fn();
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'impact',
      description: 'fixture',
      commonFlags: [],
      options: [{ flag: '--changed', description: 'changed', default: false }],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });
    const scope = new RunScope({
      logger: { info: vi.fn(), debug, warn, error: vi.fn() },
    });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'audit',
        suite: { steps: [{ tool: TOOL_ID, command: 'impact' }] },
        tools: [tool(TOOL_ID, 'graph', [spec])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: { cwd },
        defaultChanged: true,
      }),
    );

    expect(seen).toEqual([{ changed: false, _args: [] }]);
    expect(result.scope).toMatchObject({ mode: 'full', source: 'fallback' });
    expect(result.reviewBrief?.changedFiles).toBeNull();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.scope.resolved',
        mode: 'full',
        source: 'fallback',
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.scope.fallback',
        suite: 'audit',
        reason: expect.stringContaining('running the full scope'),
      }),
    );
  });

  it('keeps --full as an explicit full-scope suite run', async () => {
    const cwd = makeChangedGitFixture();
    const seen: Record<string, unknown>[] = [];
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'impact',
      description: 'fixture',
      commonFlags: [],
      options: [{ flag: '--changed', description: 'changed', default: false }],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });

    const result = await runSuite({
      name: 'audit',
      suite: { steps: [{ tool: TOOL_ID, command: 'impact' }] },
      tools: [tool(TOOL_ID, 'graph', [spec])],
      ctx: makeDispatchHostCtx().ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: { cwd, full: true },
      defaultChanged: true,
    });

    expect(seen).toEqual([{ changed: false, _args: [] }]);
    expect(result.scope).toEqual({ mode: 'full', source: 'explicit' });
  });

  it('feeds full target files to built-in graph impact when audit is full-scoped', async () => {
    const cwd = makeChangedGitFixture();
    const fullFile = join(cwd, 'src/a.ts');
    const seen: Record<string, unknown>[] = [];
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'impact',
      description: 'fixture',
      commonFlags: ['cwd'],
      options: [
        { flag: '--changed', description: 'changed', default: false },
        {
          flag: '--files',
          value: '<path>',
          description: 'files',
          arrayDefault: [],
          parse: (raw, prev) => [...(Array.isArray(prev) ? prev : []), raw],
        },
      ],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (opts, cli) => {
        seen.push(opts as Record<string, unknown>);
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });
    const scope = new RunScope();
    Object.assign(scope, {
      targets: {
        getByName: () => undefined,
        getAll: () => [
          {
            config: {
              name: 'src',
              description: 'source',
              include: ['src/**/*.ts'],
              exclude: [],
            },
          },
        ],
        getByTag: () => [],
        has: () => true,
        resolveTargets: () => [fullFile],
        applyGlobalExcludes: (files: readonly string[]) => files,
        globalExcludes: [],
      },
    });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'audit',
        suite: { steps: [{ tool: BUILT_IN_GRAPH_TOOL_ID, command: 'impact' }] },
        tools: [tool(BUILT_IN_GRAPH_TOOL_ID, 'graph', [spec])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: { cwd, full: true, changed: true },
        defaultChanged: true,
      }),
    );

    expect(seen).toEqual([{ cwd, changed: false, files: [fullFile], _args: [] }]);
    expect(result.scope).toEqual({ mode: 'full', source: 'explicit' });
    expect(result.aggregate?.faulted).toBe(0);
  });

  it('captures per-step exit codes without mutating the outer host context', async () => {
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'fit',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (_opts, cli) => {
        cli.setExitCode(EXIT_CODES.REPORT_FAILED);
        cli.emitEnvelope(signalEnvelope({ passed: false, findings: 0 }));
        return { type: 'help' };
      },
    });
    const host = makeDispatchHostCtx();

    const result = await runSuite({
      name: 'security',
      suite: { steps: [{ tool: TOOL_ID, command: 'fit' }] },
      tools: [tool(TOOL_ID, 'fitness', [spec])],
      ctx: host.ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: {},
    });

    expect(result.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    expect(result.steps[0]?.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    expect(host.exitCodes).toEqual([]);
  });

  it('aggregates reportFailure steps into the suite exit and summary', async () => {
    const spec = defineCommand<unknown, ToolCliContext>({
      name: 'reported',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: async (_opts, cli) => {
        await cli.reportFailure?.({
          error: new ConfigurationError('suite step config is invalid'),
          jsonRequested: true,
        });
      },
    });
    const host = makeDispatchHostCtx();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const scope = new RunScope({
      logger: { info, warn, error, debug: vi.fn() },
    });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'security',
        suite: { steps: [{ tool: TOOL_ID, command: 'reported' }] },
        tools: [tool(TOOL_ID, 'fitness', [spec])],
        ctx: host.ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: { json: true },
      }),
    );

    expect(result.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    expect(result.steps[0]).toMatchObject({
      command: 'reported',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      error: 'suite step config is invalid',
    });
    expect(host.exitCodes).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.run.step',
        command: 'reported',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'tool.command.failed',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      }),
    );
    expect(error).not.toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.suite.run.step.error' }),
    );
  });

  it('preserves ToolError taxonomy for suite step failures', async () => {
    const errors: ToolError[] = [
      new NotFoundError('missing check'),
      new ConfigurationError('bad config'),
      new ValidationError('bad input'),
      new NetworkError('network failed'),
      new PluginIncompatibleError('bad plugin'),
      new TimeoutError('too slow'),
      new SystemError('system failed'),
    ];

    for (const thrown of errors) {
      const spec = defineCommand<unknown, ToolCliContext>({
        name: 'typed-error',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        producesVerdict: true,
        handler: () => {
          throw thrown;
        },
      });
      const result = await runSuite({
        name: 'security',
        suite: { steps: [{ tool: TOOL_ID, command: 'typed-error' }] },
        tools: [tool(TOOL_ID, 'fitness', [spec])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: {},
      });

      expect(result.steps[0]).toMatchObject({
        command: 'typed-error',
        exitCode: mapToolErrorToExitCode(thrown),
        error: thrown.definition.exposure === 'public' ? thrown.message : 'The operation failed.',
        errorCode: thrown.code,
      });
      expect(result.exitCode).toBe(mapToolErrorToExitCode(thrown));
    }
  });

  it('captures process.exit from a bundled step and restores process.exit afterward', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- process.exit has no `this` contract; this test preserves identity for restoration.
    const originalExit = process.exit;
    const after = vi.fn((_opts: unknown, cli: ToolCliContext) => {
      emitPassingEvidence(cli);
      return { type: 'help' } as const;
    });
    const exiting = defineCommand<unknown, ToolCliContext>({
      name: 'exit-step',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: () => process.exit(2),
    });
    const next = defineCommand<unknown, ToolCliContext>({
      name: 'after',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: after,
    });

    const result = await runSuite({
      name: 'security',
      suite: {
        steps: [
          { tool: TOOL_ID, command: 'exit-step' },
          { tool: TOOL_ID, command: 'after' },
        ],
      },
      tools: [tool(TOOL_ID, 'fitness', [exiting, next])],
      ctx: makeDispatchHostCtx().ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: {},
    });

    expect(result.exitCode).toBe(2);
    expect(result.steps.map((step) => step.exitCode)).toEqual([2, 0]);
    expect(after).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity assertion verifies the guard restored process.exit.
    expect(process.exit).toBe(originalExit);
  });

  it('records thrown step failures and continues running later steps', async () => {
    const calls: string[] = [];
    const throws = defineCommand<unknown, ToolCliContext>({
      name: 'throws',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: () => {
        calls.push('throws');
        throw new Error('step exploded');
      },
    });
    const after = defineCommand<unknown, ToolCliContext>({
      name: 'after',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: (_opts, cli) => {
        calls.push('after');
        emitPassingEvidence(cli);
        return { type: 'help' };
      },
    });

    const result = await runSuite({
      name: 'security',
      suite: {
        steps: [
          { tool: TOOL_ID, command: 'throws' },
          { tool: OTHER_TOOL_ID, command: 'after' },
        ],
      },
      tools: [tool(TOOL_ID, 'fitness', [throws]), tool(OTHER_TOOL_ID, 'graph', [after])],
      ctx: makeDispatchHostCtx().ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: {},
    });

    expect(calls).toEqual(['throws', 'after']);
    expect(result.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(result.steps[0]).toMatchObject({
      command: 'throws',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      error: 'step exploded',
    });
    expect(result.steps[1]).toMatchObject({
      command: 'after',
      exitCode: EXIT_CODES.SUCCESS,
    });
  });

  it('bounds non-ToolError fault messages in step summaries', async () => {
    const longMessage = 'x'.repeat(1500);
    const fault = defineCommand<unknown, ToolCliContext>({
      name: 'fault',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      producesVerdict: true,
      handler: () => {
        throw new Error(longMessage);
      },
    });

    const result = await runSuite({
      name: 'security',
      suite: { steps: [{ tool: TOOL_ID, command: 'fault' }] },
      tools: [tool(TOOL_ID, 'fitness', [fault])],
      ctx: makeDispatchHostCtx().ctx,
      runActionHooks: suiteRunHooks(),
      suiteOpts: {},
    });

    expect(result.steps[0]?.error).toHaveLength(1000);
    expect(result.steps[0]?.error?.endsWith('...')).toBe(true);
  });

  it('captures external-dispatch replay through the step context for worst-of aggregation', async () => {
    dispatchSpy.mockImplementation((args: { ctx: ToolCliContext }) => {
      args.ctx.setExitCode(3);
      args.ctx.emitEnvelope(signalEnvelope({ passed: false, errors: 1, findings: 1 }));
    });
    const external = helpCommand('external-run', () => {
      throw new Error('external handler should not run in-process');
    });
    const bundled = helpCommand('bundled-ok', (_opts, cli) => {
      emitPassingEvidence(cli);
      return { type: 'help' };
    });
    const scope = new RunScope({ toolProvenance: [externalProvenance()] });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'security',
        suite: {
          steps: [
            { tool: EXTERNAL_TOOL_ID, command: 'external-run' },
            { tool: TOOL_ID, command: 'bundled-ok' },
          ],
        },
        tools: [
          tool(EXTERNAL_TOOL_ID, 'external-fixture', [external]),
          tool(TOOL_ID, 'fitness', [bundled]),
        ],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: {},
      }),
    );

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(3);
    expect(result.steps.map((step) => step.exitCode)).toEqual([3, 0]);
    expect(result.steps[0]).toMatchObject({
      stableId: EXTERNAL_TOOL_ID,
      verdict: { passed: false, errors: 1, warnings: 0, findings: 1 },
    });
    expect(result.reviewBrief).toMatchObject({
      version: 1,
      suite: 'security',
      verdict: 'fail',
      topRisks: [
        {
          source: 'fit',
          ruleId: 'fixture-rule',
          severity: 'high',
          signalRef: {
            suiteRunId: result.suiteRunId,
            stepIndex: 0,
            signalIndex: 0,
          },
        },
      ],
    });
  });

  it('accepts a return-only external envelope as complete verdict evidence', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const envelope = signalEnvelope({ passed: true, findings: 0 });
    dispatchSpy.mockImplementation((args: { ctx: ToolCliContext & RunActionHooks }) => {
      args.ctx.completeRun?.({ envelope });
    });
    const external = defineCommand<unknown, ToolCliContext>({
      name: 'external-return-envelope',
      description: 'external return-only envelope fixture',
      commonFlags: [],
      scope: 'project',
      output: 'signal-envelope',
      producesVerdict: true,
      handler: () => {
        throw new Error('external handler should not run in-process');
      },
    });
    const scope = new RunScope({
      datastore: () => datastore,
      toolProvenance: [externalProvenance()],
    });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'external-return-only-suite',
          suite: { steps: [{ tool: EXTERNAL_TOOL_ID, command: external.name }] },
          tools: [tool(EXTERNAL_TOOL_ID, 'external-fixture', [external])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        outcome: 'passed',
        verdict: { passed: true, errors: 0, warnings: 0, findings: 0 },
      });
      const persisted = new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0];
      expect(persisted?.evidence).toMatchObject({
        kind: 'signal-envelope',
        runId: envelope.runId,
      });
    } finally {
      datastore.close();
    }
  });

  it('bounds a malformed external verdict envelope as missing evidence instead of throwing orchestration', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const malformed = {
      ...signalEnvelope({ passed: true, findings: 0 }),
      units: undefined,
    } as unknown as SignalEnvelope;
    dispatchSpy.mockImplementation((args: { ctx: ToolCliContext }) => {
      args.ctx.emitEnvelope(malformed);
    });
    const external = helpCommand('external-malformed', () => {
      throw new Error('external handler should not run in-process');
    });
    const scope = new RunScope({
      datastore: () => datastore,
      toolProvenance: [externalProvenance()],
    });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'external-malformed-suite',
          suite: { steps: [{ tool: EXTERNAL_TOOL_ID, command: external.name }] },
          tools: [tool(EXTERNAL_TOOL_ID, 'external-fixture', [external])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        outcome: 'faulted',
        errorCode: 'RUN.EVIDENCE.MISSING',
      });
      const persisted = new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0];
      expect(persisted?.evidence).toBeUndefined();
      expect(persisted?.sessionId).toBeUndefined();
    } finally {
      datastore.close();
    }
  });

  it('ignores malformed external impact trust without aborting the completed suite', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const envelope = {
      ...signalEnvelope({ passed: true, findings: 0 }),
      verification: {
        coverage: 'partial',
        fallback: 'full-run',
        fullyVerified: false,
        uncertainties: [null],
      },
    } as unknown as SignalEnvelope;
    dispatchSpy.mockImplementation((args: { ctx: ToolCliContext & RunActionHooks }) => {
      args.ctx.completeRun?.({ envelope });
      args.ctx.emitEnvelope(envelope);
    });
    const external = helpCommand('external-malformed-trust', () => {
      throw new Error('external handler should not run in-process');
    });
    const scope = new RunScope({
      datastore: () => datastore,
      toolProvenance: [externalProvenance()],
    });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'external-malformed-trust-suite',
          suite: { steps: [{ tool: EXTERNAL_TOOL_ID, command: external.name }] },
          tools: [tool(EXTERNAL_TOOL_ID, 'external-fixture', [external])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        outcome: 'passed',
      });
      expect(result.steps[0]?.verification).toBeUndefined();
      expect(new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0]?.evidence).toBeDefined();
    } finally {
      datastore.close();
    }
  });

  it('rejects capability-mismatched external verdict replay without staging either output leg', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const envelope = signalEnvelope({ passed: true, findings: 0 });
    const evidence = contextContribution('inventory', 'external-verdict-with-snapshot');
    dispatchSpy.mockImplementation((args: { ctx: ToolCliContext & RunActionHooks }) => {
      args.ctx.emitEnvelope(envelope);
      args.ctx.completeRun?.({ envelope, ...evidence });
    });
    const external = helpCommand('external-capability-mismatch', () => {
      throw new Error('external handler should not run in-process');
    });
    const scope = new RunScope({
      datastore: () => datastore,
      toolProvenance: [externalProvenance()],
    });

    try {
      const result = await runWithScope(scope, () =>
        runSuite({
          name: 'external-capability-mismatch-suite',
          suite: { steps: [{ tool: EXTERNAL_TOOL_ID, command: external.name }] },
          tools: [tool(EXTERNAL_TOOL_ID, 'external-fixture', [external])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: { cwd: '/repo' },
        }),
      );

      expect(result.steps[0]).toMatchObject({
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        outcome: 'faulted',
        errorCode: 'RUN.CAPABILITY.MISMATCH',
      });
      expect(result.steps[0]?.verdict).toBeUndefined();
      const persisted = new RunRepo(datastore).listStepsForRun(result.runId ?? '')[0];
      expect(persisted?.evidence).toBeUndefined();
      expect(persisted?.sessionId).toBeUndefined();
      expect(new SessionRepo(datastore).count()).toBe(0);
    } finally {
      datastore.close();
    }
  });

  it('summarizes a mixed bundled/external suite without collapsing outcome classes', async () => {
    dispatchSpy.mockImplementation((args: { ctx: ToolCliContext }) => {
      args.ctx.emitEnvelope(signalEnvelope({ passed: true, warnings: 1, findings: 1 }));
    });
    const empty = helpCommand('empty', async (_opts, cli) => {
      await cli.deliverSignals(signalEnvelope({ passed: true, findings: 0 }), {
        cwd: '/repo',
      });
      return { type: 'help' };
    });
    const error = helpCommand('error', async (_opts, cli) => {
      await cli.deliverSignals(signalEnvelope({ passed: false, errors: 2, findings: 2 }), {
        cwd: '/repo',
      });
      return { type: 'help' };
    });
    const failureWithoutFindings = helpCommand('failure-without-findings', (_opts, cli) => {
      cli.setExitCode(2);
      cli.emitEnvelope(signalEnvelope({ passed: false, findings: 0 }));
      return { type: 'help' };
    });
    const fault = helpCommand('fault', () => {
      throw new Error('step faulted');
    });
    const missingOutput = helpCommand('missing-output', () => ({
      type: 'help',
    }));
    const externalWarning = helpCommand('external-warning', () => {
      throw new Error('external handler should not run in-process');
    });
    const info = vi.fn();
    const scope = new RunScope({
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      toolProvenance: [externalProvenance()],
    });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'mixed',
        suite: {
          steps: [
            { tool: TOOL_ID, command: 'empty' },
            { tool: EXTERNAL_TOOL_ID, command: 'external-warning' },
            { tool: TOOL_ID, command: 'error' },
            { tool: TOOL_ID, command: 'failure-without-findings' },
            { tool: TOOL_ID, command: 'fault' },
            { tool: TOOL_ID, command: 'missing-output' },
          ],
        },
        tools: [
          tool(TOOL_ID, 'fitness', [empty, error, failureWithoutFindings, fault, missingOutput]),
          tool(EXTERNAL_TOOL_ID, 'external-fixture', [externalWarning]),
        ],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: {},
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.aggregate).toEqual({
      steps: 6,
      // `failure-without-findings` is an evidence-backed failed verdict with zero
      // signals. `missing-output` is deliberately evidence-less and now faults
      // under the completion assertion instead of being silently counted passed.
      passed: 2,
      failed: 2,
      faulted: 2,
      errors: 2,
      warnings: 1,
    });
    expect(result.reviewBrief).toEqual(
      expect.objectContaining({
        version: 1,
        suite: 'mixed',
        verdict: 'fail',
        baselineDelta: { available: false, added: 0, removed: 0, unchanged: 0 },
      }),
    );
    expect(result.reviewBrief?.topRisks).toHaveLength(3);
    expect(result.reviewBrief?.topRisks.map((risk) => risk.severity)).toEqual([
      'high',
      'high',
      'low',
    ]);
    expect(result.reviewBrief?.degraded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'failing-verdict-without-signals',
          stepIndex: 3,
        }),
        expect.objectContaining({ code: 'step-fault', stepIndex: 4 }),
        expect.objectContaining({ code: 'missing-envelope', stepIndex: 4 }),
        expect.objectContaining({ code: 'step-fault', stepIndex: 5 }),
        expect.objectContaining({ code: 'missing-envelope', stepIndex: 5 }),
      ]),
    );
    expect(result.steps[0]).toMatchObject({
      command: 'empty',
      exitCode: EXIT_CODES.SUCCESS,
      outcome: 'passed',
      verdict: { passed: true, errors: 0, warnings: 0, findings: 0 },
    });
    expect(result.steps[1]).toMatchObject({
      command: 'external-warning',
      exitCode: EXIT_CODES.SUCCESS,
      outcome: 'passed',
      verdict: { passed: true, errors: 0, warnings: 1, findings: 1 },
    });
    expect(result.steps[2]).toMatchObject({
      command: 'error',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      outcome: 'failed',
      verdict: { passed: false, errors: 2, warnings: 0, findings: 2 },
    });
    expect(result.steps[3]).toMatchObject({
      command: 'failure-without-findings',
      exitCode: 2,
      outcome: 'failed',
      verdict: { passed: false, errors: 0, warnings: 0, findings: 0 },
    });
    expect(result.steps[4]).toMatchObject({
      command: 'fault',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      outcome: 'faulted',
      error: 'step faulted',
    });
    expect(result.steps[4]?.verdict).toBeUndefined();
    expect(result.steps[5]).toMatchObject({
      command: 'missing-output',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
      outcome: 'faulted',
      error: 'Verdict-producing suite step completed without session or captured evidence.',
      errorCode: 'RUN.EVIDENCE.MISSING',
    });
    expect(result.steps[5]?.verdict).toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.run.complete',
        aggregate: result.aggregate,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.run.step',
        command: 'empty',
        verdict: { passed: true, findings: 0 },
      }),
    );
  });

  it('counts a unit-fault that emitted findings as faulted and raises it in the brief', async () => {
    // Case B: a check threw (verdict.faulted) WHILE sibling checks emitted findings
    // (signals.length > 0). The step emitted an envelope, so `step.error` is absent
    // — the old aggregate mislabeled this `failed`, and the old brief only caught
    // faults with ZERO signals. Both must now surface the runtime fault.
    const faultWithFindings = helpCommand('fault-with-findings', async (_opts, cli) => {
      await cli.deliverSignals(
        signalEnvelope({
          passed: false,
          faulted: true,
          errors: 1,
          findings: 1,
        }),
        { cwd: '/repo' },
      );
      return { type: 'help' };
    });

    const result = await runWithScope(new RunScope({}), () =>
      runSuite({
        name: 'unit-fault',
        suite: { steps: [{ tool: TOOL_ID, command: 'fault-with-findings' }] },
        tools: [tool(TOOL_ID, 'fitness', [faultWithFindings])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: {},
      }),
    );

    expect(result.aggregate).toMatchObject({
      steps: 1,
      passed: 0,
      failed: 0,
      faulted: 1,
    });
    expect(result.steps[0]?.outcome).toBe('faulted');
    // The fault was NOT a run-level throw — it rode in on the envelope's verdict.
    expect(result.steps[0]?.error).toBeUndefined();
    expect(result.reviewBrief?.degraded).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'step-fault', stepIndex: 0 })]),
    );
  });

  it('raises an envelope-backed fault but does not fail the suite exit by default (failOnFault false)', async () => {
    const ok = helpCommand('ok', (_opts, cli) => {
      emitPassingEvidence(cli);
      return { type: 'help' };
    });
    // A CHECK faulted: the tool RAN and emitted an envelope whose verdict is
    // faulted (result unknown) — distinct from the whole step crashing.
    const faultyCheck = helpCommand('faulty', async (_opts, cli) => {
      await cli.deliverSignals(
        signalEnvelope({
          passed: false,
          faulted: true,
          errors: 1,
          findings: 1,
        }),
        { cwd: '/repo' },
      );
      return { type: 'help' };
    });
    const run = (execution?: { readonly failOnFault: boolean }) =>
      runWithScope(new RunScope({}), () =>
        runSuite({
          name: 'faulty',
          suite: {
            steps: [
              { tool: TOOL_ID, command: 'ok' },
              { tool: TOOL_ID, command: 'faulty' },
            ],
            ...(execution === undefined ? {} : { execution }),
          },
          tools: [tool(TOOL_ID, 'fitness', [ok, faultyCheck])],
          ctx: makeDispatchHostCtx().ctx,
          runActionHooks: suiteRunHooks(),
          suiteOpts: {},
        }),
      );

    // Default: the fault is RAISED in the aggregate but is NON-blocking — the
    // envelope-backed faulted step's exit is excluded from the suite worst-of.
    const nonBlocking = await run();
    expect(nonBlocking.aggregate).toMatchObject({
      steps: 2,
      passed: 1,
      faulted: 1,
    });
    expect(nonBlocking.steps[1]?.outcome).toBe('faulted');
    expect(nonBlocking.exitCode).toBe(0);

    // failOnFault: true opts back into hard-failing on the runtime fault.
    const blocking = await run({ failOnFault: true });
    expect(blocking.aggregate).toMatchObject({ faulted: 1 });
    expect(blocking.exitCode).not.toBe(0);
  });

  it('correlates related risks across live suite step envelopes', async () => {
    const shared = { qualifiedName: 'src/review.ts#reviewChange' };
    const fit = helpCommand('fit', async (_opts, cli) => {
      await cli.deliverSignals(
        signalEnvelope({
          tool: 'fit',
          passed: false,
          errors: 1,
          findings: 1,
          message: 'Add input validation',
          filePath: 'src/review.ts',
          metadata: shared,
        }),
        { cwd: '/repo' },
      );
      return { type: 'help' };
    });
    const graph = helpCommand('graph', async (_opts, cli) => {
      await cli.deliverSignals(
        signalEnvelope({
          tool: 'graph',
          passed: false,
          errors: 1,
          findings: 1,
          ruleId: 'graph:large-function',
          message: 'Function has high blast radius',
          filePath: 'src/review.ts',
          metadata: shared,
        }),
        { cwd: '/repo' },
      );
      return { type: 'help' };
    });
    const info = vi.fn();
    const scope = new RunScope({
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const result = await runWithScope(scope, () =>
      runSuite({
        name: 'audit',
        suite: {
          steps: [
            { tool: TOOL_ID, command: 'fit' },
            { tool: OTHER_TOOL_ID, command: 'graph' },
          ],
        },
        tools: [tool(TOOL_ID, 'fitness', [fit]), tool(OTHER_TOOL_ID, 'graph', [graph])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: {},
      }),
    );

    expect(result.reviewBrief?.correlatedRisks).toHaveLength(1);
    expect(result.reviewBrief?.correlatedRisks?.[0]).toEqual(
      expect.objectContaining({
        reasons: expect.arrayContaining([
          expect.objectContaining({
            key: expect.objectContaining({
              kind: 'symbol',
              value: 'src/review.ts#reviewChange',
            }),
          }),
        ]),
        members: expect.arrayContaining([
          expect.objectContaining({
            signalRef: expect.objectContaining({ tool: 'fit' }),
          }),
          expect.objectContaining({
            signalRef: expect.objectContaining({ tool: 'graph' }),
          }),
        ]),
      }),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.suite.brief.built',
        correlatedRisks: 1,
      }),
    );
  });

  it('keeps suite orchestration output host-owned and summaries counts-only', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const secretMessage = 'SECRET_TOKEN_SHOULD_NOT_APPEAR';
    const secretPath = 'src/secret-token-location.ts';
    const secretEnvelope = signalEnvelope({
      passed: false,
      errors: 1,
      findings: 1,
      message: secretMessage,
      filePath: secretPath,
    });
    const spec = helpCommand('secret-finding', async (_opts, cli) => {
      await cli.deliverSignals(secretEnvelope, { cwd: '/repo' });
      return { type: 'help' };
    });

    try {
      const result = await runSuite({
        name: 'security',
        suite: { steps: [{ tool: TOOL_ID, command: 'secret-finding' }] },
        tools: [tool(TOOL_ID, 'fitness', [spec])],
        ctx: makeDispatchHostCtx().ctx,
        runActionHooks: suiteRunHooks(),
        suiteOpts: {},
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        type: 'suite-run',
        suite: 'security',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        aggregate: {
          steps: 1,
          passed: 0,
          failed: 1,
          faulted: 0,
          errors: 1,
          warnings: 0,
        },
      });
      expect(result.steps[0]).toEqual(
        expect.objectContaining({
          tool: 'fitness',
          stableId: TOOL_ID,
          command: 'secret-finding',
          exitCode: EXIT_CODES.RUNTIME_ERROR,
          durationMs: expect.any(Number),
          verdict: { passed: false, errors: 1, warnings: 0, findings: 1 },
        }),
      );
      expect(Object.keys(result.steps[0]?.verdict ?? {}).sort()).toEqual([
        'errors',
        'findings',
        'passed',
        'warnings',
      ]);
      expect(result.reviewBrief?.topRisks[0]).toMatchObject({
        message: secretMessage,
        file: secretPath,
        signalRef: {
          suiteRunId: result.suiteRunId,
          stepIndex: 0,
          signalIndex: 0,
        },
      });
      const serialized = JSON.stringify(result);
      expect(JSON.stringify(result.steps)).not.toContain(secretMessage);
      expect(JSON.stringify(result.steps)).not.toContain(secretPath);
      expect(serialized).toContain(secretMessage);
      expect(serialized).toContain(secretPath);
      expect(serialized).toContain('fixture-rule');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('deriveSuiteAggregate', () => {
  const base = { tool: 'fitness', stableId: TOOL_ID, durationMs: 1 } as const;

  it('tallies every step into exactly one outcome bucket (passed/failed/faulted)', () => {
    const steps: SuiteStepSummary[] = [
      {
        ...base,
        command: 'pass',
        exitCode: EXIT_CODES.SUCCESS,
        outcome: 'passed',
        verdict: { passed: true, errors: 0, warnings: 1, findings: 1 },
      },
      {
        ...base,
        command: 'fail',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        outcome: 'failed',
        verdict: { passed: false, errors: 2, warnings: 0, findings: 2 },
      },
      {
        ...base,
        command: 'exit-only',
        exitCode: 2,
        outcome: 'failed',
      },
      {
        // A UNIT-level fault: an envelope WAS emitted (so `error` is absent) but
        // its verdict carried `faulted`. The old `error`-only heuristic mislabeled
        // this `failed`; keyed on `outcome` it now counts as `faulted`.
        ...base,
        command: 'unit-fault',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        outcome: 'faulted',
        verdict: { passed: false, errors: 0, warnings: 0, findings: 0 },
      },
      {
        // A run-LEVEL fault: the step threw and the host caught it into `error`.
        ...base,
        command: 'run-fault',
        exitCode: EXIT_CODES.RUNTIME_ERROR,
        outcome: 'faulted',
        error: 'boom',
      },
      {
        // A success-exit step that emitted no envelope: the old shape dropped it
        // from all three counts (steps=5 but passed+failed+faulted=4); it is now a
        // first-class `passed`.
        ...base,
        command: 'missing-output',
        exitCode: EXIT_CODES.SUCCESS,
        outcome: 'passed',
      },
    ];

    expect(deriveSuiteAggregate(steps)).toEqual({
      steps: 6,
      passed: 2,
      failed: 2,
      faulted: 2,
      errors: 2,
      warnings: 1,
    });
  });
});
