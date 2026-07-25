/**
 * Clean fixture for `error-floating-async-operation`.
 *
 * Every shape here is one the human reviewers explicitly ACCEPTED while
 * triaging the floating-async ledger. Reduced from real accepted sites:
 *
 *   - packages/cli/src/bootstrap/dispatch-fork-core.ts:264
 *       `void handleHostRpc(request, ctx).then(...).catch(() => { ... });`
 *     Detached on purpose, but the chain terminates in a rejection handler.
 *     (Reviewers faulted that site for SWALLOWING the rejection — a different
 *     defect class this check deliberately does not judge.)
 *   - packages/agent-eval/src/adapters/opensip-mcp-connection.ts:439
 *       `void this.beginInternalClose().catch(() => false);`
 *   - packages/agent-eval/src/adapters/opensip-mcp.ts:195
 *       `await connection?.close().catch((closeError: unknown) => { void closeError; });`
 *     Awaited, and `void closeError;` discards a VARIABLE — nothing was started.
 *   - packages/cli/src/bootstrap/output-plane.ts
 *       `renderOutcome(...).catch((error) => { ...log... });`
 *
 * Expected: zero findings.
 */

interface RpcReply {
  id: number;
}

declare function handleHostRpc(request: unknown): Promise<RpcReply>;
declare function sendRpcReply(reply: RpcReply): void;
declare function renderOutcome(outcome: unknown): Promise<void>;
declare const log: { error: (fields: Record<string, unknown>) => void };

export function serveRpc(request: unknown): void {
  // Detached, but the chain observes rejection. Not this check's business.
  void handleHostRpc(request)
    .then((reply: RpcReply) => {
      sendRpcReply(reply);
    })
    .catch(() => {
      log.error({ evt: 'rpc.failed' });
    });
}

export function emitError(outcome: unknown): void {
  // `.catch(...)`-terminated detached chain — the accepted shape.
  renderOutcome(outcome).catch((error: unknown) => {
    log.error({ evt: 'cli.emit_error.render_failed', error });
  });
}

export function twoArgThen(outcome: unknown): void {
  // The two-argument `.then(onFulfilled, onRejected)` form also handles rejection.
  void renderOutcome(outcome).then(
    () => log.error({ evt: 'ok' }),
    (error: unknown) => log.error({ evt: 'failed', error }),
  );
}

export class Connection {
  private async beginInternalClose(): Promise<boolean> {
    await Promise.resolve();
    return true;
  }

  failProtocol(): void {
    // R2's shape, but guarded.
    void this.beginInternalClose().catch(() => false);
  }

  async rollback(connection: { close: () => Promise<void> } | undefined): Promise<void> {
    await connection?.close().catch((closeError: unknown) => {
      // `void` on a VARIABLE — no async operation was started here.
      void closeError;
    });
  }
}

export async function ownedPromises(): Promise<string> {
  const pending = Promise.resolve('a').then((value) => value.toUpperCase());
  const settled = await pending;
  const both = [Promise.resolve('b').then((value) => value)];
  return `${settled}${await both[0]!}`;
}

export function returnedChain(): Promise<string> {
  // Returned — the caller owns the rejection.
  return Promise.resolve('c').then((value) => value.trim());
}
