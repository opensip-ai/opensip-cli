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

import { canonicalToolErrorCode, SystemError, ToolError } from '@opensip-cli/core';
import { datastoreErrorCatalog } from '@opensip-cli/datastore';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import { HOST_PLANE_METHODS } from './tool-command-dispatch-types.js';

const PLANE_UNAVAILABLE = hostErrorCatalog.require('CLI.HOST.PLANE_UNAVAILABLE');

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

const HOST_PLANE_KINDS = new Set<string>(Object.keys(HOST_PLANE_METHODS));

/**
 * Stable codes permitted to cross from the host back into an external worker.
 *
 * A SECURITY BOUNDARY, so it stays an explicit list rather than a predicate over the catalog —
 * "every registered code may cross" is a different and much weaker policy than "these eleven
 * may". But the list must name codes that can actually be raised: when Plan 01 clustered the
 * host codes, the old literals here stopped matching anything, which would have silently
 * filtered every one of them out at the worker boundary. Derived from the host catalog's
 * definitions so a rename is a compile error, not a silent narrowing.
 */
const ALLOWED_HOST_RPC_ERROR_CODES = new Set<string>([
  hostErrorCatalog.require('CLI.GATE.BASELINE_INVALID').code,
  hostErrorCatalog.require('CLI.POLICY.DENIED').code,
  hostErrorCatalog.require('CLI.HOST.OPTION_INVALID').code,
  hostErrorCatalog.require('CLI.HOST.ARTIFACT_WRITE_FAILED').code,
  hostErrorCatalog.require('CLI.HOST_IDENTITY.RESERVED').code,
  datastoreErrorCatalog.require('DATASTORE.WRITE.RECORD_TOO_LARGE').code,
]);

/**
 * Fixed operator-facing text for conditions whose own message would leak host detail.
 *
 * Keyed by `metadata.condition`, not by code: the gate conditions now SHARE
 * `CLI.GATE.BASELINE_INVALID` (ruling D9 clustering), so a code-keyed map would
 * never match again — a silent loss of the one message this table exists to fix.
 */
const FIXED_CONDITION_MESSAGES: Readonly<Record<string, string>> = {
  'baseline-missing': 'No baseline found for this tool — run with --gate-save first',
};

function replyRpcId(request: unknown): number {
  if (typeof request !== 'object' || request === null) return -1;
  const rpcId = (request as { rpcId?: unknown }).rpcId;
  return typeof rpcId === 'number' && Number.isSafeInteger(rpcId) && rpcId >= 0 ? rpcId : -1;
}

function allowlistedErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ToolError)) return undefined;
  return ALLOWED_HOST_RPC_ERROR_CODES.has(error.code) ? error.code : undefined;
}

/**
 * Validate an inbound IPC {@link HostRpcRequest} against the recognized-seam
 * allowlist before it is dispatched. For hostPlane calls also validate
 * rpcId, known plane, allowlisted method, and array args (ADR-0146).
 *
 * @throws {TypeError} when the request shape is malformed or names a seam the
 *   host does not recognize — the host fails loud (the structured error crosses
 *   back to the worker) instead of silently ignoring an unknown upcall.
 */
function validateHostRpcRequest(request: unknown): asserts request is HostRpcRequest {
  if (typeof request !== 'object' || request === null) {
    throw new TypeError('host-RPC: malformed request');
  }
  const candidate = request as Record<string, unknown>;
  if (
    typeof candidate.rpcId !== 'number' ||
    !Number.isSafeInteger(candidate.rpcId) ||
    candidate.rpcId < 0
  ) {
    throw new TypeError('host-RPC: malformed request (rpcId must be a nonnegative safe integer)');
  }
  if (!RECOGNIZED_SEAMS.has(candidate.seam as HostRpcCall['seam'])) {
    throw new TypeError(`host-RPC: unrecognized seam '${String(candidate.seam)}'`);
  }
  if (candidate.seam === 'hostPlane') {
    const plane = candidate.plane;
    if (typeof plane !== 'string' || !HOST_PLANE_KINDS.has(plane)) {
      throw new TypeError(`host-RPC: unknown host plane '${String(plane)}'`);
    }
    // Wire payloads may carry arbitrary strings; validate via string form so
    // prototype/unknown method names are rejected before property lookup.
    const rawMethod = candidate.method;
    const method = typeof rawMethod === 'string' ? rawMethod : '';
    const allowed = HOST_PLANE_METHODS[plane as HostPlaneKind] as readonly string[];
    if (
      method.length === 0 ||
      method === '__proto__' ||
      method === 'constructor' ||
      method === 'prototype' ||
      !allowed.includes(method)
    ) {
      throw new TypeError(`host-RPC: method '${method}' is not allowlisted on plane '${plane}'`);
    }
    if (!Array.isArray(candidate.args)) {
      throw new TypeError('host-RPC: hostPlane args must be an array');
    }
  }
}

/**
 * Resolve the named host plane from the context's `hostPlanes` bag. A plane
 * absent on an OSS host is an explicit, structured failure — not a silent no-op.
 *
 * @throws {SystemError} when the host provides no impl for the requested plane (the
 *   worker re-throws it into the handler as a normal thrown error).
 */
function resolvePlane(ctx: ToolCliContext, plane: HostPlaneKind): HostPlaneImpl {
  const impl = ctx.hostPlanes?.[plane] as HostPlaneImpl | undefined;
  if (impl === undefined) {
    throw new SystemError(`host-RPC: hostPlanes.${plane} is not provided by this host`, {
      code: PLANE_UNAVAILABLE.code,
      definition: PLANE_UNAVAILABLE,
      metadata: { condition: 'plane-absent', plane },
    });
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
export async function handleHostRpc(request: unknown, ctx: ToolCliContext): Promise<RpcReply> {
  const rpcId = replyRpcId(request);
  try {
    // Validate the inbound IPC request against the recognized-seam allowlist
    // before dispatching (defense-in-depth for the trust boundary; fail loud on
    // a malformed or version-skewed upcall rather than silently no-op'ing).
    validateHostRpcRequest(request);
    const value = await performHostRpc(request, ctx);
    // Mirror the post-effect host exit code so the worker's sync getExitCode()
    // stays coherent with host-side mutations (e.g. deliverSignals).
    const hostExitCode = ctx.getExitCode?.();
    return {
      kind: 'rpc-reply',
      rpcId,
      ok: true,
      value,
      ...(hostExitCode === undefined ? {} : { hostExitCode }),
    };
  } catch (error) {
    // Bounded failure reply — never echo host stacks, paths, or arbitrary
    // exception text across the worker IPC boundary (ADR-0146). Known stable
    // codes may map to fixed, allowlisted user messages; everything else uses
    // a generic seam message.
    const code = allowlistedErrorCode(error);
    // The condition is read only for an ALREADY-ALLOWLISTED code, so a hostile value cannot
    // reach this table by supplying its own metadata.
    const condition =
      code !== undefined && error instanceof ToolError ? error.metadata.condition : undefined;
    const fixed = typeof condition === 'string' ? FIXED_CONDITION_MESSAGES[condition] : undefined;
    const message = fixed ?? 'host-RPC seam failed';
    return {
      kind: 'rpc-reply',
      rpcId,
      ok: false,
      error: {
        message,
        ...(code === undefined ? {} : { code }),
        // Carry the canonical exit-class code for a typed ToolError (e.g. a
        // compareBaseline BASELINE_MISSING rejection → CONFIGURATION_ERROR) so the
        // worker shim re-throws a TYPED error and the exit class survives the
        // boundary instead of degrading to a plain Error → SystemError → exit 1.
        ...(error instanceof ToolError ? { toolErrorCode: canonicalToolErrorCode(error) } : {}),
      },
    };
  }
}
