/**
 * tool-command-worker-context — the WORKER-side {@link ToolCliContext} shim for
 * the ADR-0054 out-of-process dispatch plane (increments M4-C / M4-D).
 *
 * Each seam the worker exposes to the dispatched handler is implemented per its
 * transport strategy from ADR-0054's M4-C mapping table:
 *
 *   - final-result-return (FRR): `render` / `emitJson` / `emitEnvelope` /
 *     `emitRaw` / `emitError` / `setExitCode` record into a {@link
 *     ResultAccumulator} drained into a `ToolCommandResult` after the handler
 *     resolves; the host replays them through the real seams.
 *   - host-RPC (RPC): `deliverSignals` / `writeSarif` / the four baseline seams
 *     / `writeArtifact` / `ensureArtifactDir` / `toolState.*` / `hostPlanes.*` /
 *     `maybeOpenReport` issue a typed {@link HostRpcRequest} via the
 *     {@link WorkerRpcClient} and await the host's reply — the HOST performs
 *     the privileged effect (datastore / egress / FS / process exit) and returns
 *     the result. `getExitCode` stays sync-local by contract: it reads the
 *     accumulator's exit-code mirror, which every ok RPC reply refreshes with
 *     the host's post-effect code (`RpcReply.hostExitCode`) — so a handler that
 *     calls `deliverSignals` then reads `getExitCode()` sees what an in-process
 *     run would.
 *   - host-only (fail loud): the live-view seams (`registerLiveView` /
 *     `renderLive`) throw {@link UnsupportedSeamError} — Ink/TTY rendering
 *     cannot leave the host (documented as a later increment).
 *
 * `scope` / `runSession` / `logger` are backed by the worker's own minimal
 * {@link RunScope} + run timer (the worker re-bootstraps its own scope; it never
 * ships a live `RunScope` across IPC).
 */

import {
  assertCapturedOutputFits,
  getWorkerLimits,
  type GateCompareResult,
  type HostAudit,
  type HostEntitlements,
  type HostGovernance,
  type ReportFailureDetail,
  type ResolvedReportFailure,
  type RunScope,
  type RunTimer,
  type SignalDeliveryResult,
  type ToolCliContext,
} from '@opensip-cli/core';
import {
  attachExternalAdapterProgress,
  type ExternalAdapterProgressBridge,
} from '@opensip-cli/external-tool-adapter';

import { resolveReportFailure, toReportedFailureWire } from './report-failure.js';

import type {
  HostPlaneKind,
  HostPlaneMethodName,
  HostRpcCall,
  ToolCommandFailureClass,
  ToolCommandResult,
} from './tool-command-dispatch-types.js';
import type { WorkerRpcClient } from './tool-command-worker-rpc.js';

/**
 * A loud, marked failure for a seam the worker shim cannot marshal (the
 * live-view seams). Carries the {@link ToolCommandFailureClass} so the
 * supervisor can triage; the worker catch turns it into an `error` IPC message.
 */
export class UnsupportedSeamError extends Error {
  readonly failureClass: ToolCommandFailureClass = 'unsupported-seam';
  constructor(seam: string) {
    super(
      `tool command worker: seam '${seam}' cannot be marshalled across the ADR-0054 ` +
        'dispatch boundary (Ink/TTY rendering stays host-side). The external command ' +
        'attempted a live-view effect the worker cannot perform.',
    );
    this.name = 'UnsupportedSeamError';
  }
}

/**
 * Build a host-only seam stub that fails loudly when an external handler calls a
 * seam the worker cannot marshal (the live-view seams).
 *
 * @throws {UnsupportedSeamError} always — that is the point: an unmarshallable
 *   seam must surface as a structured failure, never a silent no-op.
 */
function unsupported(seam: string): (...args: unknown[]) => never {
  return () => {
    throw new UnsupportedSeamError(seam);
  };
}

/**
 * The mutable accumulator the worker-side context shim records final-result
 * seam calls into. Drained into a {@link ToolCommandResult} after the handler
 * resolves.
 */
export interface ResultAccumulator {
  render?: unknown;
  envelope?: unknown;
  json?: unknown;
  raw?: unknown;
  error?: ToolCommandResult['error'];
  reportedFailure?: ResolvedReportFailure;
  exitCode?: number;
}

/** Issue one RPC upcall and cast the host's reply to the seam's return type. */
function rpc<T>(client: WorkerRpcClient, request: HostRpcCall): Promise<T> {
  return client.call(request) as Promise<T>;
}

/** Build the RPC-backed `toolState` member (ADR-0042 datastore-backed). */
function buildToolStateRpc(client: WorkerRpcClient): ToolCliContext['toolState'] {
  return {
    get: (tool, key) => rpc(client, { seam: 'toolState.get', tool, key }),
    put: (tool, key, payload) => rpc<void>(client, { seam: 'toolState.put', tool, key, payload }),
    delete: (tool, key) => rpc<void>(client, { seam: 'toolState.delete', tool, key }),
    list: (tool) => rpc<readonly string[]>(client, { seam: 'toolState.list', tool }),
  };
}

/**
 * Make one host-plane method into a generic `hostPlane` upcall
 * (`plane`/`method`/`args`). The host dispatches to the real plane impl by name;
 * the worker never holds a plane handle.
 */
function planeMethod<P extends HostPlaneKind, R>(
  client: WorkerRpcClient,
  plane: P,
  method: HostPlaneMethodName<P>,
): (...args: readonly unknown[]) => Promise<R> {
  return (...args) => rpc<R>(client, { seam: 'hostPlane', plane, method, args } as HostRpcCall);
}

/**
 * Build the RPC-backed `hostPlanes` bag (governance / audit / entitlements).
 * Each plane's methods are enumerated explicitly (rather than via a Proxy) so
 * the shim conforms to the core host-plane interfaces structurally — every
 * method routes through {@link planeMethod} to a generic `hostPlane` upcall.
 */
function buildHostPlanesRpc(client: WorkerRpcClient): NonNullable<ToolCliContext['hostPlanes']> {
  const governance: HostGovernance = {
    getGovernanceState: planeMethod(client, 'governance', 'getGovernanceState'),
    queryAudit: planeMethod(client, 'governance', 'queryAudit'),
    recordInstallation: planeMethod(client, 'governance', 'recordInstallation'),
    recordApprovalDecision: planeMethod(client, 'governance', 'recordApprovalDecision'),
    setBlock: planeMethod(client, 'governance', 'setBlock'),
    checkAllowed: planeMethod(client, 'governance', 'checkAllowed'),
  };
  const audit: HostAudit = {
    append: planeMethod(client, 'audit', 'append'),
    query: planeMethod(client, 'audit', 'query'),
  };
  const entitlements: HostEntitlements = {
    check: planeMethod(client, 'entitlements', 'check'),
    recordUsage: planeMethod(client, 'entitlements', 'recordUsage'),
    getLicenseState: planeMethod(client, 'entitlements', 'getLicenseState'),
  };
  return { governance, audit, entitlements };
}

/** Inputs for {@link buildWorkerContext} — bundled so the seam stays narrow. */
export interface BuildWorkerContextInput {
  readonly scope: RunScope;
  readonly timing: RunTimer;
  readonly acc: ResultAccumulator;
  readonly rpcClient: WorkerRpcClient;
  /** Byte cap for captured worker output (defaults to the worker limits). */
  readonly maxCapturedOutputBytes?: number;
  readonly adapterProgress?: ExternalAdapterProgressBridge;
}

/**
 * Build the worker-side {@link ToolCliContext} shim. FRR seams record into
 * `acc`; RPC seams upcall via `rpcClient`; the live-view seams fail loud.
 *
 * The `scope` is the same already-restricted RunScope the worker bootstrap built
 * (local project/config/parse state; ambient datastore denied). This builder
 * does not replace, re-enable, or re-wrap the datastore thunk.
 */
export function buildWorkerContext(input: BuildWorkerContextInput): ToolCliContext {
  const { scope, timing, acc, rpcClient, adapterProgress } = input;
  const maxCapturedOutputBytes =
    input.maxCapturedOutputBytes ?? getWorkerLimits().maxCapturedOutputBytes;
  const cap = (field: string, value: unknown): void => {
    assertCapturedOutputFits(field, value, maxCapturedOutputBytes);
  };
  const ctx: ToolCliContext = {
    scope,
    runSession: { timing },
    logger: scope.logger,
    // ── Final-result-return seams (recorded, replayed host-side) ──────────
    render: (result: unknown) => {
      cap('render', result);
      acc.render = result;
      return Promise.resolve();
    },
    emitJson: (value: unknown) => {
      cap('json', value);
      acc.json = value;
    },
    emitEnvelope: (envelope: unknown) => {
      cap('envelope', envelope);
      acc.envelope = envelope;
    },
    emitRaw: (value: unknown) => {
      cap('raw', value);
      acc.raw = value;
    },
    emitError: (detail) => {
      acc.error = {
        message: detail.message,
        exitCode: detail.exitCode,
        ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
        ...(detail.code === undefined ? {} : { code: detail.code }),
        ...(detail.failure === undefined ? {} : { failure: detail.failure }),
      };
    },
    reportFailure: (detail: ReportFailureDetail) => {
      const resolved = resolveReportFailure(detail);
      const wire = toReportedFailureWire(resolved);
      cap('reportedFailure', wire);
      acc.reportedFailure = wire;
      return Promise.resolve();
    },
    setExitCode: (code: number) => {
      acc.exitCode = code;
    },
    // ── Host-RPC seams (M4-C upcalls — host performs the effect) ──────────
    // Sync-local by contract; the accumulator mirror is refreshed with the
    // host's post-effect exit code on every ok RPC reply (see module header).
    getExitCode: () => acc.exitCode,
    deliverSignals: (envelope, opts) =>
      rpc<SignalDeliveryResult>(rpcClient, {
        seam: 'deliverSignals',
        envelope,
        opts: {
          cwd: opts.cwd,
          ...(opts.reportTo === undefined ? {} : { reportTo: opts.reportTo }),
          ...(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey }),
          ...(opts.runFailed === undefined ? {} : { runFailed: opts.runFailed }),
        },
      }),
    writeSarif: (envelope, path) => rpc<void>(rpcClient, { seam: 'writeSarif', envelope, path }),
    writeArtifact: (path, bytes) => rpc<void>(rpcClient, { seam: 'writeArtifact', path, bytes }),
    ensureArtifactDir: (path) => rpc<void>(rpcClient, { seam: 'ensureArtifactDir', path }),
    saveBaseline: (tool, envelope) =>
      rpc<void>(rpcClient, { seam: 'saveBaseline', tool, envelope }),
    compareBaseline: (tool, envelope) =>
      rpc<GateCompareResult>(rpcClient, {
        seam: 'compareBaseline',
        tool,
        envelope,
      }),
    exportBaselineSarif: (tool, path) =>
      rpc<void>(rpcClient, { seam: 'exportBaselineSarif', tool, path }),
    exportBaselineFingerprints: (tool, path) =>
      rpc<void>(rpcClient, { seam: 'exportBaselineFingerprints', tool, path }),
    maybeOpenReport: (opts) =>
      rpc<void>(rpcClient, {
        seam: 'maybeOpenReport',
        opts: {
          openRequested: opts.openRequested,
          jsonOutput: opts.jsonOutput,
        },
      }),
    toolState: buildToolStateRpc(rpcClient),
    hostPlanes: buildHostPlanesRpc(rpcClient),
    // ── Live-view seams (host-only — fail loud) ───────────────────────────
    registerLiveView: unsupported('registerLiveView'),
    renderLive: unsupported('renderLive'),
  };
  return adapterProgress === undefined ? ctx : attachExternalAdapterProgress(ctx, adapterProgress);
}
