import { UnknownLiveViewError, createRunTimer } from '@opensip-cli/core';

import { makeTestScope } from './scope.js';

import type {
  CommandSpec,
  GateCompareResult,
  LiveViewRenderer,
  Logger,
  ReportFailureDetail,
  SignalDeliveryResult,
  ToolCliContext,
  ToolScope,
} from '@opensip-cli/core';

export interface CapturedLogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string | Record<string, unknown>;
  readonly data?: Record<string, unknown>;
}

export interface CapturedEmitError {
  readonly message: string;
  readonly exitCode: number;
  readonly suggestion?: string;
  readonly code?: string;
  readonly diagnostic?: unknown;
}

export interface CapturedDelivery {
  readonly envelope: unknown;
  readonly opts: {
    readonly cwd: string;
    readonly reportTo?: string;
    readonly apiKey?: string;
    readonly runFailed?: boolean;
  };
}

export interface CapturedArtifactWrite {
  readonly path: string;
  readonly bytes: string;
}

export interface CapturedBaselineCompare {
  readonly tool: string;
  readonly envelope: unknown;
}

export interface CapturedBaselineExport {
  readonly tool: string;
  readonly path: string;
}

export interface ToolCliContextCaptured {
  readonly rendered: unknown[];
  readonly json: unknown[];
  readonly envelopes: unknown[];
  readonly raw: unknown[];
  readonly errors: CapturedEmitError[];
  readonly reportFailures: ReportFailureDetail[];
  readonly exitCodes: number[];
  readonly liveViews: Map<string, LiveViewRenderer>;
  readonly liveRenders: { readonly key: string; readonly args: unknown }[];
  readonly maybeOpenReport: {
    readonly openRequested: boolean;
    readonly jsonOutput: boolean;
  }[];
  readonly deliveredSignals: CapturedDelivery[];
  readonly sarifWrites: { readonly envelope: unknown; readonly path: string }[];
  readonly artifactWrites: CapturedArtifactWrite[];
  readonly savedBaselines: CapturedBaselineCompare[];
  readonly comparedBaselines: CapturedBaselineCompare[];
  readonly exportedBaselineSarif: CapturedBaselineExport[];
  readonly exportedBaselineFingerprints: CapturedBaselineExport[];
  readonly toolState: Map<string, Map<string, unknown>>;
  readonly logs: CapturedLogEntry[];
}

export interface ToolCliContextDoubleOptions {
  readonly scope?: ToolScope;
  readonly deliveryResult?: SignalDeliveryResult;
  readonly compareResult?: GateCompareResult;
}

export interface ToolCliContextDouble {
  readonly ctx: ToolCliContext;
  readonly captured: ToolCliContextCaptured;
}

export interface CommandSpecRunResult<TResult = unknown> extends ToolCliContextDouble {
  readonly result: TResult;
}

function createCaptured(): ToolCliContextCaptured {
  return {
    rendered: [],
    json: [],
    envelopes: [],
    raw: [],
    errors: [],
    reportFailures: [],
    exitCodes: [],
    liveViews: new Map(),
    liveRenders: [],
    maybeOpenReport: [],
    deliveredSignals: [],
    sarifWrites: [],
    artifactWrites: [],
    savedBaselines: [],
    comparedBaselines: [],
    exportedBaselineSarif: [],
    exportedBaselineFingerprints: [],
    toolState: new Map(),
    logs: [],
  };
}

function createCapturedLogger(captured: ToolCliContextCaptured): Logger {
  const push = (
    level: CapturedLogEntry['level'],
    message: string | Record<string, unknown>,
    data?: Record<string, unknown>,
  ): void => {
    captured.logs.push({ level, message, ...(data === undefined ? {} : { data }) });
  };
  return {
    debug: (message, data) => push('debug', message, data),
    info: (message, data) => push('info', message, data),
    warn: (message, data) => push('warn', message, data),
    error: (message, data) => push('error', message, data),
  };
}

function toolStateBucket(captured: ToolCliContextCaptured, tool: string): Map<string, unknown> {
  let bucket = captured.toolState.get(tool);
  if (bucket === undefined) {
    bucket = new Map();
    captured.toolState.set(tool, bucket);
  }
  return bucket;
}

export function createToolCliContextDouble(
  opts: ToolCliContextDoubleOptions = {},
): ToolCliContextDouble {
  const captured = createCaptured();
  const logger = createCapturedLogger(captured);
  const scope = opts.scope ?? makeTestScope({ logger });
  const deliveryResult = opts.deliveryResult ?? { cloudAccepted: 0 };
  const compareResult =
    opts.compareResult ??
    ({
      added: [],
      resolved: [],
      unchanged: [],
      degraded: false,
    } satisfies GateCompareResult);

  let exitCode: number | undefined;

  const ctx: ToolCliContext = {
    scope,
    runSession: { timing: createRunTimer() },
    render: (result) => {
      captured.rendered.push(result);
      return Promise.resolve();
    },
    registerLiveView: (key, renderer) => {
      if (captured.liveViews.has(key)) {
        logger.warn({
          evt: 'tool_test_kit.live_view.duplicate',
          key,
          message: `duplicate live view registration for ${key}`,
        });
        return;
      }
      captured.liveViews.set(key, renderer);
    },
    renderLive: (key, args, liveContext) => {
      captured.liveRenders.push({ key, args });
      const renderer = captured.liveViews.get(key);
      if (renderer === undefined) return Promise.reject(new UnknownLiveViewError(key));
      return Promise.resolve().then(() =>
        renderer(args, liveContext ?? { runSession: ctx.runSession }),
      );
    },
    maybeOpenReport: (request) => {
      captured.maybeOpenReport.push(request);
      return Promise.resolve();
    },
    logger,
    reportFailure: (detail) => {
      captured.reportFailures.push(detail);
      return Promise.resolve();
    },
    setExitCode: (code) => {
      exitCode = code;
      captured.exitCodes.push(code);
    },
    getExitCode: () => exitCode,
    emitJson: (value) => {
      captured.json.push(value);
    },
    emitEnvelope: (envelope) => {
      captured.envelopes.push(envelope);
    },
    emitError: (detail) => {
      captured.errors.push(detail);
      ctx.setExitCode(detail.exitCode);
    },
    emitRaw: (value) => {
      captured.raw.push(value);
    },
    deliverSignals: (envelope, request) => {
      captured.deliveredSignals.push({ envelope, opts: request });
      return Promise.resolve(deliveryResult);
    },
    writeSarif: (envelope, path) => {
      captured.sarifWrites.push({ envelope, path });
      return Promise.resolve();
    },
    writeArtifact: (path, bytes) => {
      captured.artifactWrites.push({ path, bytes });
      return Promise.resolve();
    },
    saveBaseline: (tool, envelope) => {
      captured.savedBaselines.push({ tool, envelope });
      return Promise.resolve();
    },
    compareBaseline: (tool, envelope) => {
      captured.comparedBaselines.push({ tool, envelope });
      return Promise.resolve(compareResult);
    },
    exportBaselineSarif: (tool, path) => {
      captured.exportedBaselineSarif.push({ tool, path });
      return Promise.resolve();
    },
    exportBaselineFingerprints: (tool, path) => {
      captured.exportedBaselineFingerprints.push({ tool, path });
      return Promise.resolve();
    },
    toolState: {
      get: (tool, key) => Promise.resolve(toolStateBucket(captured, tool).get(key)),
      put: (tool, key, payload) => {
        toolStateBucket(captured, tool).set(key, payload);
        return Promise.resolve();
      },
      delete: (tool, key) => {
        toolStateBucket(captured, tool).delete(key);
        return Promise.resolve();
      },
      list: (tool) => Promise.resolve([...toolStateBucket(captured, tool).keys()].sort()),
    },
  };

  return { ctx, captured };
}

export async function runCommandSpec<TOpts, TResult = unknown>(
  spec: CommandSpec<TOpts, ToolCliContext>,
  opts: TOpts,
  double: ToolCliContextDouble = createToolCliContextDouble(),
): Promise<CommandSpecRunResult<TResult>> {
  const result = (await spec.handler(opts, double.ctx)) as TResult;
  return { ...double, result };
}
