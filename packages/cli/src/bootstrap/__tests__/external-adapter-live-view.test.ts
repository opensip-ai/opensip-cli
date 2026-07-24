import { buildSignalEnvelope, EXIT_CODES, type SignalEnvelope } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  createSignal,
  HOST_VERDICT_POLICY_FALLBACK,
  ToolError,
  type ToolProvenance,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runExternalAdapterLiveView,
  shouldUseExternalAdapterLiveView,
} from '../external-adapter-live-view.js';

import type { DispatchHostCtx } from '../dispatch-replay-result.js';
import type { ToolCommandResult } from '../tool-command-dispatch-types.js';
import type {
  HostGlue,
  LiveRunOutcome,
  LiveRunProduceHelpers,
  LiveRunSpec,
} from '@opensip-cli/cli-live';
import type * as CliLiveModule from '@opensip-cli/cli-live';
import type { ProgressEvent } from '@opensip-cli/cli-ui';
import type { ExternalAdapterProgressEvent } from '@opensip-cli/external-tool-adapter';

const mocks = vi.hoisted(() => ({
  replayResult: vi.fn(),
  requirePackageDir: vi.fn(),
  runToolLiveView: vi.fn(),
  runWorkerSpec: vi.fn(),
}));

vi.mock('@opensip-cli/cli-live', async (importOriginal) => ({
  ...(await importOriginal<typeof CliLiveModule>()),
  runToolLiveView: mocks.runToolLiveView,
}));

vi.mock('../dispatch-fork-core.js', () => ({
  DEFAULT_DISPATCH_TIMEOUT_MS: 120_000,
  requirePackageDir: mocks.requirePackageDir,
  runWorkerSpec: mocks.runWorkerSpec,
}));

vi.mock('../dispatch-replay-result.js', () => ({
  replayResult: mocks.replayResult,
}));

interface LiveCapture {
  readonly spec: LiveRunSpec;
  readonly glue: HostGlue;
  readonly events: readonly ProgressEvent[];
  readonly headerMetadata: readonly (readonly {
    readonly label: string;
    readonly value: string;
  }[])[];
  readonly outcome: LiveRunOutcome;
  readonly runningSubscriptions: number;
}

interface WorkerInput {
  readonly spec: {
    readonly toolId: string;
    readonly toolPackageDir: string;
    readonly source: string;
    readonly commandName?: string;
    readonly opts: Record<string, unknown>;
    readonly positionals: readonly unknown[];
    readonly presentationMode?: string;
    readonly config?: unknown;
  };
  readonly ctx: DispatchHostCtx;
  readonly cwd: string;
  readonly cliScript?: string;
  readonly timeoutMs: number;
  readonly onAdapterProgress?: (event: ExternalAdapterProgressEvent) => void;
}

const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
let liveCaptures: LiveCapture[];

function setStdoutTty(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  });
}

function envelopeWithFinding(tool = 'gitleaks'): SignalEnvelope {
  const signal = createSignal({
    source: 'scan',
    ruleId: 'secret',
    severity: 'high',
    message: 'secret detected',
    code: { file: 'src/token.ts', line: 4 },
  });
  return buildSignalEnvelope({
    tool,
    runId: 'run_external_live',
    createdAt: '2026-07-19T00:00:00.000Z',
    units: [{ slug: 'scan', passed: false, violationCount: 1, durationMs: 8 }],
    signals: [signal],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

function emptyEnvelope(tool = 'gitleaks'): SignalEnvelope {
  return buildSignalEnvelope({
    tool,
    runId: 'run_external_empty',
    createdAt: '2026-07-19T00:00:00.000Z',
    units: [{ slug: 'scan', passed: true, violationCount: 0, durationMs: 3 }],
    signals: [],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

function provenance(id = 'gitleaks', overrides: Partial<ToolProvenance> = {}): ToolProvenance {
  return {
    source: 'installed',
    id,
    version: '1.0.0',
    resolvedPath: `/plugins/${id}`,
    manifestHash: 'sha256:fixture',
    ...overrides,
  };
}

function hostContext() {
  const setExitCode = vi.fn();
  const ctx = {
    setExitCode,
    runSession: { timing: { complete: vi.fn() } },
  } as unknown as DispatchHostCtx;
  return { ctx, setExitCode };
}

function invocation(
  overrides: {
    readonly provenance?: ToolProvenance;
    readonly opts?: Record<string, unknown>;
    readonly config?: unknown;
    readonly cliScript?: string;
    readonly timeoutMs?: number;
  } = {},
) {
  const { ctx } = hostContext();
  return {
    provenance: overrides.provenance ?? provenance(),
    commandName: 'scan',
    opts: overrides.opts ?? { cwd: '/workspace', verbose: true },
    positionals: ['target'],
    ctx,
    ...(overrides.config === undefined ? {} : { config: overrides.config }),
    ...(overrides.cliScript === undefined ? {} : { cliScript: overrides.cliScript }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  };
}

beforeEach(() => {
  liveCaptures = [];
  mocks.replayResult.mockReset().mockResolvedValue(undefined);
  mocks.requirePackageDir.mockReset().mockImplementation((value: ToolProvenance) => {
    return value.resolvedPath ?? '/plugins/fallback';
  });
  mocks.runWorkerSpec.mockReset();
  mocks.runToolLiveView
    .mockReset()
    .mockImplementation(async (spec: LiveRunSpec, glue: HostGlue): Promise<void> => {
      const events: ProgressEvent[] = [];
      const headerMetadata: (readonly {
        readonly label: string;
        readonly value: string;
      }[])[] = [];
      let runningSubscriptions = 0;
      const helpers: LiveRunProduceHelpers = {
        setHeaderMetadata: (metadata) => {
          headerMetadata.push(metadata);
        },
        setShowRunHeader: () => undefined,
        setRunning: (subscribe) => {
          runningSubscriptions += 1;
          subscribe(() => undefined);
        },
      };
      const outcome = await spec.produce((event) => {
        events.push(event);
      }, helpers);
      liveCaptures.push({
        spec,
        glue,
        events,
        headerMetadata,
        outcome,
        runningSubscriptions,
      });
    });
});

afterEach(() => {
  if (stdoutTtyDescriptor === undefined) {
    Reflect.deleteProperty(process.stdout, 'isTTY');
  } else {
    Object.defineProperty(process.stdout, 'isTTY', stdoutTtyDescriptor);
  }
});

describe('shouldUseExternalAdapterLiveView', () => {
  it('enables the view only for an allowed interactive human run', () => {
    setStdoutTty(true);

    expect(
      shouldUseExternalAdapterLiveView({
        allowAdapterLiveView: true,
        opts: {},
      }),
    ).toBe(true);
    expect(shouldUseExternalAdapterLiveView({ opts: {} })).toBe(false);
    expect(
      shouldUseExternalAdapterLiveView({
        allowAdapterLiveView: true,
        opts: { json: true },
      }),
    ).toBe(false);
    expect(
      shouldUseExternalAdapterLiveView({
        allowAdapterLiveView: true,
        opts: { quiet: true },
      }),
    ).toBe(false);
    expect(
      shouldUseExternalAdapterLiveView({
        allowAdapterLiveView: true,
        opts: { gateSave: true },
      }),
    ).toBe(false);
    expect(
      shouldUseExternalAdapterLiveView({
        allowAdapterLiveView: true,
        opts: { gateCompare: true },
      }),
    ).toBe(false);
  });

  it('rejects a non-interactive stdout even when the adapter opted in', () => {
    setStdoutTty(false);

    expect(
      shouldUseExternalAdapterLiveView({
        allowAdapterLiveView: true,
        opts: {},
      }),
    ).toBe(false);
  });
});

describe('runExternalAdapterLiveView', () => {
  it('renders worker progress and a finding-bearing completion, then replays host effects', async () => {
    const result: ToolCommandResult = {
      output: 'raw-stream',
      completionEnvelope: envelopeWithFinding(),
      session: {
        tool: 'gitleaks',
        cwd: '/workspace',
        score: 0,
        passed: false,
        payload: { binary: { version: '8.24.0' } },
      },
    };
    mocks.runWorkerSpec.mockImplementation((input: WorkerInput) => {
      const progress = input.onAdapterProgress;
      progress?.({
        kind: 'adapter-stage',
        stage: 'resolve-binary',
        status: 'start',
      });
      progress?.({
        kind: 'adapter-stage',
        stage: 'run-scanner',
        status: 'done',
        durationMs: 11,
        detail: 'scanner complete',
        signals: 99,
      });
      progress?.({
        kind: 'adapter-stage',
        stage: 'ingest-report',
        status: 'done',
        signals: 1,
      });
      progress?.({
        kind: 'adapter-stage',
        stage: 'store-evidence',
        status: 'done',
        signals: 2,
      });
      progress?.({
        kind: 'adapter-stage',
        stage: 'deliver-signals',
        status: 'done',
        findings: 1,
      });
      progress?.({
        kind: 'adapter-stage',
        stage: 'prepare-artifacts',
        status: 'done',
        findings: 2,
      });
      progress?.({
        kind: 'adapter-stage',
        stage: 'unknown-stage',
        status: 'start',
      } as unknown as ExternalAdapterProgressEvent);
      progress?.({
        kind: 'adapter-stage',
        stage: 'prepare-artifacts',
        status: 'done',
      });
      return Promise.resolve(result);
    });
    const args = invocation({
      provenance: provenance('gitleaks', { packageName: '@acme/gitleaks' }),
      config: { severity: 'high' },
      cliScript: '/bin/opensip',
      timeoutMs: 4321,
    });

    await runExternalAdapterLiveView(args);

    expect(liveCaptures).toHaveLength(1);
    const capture = liveCaptures[0];
    expect(capture.spec).toMatchObject({
      tool: 'gitleaks',
      meta: { title: 'Gitleaks', description: 'External scanner adapter' },
      surface: { shape: 'phases' },
      verbose: true,
      quiet: false,
      progressOnDone: true,
      projectPath: '/workspace',
      initialHeaderMetadata: [
        { label: 'Adapter', value: '@acme/gitleaks' },
        { label: 'Binary', value: 'resolving' },
      ],
    });
    expect(capture.runningSubscriptions).toBe(1);
    expect(capture.events).toEqual([
      { type: 'stage-start', stage: 'resolve-binary', label: 'Resolve binary' },
      {
        type: 'stage-done',
        stage: 'run-scanner',
        durationMs: 11,
        detail: 'scanner complete',
      },
      {
        type: 'stage-done',
        stage: 'ingest-report',
        durationMs: 0,
        detail: '1 signal',
      },
      {
        type: 'stage-done',
        stage: 'store-evidence',
        durationMs: 0,
        detail: '2 signals',
      },
      {
        type: 'stage-done',
        stage: 'deliver-signals',
        durationMs: 0,
        detail: '1 finding',
      },
      {
        type: 'stage-done',
        stage: 'prepare-artifacts',
        durationMs: 0,
        detail: '2 findings',
      },
      { type: 'stage-start', stage: 'unknown-stage', label: 'unknown-stage' },
      { type: 'stage-done', stage: 'prepare-artifacts', durationMs: 0 },
    ]);
    expect(capture.headerMetadata).toEqual([
      [
        { label: 'Adapter', value: '@acme/gitleaks' },
        { label: 'Binary', value: '8.24.0' },
      ],
    ]);
    expect(capture.outcome).toMatchObject({
      kind: 'done',
      done: {
        summary: { passed: false, errors: 1, warnings: 0 },
        verboseFindings: [
          {
            title: 'scan',
            errorCount: 1,
            warningCount: 0,
            findings: [{ message: 'secret detected', location: 'src/token.ts:4' }],
          },
        ],
      },
      envelope: result.completionEnvelope,
      session: result.session,
    });
    expect(mocks.runWorkerSpec).toHaveBeenCalledWith({
      spec: {
        toolId: 'gitleaks',
        toolPackageDir: '/plugins/gitleaks',
        source: 'installed',
        commandName: 'scan',
        opts: { cwd: '/workspace', verbose: true },
        positionals: ['target'],
        presentationMode: 'adapter-live',
        config: { severity: 'high' },
      },
      ctx: args.ctx,
      cwd: '/workspace',
      cliScript: '/bin/opensip',
      timeoutMs: 4321,
      onAdapterProgress: expect.any(Function),
    });
    expect(capture.glue).toEqual({
      setExitCode: args.ctx.setExitCode,
      liveContext: { runSession: args.ctx.runSession },
    });
    expect(mocks.replayResult).toHaveBeenCalledWith(result, args.ctx, {
      commandName: 'scan',
      opts: { cwd: '/workspace', verbose: true, _args: ['target'] },
      positionals: ['target'],
    });
  });

  it('uses derived titles and omits empty finding/session adjuncts', async () => {
    const result: ToolCommandResult = {
      output: 'raw-stream',
      completionEnvelope: emptyEnvelope('custom-security-scan'),
    };
    mocks.runWorkerSpec.mockResolvedValue(result);
    const args = invocation({
      provenance: provenance('custom-security-scan'),
      opts: { quiet: true },
    });

    await runExternalAdapterLiveView(args);

    const capture = liveCaptures[0];
    expect(capture.spec.meta.title).toBe('Custom-Security-Scan');
    expect(capture.spec.quiet).toBe(true);
    expect(capture.spec.projectPath).toBe(process.cwd());
    expect(capture.headerMetadata).toEqual([
      [
        { label: 'Adapter', value: 'custom-security-scan' },
        { label: 'Binary', value: 'unresolved' },
      ],
    ]);
    expect(capture.outcome).toEqual({
      kind: 'done',
      done: {
        summary: { passed: true, errors: 0, warnings: 0 },
      },
      envelope: result.completionEnvelope,
    });
    expect(mocks.runWorkerSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 120_000,
        cwd: process.cwd(),
        spec: expect.not.objectContaining({ config: expect.anything() }),
      }),
    );
  });

  it('returns a live error when the worker result has no completion envelope', async () => {
    const result: ToolCommandResult = {
      output: 'raw-stream',
      session: {
        tool: 'gitleaks',
        cwd: '/workspace',
        score: 100,
        passed: true,
        payload: null,
      },
    };
    mocks.runWorkerSpec.mockResolvedValue(result);
    const args = invocation();

    await runExternalAdapterLiveView(args);

    expect(liveCaptures[0].outcome).toEqual({
      kind: 'error',
      message: 'external adapter worker did not return a scan envelope for live rendering',
      exitCode: 1,
    });
    expect(liveCaptures[0].headerMetadata[0]).toEqual([
      { label: 'Adapter', value: 'gitleaks' },
      { label: 'Binary', value: 'unresolved' },
    ]);
    expect(mocks.replayResult).toHaveBeenCalledWith(result, args.ctx, expect.any(Object));
  });

  it('maps typed worker failures and does not replay an absent result', async () => {
    mocks.runWorkerSpec.mockRejectedValue(new ConfigurationError('bad scanner config'));
    const args = invocation();

    await runExternalAdapterLiveView(args);

    expect(liveCaptures[0].outcome).toEqual({
      kind: 'error',
      message: 'bad scanner config',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(mocks.replayResult).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('scanner crashed'), 'scanner crashed'],
    ['worker disconnected', 'worker disconnected'],
  ])('maps an untyped worker failure to the runtime exit code', async (failure, message) => {
    mocks.runWorkerSpec.mockRejectedValue(failure);

    await runExternalAdapterLiveView(invocation());

    expect(liveCaptures[0].outcome).toEqual({
      kind: 'error',
      message,
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    });
    expect(mocks.replayResult).not.toHaveBeenCalled();
  });

  it.each([
    ['string verdict', { tool: 'gitleaks', verdict: 'invalid' }],
    // typeof null === 'object' slipped through the old guard, then threw on
    // verdict.passed in the live producer.
    ['null verdict', { tool: 'gitleaks', verdict: null }],
    [
      'missing signals/units arrays',
      { tool: 'gitleaks', runId: 'r', createdAt: 'c', verdict: { passed: true, summary: {} } },
    ],
    [
      'verdict without summary',
      {
        tool: 'gitleaks',
        runId: 'r',
        createdAt: 'c',
        verdict: { passed: true },
        signals: [],
        units: [],
      },
    ],
  ])(
    'recognizes only structurally valid completion envelopes (%s)',
    async (_label, completionEnvelope) => {
      mocks.runWorkerSpec.mockResolvedValue({
        output: 'raw-stream',
        completionEnvelope,
      });

      await runExternalAdapterLiveView(invocation());

      expect(liveCaptures[0].outcome.kind).toBe('error');
    },
  );

  it('keeps opaque ToolError failures in the runtime category', async () => {
    mocks.runWorkerSpec.mockRejectedValue(new ToolError('opaque worker failure', 'OPAQUE'));

    await runExternalAdapterLiveView(invocation());

    expect(liveCaptures[0].outcome).toMatchObject({
      kind: 'error',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    });
  });
});
