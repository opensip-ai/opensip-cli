/**
 * dispatch-host-rpc-handler — the HOST side of the ADR-0054 host-RPC upcall
 * channel (increment M4-C).
 *
 * The supervisor (`dispatch-external-tool-command.ts`) receives a worker-streamed
 * {@link HostRpcRequest} (on the transport's `progress` arm) and calls
 * {@link handleHostRpc}. This module performs the requested privileged effect
 * through the REAL host {@link ToolCliContext} — the SAME context the in-process
 * path uses (datastore via the host scope, cloud egress, FS, BaselineRepo,
 * ToolStateRepo, host planes) — and returns an {@link RpcReply} the supervisor
 * posts back to the worker via `child.send`.
 *
 * The host remains the ONLY process that performs the privileged effect. A
 * host-side fault is CAUGHT and crosses back as a structured `{ ok: false }`
 * reply (the worker shim re-throws it into the handler) — never an unhandled
 * host crash, never a silent no-op.
 */

import { canonicalToolErrorCode, ToolError } from '@opensip-cli/core';

import type {
  DeliverSignalsOpts,
  HostPlaneKind,
  HostRpcCall,
  HostRpcRequest,
  RpcReply,
} from './tool-command-dispatch-types.js';
import type { ToolCliContext } from '@opensip-cli/core';

/** A host plane impl is a record of async methods (governance/audit/entitlements). */
type HostPlaneImpl = Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>;

/**
 * The closed set of seam names the host will dispatch. The IPC `request` crosses
 * a trust boundary (it arrives over the worker's IPC channel), so the host
 * validates it against this allowlist BEFORE dispatching — an unrecognized seam
 * (e.g. a version-skewed worker) fails loud rather than silently no-op'ing. Kept
 * in sync with the {@link HostRpcCall} union by the `satisfies` assertion below.
 */
const RECOGNIZED_SEAMS = new Set<HostRpcCall['seam']>([
  'deliverSignals',
  'writeSarif',
  'writeArtifact',
  'ensureArtifactDir',
  'saveBaseline',
  'compareBaseline',
  'exportBaselineSarif',
  'exportBaselineFingerprints',
  'toolState.get',
  'toolState.put',
  'toolState.delete',
  'toolState.list',
  'maybeOpenReport',
  'getExitCode',
  'hostPlane',
] satisfies HostRpcCall['seam'][]);

/**
 * Validate an inbound IPC {@link HostRpcRequest} against the recognized-seam
 * allowlist before it is dispatched.
 *
 * @throws {TypeError} when the request shape is malformed or names a seam the
 *   host does not recognize — the host fails loud (the structured error crosses
 *   back to the worker) instead of silently ignoring an unknown upcall.
 */
function validateHostRpcRequest(request: HostRpcRequest): void {
  if (typeof request !== 'object' || typeof request.rpcId !== 'number') {
    throw new TypeError('host-RPC: malformed request (missing numeric rpcId)');
  }
  if (!RECOGNIZED_SEAMS.has(request.seam)) {
    throw new TypeError(`host-RPC: unrecognized seam '${String(request.seam)}'`);
  }
}

/**
 * Resolve the named host plane from the context's `hostPlanes` bag. A plane
 * absent on an OSS host is an explicit, structured failure — not a silent no-op.
 *
 * @throws {Error} when the host provides no impl for the requested plane (the
 *   worker re-throws it into the handler as a normal thrown error).
 */
function resolvePlane(ctx: ToolCliContext, plane: HostPlaneKind): HostPlaneImpl {
  const impl = ctx.hostPlanes?.[plane] as HostPlaneImpl | undefined;
  if (impl === undefined) {
    throw new Error(`host-RPC: hostPlanes.${plane} is not provided by this host`);
  }
  return impl;
}

/**
 * Invoke `hostPlanes.<plane>.<method>(...args)`.
 *
 * @throws {Error} when the requested plane is not provided by the host
 *   (via {@link resolvePlane}).
 * @throws {TypeError} when the named method is absent on the resolved plane —
 *   the worker re-throws it into the handler as a normal thrown error.
 */
function callHostPlane(
  ctx: ToolCliContext,
  plane: HostPlaneKind,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  const impl = resolvePlane(ctx, plane);
  const fn = impl[method];
  if (typeof fn !== 'function') {
    throw new TypeError(`host-RPC: hostPlanes.${plane}.${method} is not a function on this host`);
  }
  return fn(...args);
}

/** Narrow the serializable wire opts to the real `deliverSignals` opts shape. */
function deliverOpts(opts: DeliverSignalsOpts): Parameters<ToolCliContext['deliverSignals']>[1] {
  return {
    cwd: opts.cwd,
    ...(opts.reportTo === undefined ? {} : { reportTo: opts.reportTo }),
    ...(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey }),
    ...(opts.runFailed === undefined ? {} : { runFailed: opts.runFailed }),
  };
}

/**
 * Perform ONE host-RPC request through the real `ctx` and return its value.
 * Pure dispatch — validation + the try/catch + reply wrapping live in
 * {@link handleHostRpc}.
 */
async function performHostRpc(request: HostRpcRequest, ctx: ToolCliContext): Promise<unknown> {
  switch (request.seam) {
    case 'deliverSignals': {
      return ctx.deliverSignals(request.envelope, deliverOpts(request.opts));
    }
    case 'writeSarif': {
      return ctx.writeSarif(request.envelope, request.path);
    }
    case 'writeArtifact': {
      return ctx.writeArtifact(request.path, request.bytes);
    }
    case 'ensureArtifactDir': {
      return ctx.ensureArtifactDir(request.path);
    }
    case 'saveBaseline': {
      return ctx.saveBaseline(request.tool, request.envelope);
    }
    case 'compareBaseline': {
      return ctx.compareBaseline(request.tool, request.envelope);
    }
    case 'exportBaselineSarif': {
      return ctx.exportBaselineSarif(request.tool, request.path);
    }
    case 'exportBaselineFingerprints': {
      return ctx.exportBaselineFingerprints(request.tool, request.path);
    }
    case 'toolState.get': {
      return ctx.toolState.get(request.tool, request.key);
    }
    case 'toolState.put': {
      return ctx.toolState.put(request.tool, request.key, request.payload);
    }
    case 'toolState.delete': {
      return ctx.toolState.delete(request.tool, request.key);
    }
    case 'toolState.list': {
      return ctx.toolState.list(request.tool);
    }
    case 'maybeOpenReport': {
      return ctx.maybeOpenReport(request.opts);
    }
    case 'getExitCode': {
      return ctx.getExitCode?.();
    }
    case 'hostPlane': {
      return callHostPlane(ctx, request.plane, request.method, request.args);
    }
  }
}

/**
 * Handle one worker-streamed {@link HostRpcRequest} against the real host
 * {@link ToolCliContext} and produce the {@link RpcReply} to send back. A
 * host-side fault is caught and returned as a structured `{ ok: false }` reply
 * (the supervisor sends it; the worker shim re-throws it into the handler).
 */
export async function handleHostRpc(
  request: HostRpcRequest,
  ctx: ToolCliContext,
): Promise<RpcReply> {
  try {
    // Validate the inbound IPC request against the recognized-seam allowlist
    // before dispatching (defense-in-depth for the trust boundary; fail loud on
    // a malformed or version-skewed upcall rather than silently no-op'ing).
    validateHostRpcRequest(request);
    const value = await performHostRpc(request, ctx);
    return { kind: 'rpc-reply', rpcId: request.rpcId, ok: true, value };
  } catch (error) {
    return {
      kind: 'rpc-reply',
      rpcId: request.rpcId,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...((error as { code?: unknown }).code !== undefined &&
        typeof (error as { code?: unknown }).code === 'string'
          ? { code: (error as { code: string }).code }
          : {}),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        // Carry the canonical exit-class code for a typed ToolError (e.g. a
        // compareBaseline BASELINE_MISSING rejection → CONFIGURATION_ERROR) so the
        // worker shim re-throws a TYPED error and the exit class survives the
        // boundary instead of degrading to a plain Error → SystemError → exit 1.
        ...(error instanceof ToolError ? { toolErrorCode: canonicalToolErrorCode(error) } : {}),
      },
    };
  }
}
