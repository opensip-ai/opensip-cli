/**
 * tool-command-worker-rpc — the WORKER side of the ADR-0054 host-RPC upcall
 * channel (increment M4-C).
 *
 * A host-RPC seam in the worker shim (`tool-command-worker-context.ts`) calls
 * `hostRpc(request)`: it stamps a monotonic `rpcId`, posts the request to the
 * parent over the transport's `progress` arm
 * (`WorkerMessage<HostRpcRequest, ToolCommandResult>`), and BLOCKS on the
 * matching {@link RpcReply} the parent posts back via `child.send`. The host
 * performs the privileged effect through the real `ToolCliContext` and replies;
 * a host-side fault crosses back as `{ ok: false, error }`, which this re-throws
 * so the handler sees a normal thrown error (never a host crash, never a silent
 * no-op).
 *
 * Replies are delivered on the worker's single `process.on('message')` listener,
 * installed once and demultiplexed by `rpcId` into the pending-request map. The
 * listener ignores anything that is not an `rpc-reply` (the channel is otherwise
 * child → parent), so it never races the worker's own outbound posts.
 */

import { toolErrorFromCanonicalCode } from '@opensip-cli/core';

import type { HostRpcCall, HostRpcRequest, RpcReply } from './tool-command-dispatch-types.js';
import type { WorkerMessage } from '@opensip-cli/core';

/** The worker's outbound IPC type binding: requests stream on `progress`. */
type WorkerOutbound = WorkerMessage<HostRpcRequest, unknown>;

/**
 * A worker RPC client: `call` issues one upcall and resolves with the host's
 * reply value (or rejects with the host's structured error). `dispose` removes
 * the reply listener (hygiene for the short-lived fork; the process exits on
 * settle regardless).
 */
export interface WorkerRpcClient {
  /**
   * Issue one host-RPC upcall (sans `rpcId` — assigned here) and await the
   * host's reply.
   *
   * @throws {Error} when the host reply is `{ ok: false }` (the host-side fault
   *   re-thrown into the handler), or when the worker is not forked with an IPC
   *   channel (no `process.send`, an integration-only misuse).
   */
  readonly call: (request: HostRpcCall) => Promise<unknown>;
  readonly dispose: () => void;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Reconstruct an Error from a host reply's structured error (preserving stack).
 *
 * When the host carried a canonical exit-class `toolErrorCode` (the fault was a
 * typed `ToolError`, e.g. a `compareBaseline` BASELINE_MISSING rejection), rebuild
 * the matching `ToolError` SUBCLASS — preserving the original subcode as `.code`
 * — so the handler re-throws a TYPED error and the exit class survives the worker
 * boundary (it propagates to the worker entry's catch, which maps a
 * `ConfigurationError` → `config-invalid` → host exit 2). Otherwise (an untyped
 * host fault, or an unrecognized code) fall back to a plain `Error` carrying the
 * subcode, exactly as before.
 */
function rpcError(detail: {
  message: string;
  code?: string;
  stack?: string;
  toolErrorCode?: string;
}): Error {
  if (detail.toolErrorCode !== undefined) {
    const typed = toolErrorFromCanonicalCode(detail.toolErrorCode, detail.message, {
      ...(detail.code === undefined ? {} : { code: detail.code }),
    });
    if (typed !== undefined) {
      if (detail.stack !== undefined) typed.stack = detail.stack;
      return typed;
    }
  }
  const err = new Error(detail.message) as Error & { code?: string };
  if (detail.code !== undefined) err.code = detail.code;
  if (detail.stack !== undefined) err.stack = detail.stack;
  return err;
}

/** Narrow an arbitrary IPC message to a {@link RpcReply}. */
function isRpcReply(msg: unknown): msg is RpcReply {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { kind?: unknown }).kind === 'rpc-reply' &&
    typeof (msg as { rpcId?: unknown }).rpcId === 'number'
  );
}

/**
 * Create the worker's RPC client over the live IPC channel. Installs the single
 * reply listener; `send` posts requests on the `progress` arm. The caller passes
 * `process` so unit tests can supply a fake duplex.
 */
export function createWorkerRpcClient(channel: {
  send?: (msg: WorkerOutbound) => unknown;
  on: (event: 'message', listener: (msg: unknown) => void) => unknown;
  off?: (event: 'message', listener: (msg: unknown) => void) => unknown;
}): WorkerRpcClient {
  const pending = new Map<number, PendingCall>();
  let nextId = 1;

  const onMessage = (msg: unknown): void => {
    if (!isRpcReply(msg)) return; // not a reply — the channel is otherwise outbound
    const waiter = pending.get(msg.rpcId);
    if (waiter === undefined) return; // unknown/duplicate rpcId — defensively ignore
    pending.delete(msg.rpcId);
    if (msg.ok) waiter.resolve(msg.value);
    else waiter.reject(rpcError(msg.error));
  };
  channel.on('message', onMessage);

  return {
    call: (request) =>
      new Promise<unknown>((resolve, reject) => {
        if (channel.send === undefined) {
          reject(
            new Error(
              'tool command worker: no IPC channel to issue a host-RPC upcall ' +
                `('${request.seam}') — the worker must be forked with an 'ipc' stdio channel.`,
            ),
          );
          return;
        }
        const rpcId = nextId++;
        pending.set(rpcId, { resolve, reject });
        const event: HostRpcRequest = { ...request, rpcId };
        // Call through `channel.send(...)` (not an extracted reference) so the
        // method keeps its `this` binding — `process.send` reads `this.connected`
        // internally and throws if invoked unbound.
        channel.send({ kind: 'progress', event });
      }),
    dispose: () => {
      channel.off?.('message', onMessage);
      pending.clear();
    },
  };
}
