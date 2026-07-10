/**
 * tool-command-host-rpc — unit coverage for the ADR-0054 M4-C host-RPC upcall
 * channel, exercised IN-PROCESS (no fork) so coverage instrumentation observes
 * both ends:
 *
 *   - the worker-side {@link createWorkerRpcClient} round-trip over a FAKE duplex
 *     channel (request stamped with a monotonic rpcId; resolves on the matching
 *     reply; rejects on a structured `{ ok: false }` reply);
 *   - the host-side {@link handleHostRpc} switch, which performs each RPC seam
 *     through a stub `ToolCliContext` and wraps the result (or a host fault) in a
 *     structured {@link RpcReply}.
 *
 * The forked end-to-end RPC boundary is proven separately in
 * `external-tool-dispatch.test.ts` (modes `rpc` / `rpc-fail`).
 */

import { ConfigurationError } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { handleHostRpc } from '../bootstrap/dispatch-host-rpc-handler.js';
import { createWorkerRpcClient } from '../bootstrap/tool-command-worker-rpc.js';

import { makeDispatchHostCtx } from './harness/dispatch-host-ctx.js';

import type {
  DispatchProgressEvent,
  HostRpcRequest,
  RpcReply,
} from '../bootstrap/tool-command-dispatch-types.js';
import type { WorkerMessage } from '@opensip-cli/core';

type Outbound = WorkerMessage<DispatchProgressEvent, unknown>;

/**
 * A fake IPC duplex: captures the worker's outbound `progress` posts and lets a
 * test push replies back through the registered `message` listener. Models the
 * `process` end the real fork wires.
 */
function makeFakeChannel(): {
  send: (msg: Outbound) => void;
  on: (event: 'message', listener: (msg: unknown) => void) => void;
  off: (event: 'message', listener: (msg: unknown) => void) => void;
  sent: Outbound[];
  reply: (msg: RpcReply) => void;
} {
  const sent: Outbound[] = [];
  let listener: ((msg: unknown) => void) | undefined;
  return {
    send: (msg) => sent.push(msg),
    on: (_event, l) => {
      listener = l;
    },
    off: () => {
      listener = undefined;
    },
    sent,
    reply: (msg) => listener?.(msg),
  };
}

/** Pull the request off the most recently sent host-RPC progress event. */
function lastRpcRequest(sent: Outbound[]): HostRpcRequest {
  const last = sent.at(-1);
  if (last?.kind !== 'progress') throw new Error('expected a progress (request) message');
  if (last.event.kind !== 'host-rpc') throw new Error('expected a host-RPC progress event');
  return last.event.request;
}

/** Pull the rpcId off the most recently sent host-RPC request. */
function lastRpcId(sent: Outbound[]): number {
  return lastRpcRequest(sent).rpcId;
}

describe('createWorkerRpcClient — worker-side rpc-reply round-trip', () => {
  it('stamps a monotonic rpcId, sends on the progress arm, and resolves on the matching reply', async () => {
    const ch = makeFakeChannel();
    const client = createWorkerRpcClient(ch);

    const p = client.call({ seam: 'toolState.list', tool: 't' });
    expect(ch.sent).toHaveLength(1);
    const first = ch.sent[0];
    expect(first?.kind).toBe('progress');
    if (first?.kind !== 'progress') throw new Error('expected progress');
    expect(first.event.kind).toBe('host-rpc');
    if (first.event.kind !== 'host-rpc') throw new Error('expected host-RPC progress');
    expect(first.event.request.seam).toBe('toolState.list');
    const id = first.event.request.rpcId;

    ch.reply({ kind: 'rpc-reply', rpcId: id, ok: true, value: ['a', 'b'] });
    await expect(p).resolves.toEqual(['a', 'b']);

    // A second call gets a strictly greater id (monotonic).
    const p2 = client.call({ seam: 'getExitCode' });
    expect(lastRpcId(ch.sent)).toBeGreaterThan(id);
    ch.reply({
      kind: 'rpc-reply',
      rpcId: lastRpcId(ch.sent),
      ok: true,
      value: 7,
    });
    await expect(p2).resolves.toBe(7);
  });

  it('rejects with the host structured error on an { ok: false } reply', async () => {
    const ch = makeFakeChannel();
    const client = createWorkerRpcClient(ch);
    const p = client.call({ seam: 'toolState.get', tool: 't', key: 'k' });
    ch.reply({
      kind: 'rpc-reply',
      rpcId: lastRpcId(ch.sent),
      ok: false,
      error: { message: 'host boom', code: 'X' },
    });
    await expect(p).rejects.toThrow(/host boom/);
  });

  it('ignores a non-reply message and an unknown rpcId (no spurious settle)', async () => {
    const ch = makeFakeChannel();
    const client = createWorkerRpcClient(ch);
    const p = client.call({ seam: 'getExitCode' });
    // Not a reply, and a reply for an unknown id — neither settles `p`.
    ch.reply({ kind: 'rpc-reply', rpcId: 9999, ok: true, value: 'wrong' });
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    ch.reply({
      kind: 'rpc-reply',
      rpcId: lastRpcId(ch.sent),
      ok: true,
      value: 1,
    });
    await expect(p).resolves.toBe(1);
  });

  it('rejects when the channel has no send (not forked with IPC)', async () => {
    const client = createWorkerRpcClient({ on: () => undefined });
    await expect(client.call({ seam: 'getExitCode' })).rejects.toThrow(/no IPC channel/);
  });
});

describe('handleHostRpc — host-side RPC seam dispatch', () => {
  it('performs toolState.put then get through the real ctx and returns the value', async () => {
    const cap = makeDispatchHostCtx();
    const put = await handleHostRpc(
      {
        rpcId: 1,
        seam: 'toolState.put',
        tool: 't',
        key: 'k',
        payload: { v: 1 },
      },
      cap.ctx,
    );
    expect(put).toEqual({
      kind: 'rpc-reply',
      rpcId: 1,
      ok: true,
      value: undefined,
    });
    expect(cap.toolStateStore.get('t:k')).toEqual({ v: 1 });

    const got = (await handleHostRpc(
      { rpcId: 2, seam: 'toolState.get', tool: 't', key: 'k' },
      cap.ctx,
    )) as Extract<RpcReply, { ok: true }>;
    expect(got.ok).toBe(true);
    expect(got.value).toEqual({ v: 1 });
  });

  it('performs saveBaseline / deliverSignals / writeSarif / writeArtifact / compareBaseline / list', async () => {
    const cap = makeDispatchHostCtx();
    await handleHostRpc({ rpcId: 1, seam: 'saveBaseline', tool: 't', envelope: { a: 1 } }, cap.ctx);
    expect(cap.baselines[0]).toEqual({ tool: 't', envelope: { a: 1 } });

    const deliver = (await handleHostRpc(
      {
        rpcId: 2,
        seam: 'deliverSignals',
        envelope: { e: 1 },
        opts: { cwd: '/x' },
      },
      cap.ctx,
    )) as Extract<RpcReply, { ok: true }>;
    expect(deliver.value).toEqual({ cloudAccepted: 0 });
    expect(cap.delivered[0]).toEqual({ e: 1 });

    await handleHostRpc({ rpcId: 3, seam: 'writeSarif', envelope: {}, path: '/o.sarif' }, cap.ctx);
    await handleHostRpc(
      {
        rpcId: 30,
        seam: 'writeArtifact',
        path: '/artifact.json',
        bytes: '{"ok":true}\n',
      },
      cap.ctx,
    );
    expect(cap.artifacts).toEqual([{ path: '/artifact.json', bytes: '{"ok":true}\n' }]);
    await handleHostRpc(
      { rpcId: 31, seam: 'ensureArtifactDir', path: '/run/report.json' },
      cap.ctx,
    );
    expect(cap.ensuredDirs).toEqual(['/run/report.json']);
    const compare = (await handleHostRpc(
      { rpcId: 4, seam: 'compareBaseline', tool: 't', envelope: {} },
      cap.ctx,
    )) as Extract<RpcReply, { ok: true }>;
    expect(compare.value).toMatchObject({ degraded: false });

    await handleHostRpc(
      { rpcId: 5, seam: 'toolState.put', tool: 't', key: 'a', payload: 1 },
      cap.ctx,
    );
    const list = (await handleHostRpc(
      { rpcId: 6, seam: 'toolState.list', tool: 't' },
      cap.ctx,
    )) as Extract<RpcReply, { ok: true }>;
    expect(list.value).toContain('a');
  });

  it('dispatches the remaining seams: exportBaselineSarif / exportBaselineFingerprints / toolState.delete', async () => {
    const cap = makeDispatchHostCtx();
    const sarif = await handleHostRpc(
      { rpcId: 1, seam: 'exportBaselineSarif', tool: 't', path: '/base.sarif' },
      cap.ctx,
    );
    expect(sarif.ok).toBe(true);

    const fp = await handleHostRpc(
      {
        rpcId: 2,
        seam: 'exportBaselineFingerprints',
        tool: 't',
        path: '/base.json',
      },
      cap.ctx,
    );
    expect(fp.ok).toBe(true);

    await handleHostRpc(
      { rpcId: 3, seam: 'toolState.put', tool: 't', key: 'd', payload: 1 },
      cap.ctx,
    );
    const del = await handleHostRpc(
      { rpcId: 4, seam: 'toolState.delete', tool: 't', key: 'd' },
      cap.ctx,
    );
    expect(del.ok).toBe(true);
    expect(cap.toolStateStore.has('t:d')).toBe(false);
    expect(cap.calls).toContain('toolState.delete:t:d');
  });

  it('marshals the FULL deliverSignals opts (reportTo / apiKey / runFailed present arms)', async () => {
    const cap = makeDispatchHostCtx();
    const reply = await handleHostRpc(
      {
        rpcId: 1,
        seam: 'deliverSignals',
        envelope: { e: 1 },
        opts: {
          cwd: '/x',
          reportTo: 'https://h',
          apiKey: 'k',
          runFailed: true,
        },
      },
      cap.ctx,
    );
    expect(reply.ok).toBe(true);
    expect(cap.delivered[0]).toEqual({ e: 1 });
  });

  it('catches a host-side fault and returns a structured { ok: false } reply', async () => {
    const cap = makeDispatchHostCtx();
    const reply = (await handleHostRpc(
      { rpcId: 1, seam: 'toolState.get', tool: 't', key: 'boom' },
      cap.ctx,
    )) as Extract<RpcReply, { ok: false }>;
    expect(reply.ok).toBe(false);
    // Bounded generic message only — never host exception text (ADR-0146).
    expect(reply.error.message).toBe('host-RPC seam failed');
    expect(reply.error.message).not.toContain('boom');
    expect(reply.error.stack).toBeUndefined();
  });

  it('preserves a string `code` but never stack or host exception text on fault', async () => {
    // A thrown Error carrying a string `code` drives the `code` present arm.
    // Stacks and raw host messages must not cross the worker IPC boundary.
    const coded = new Error('coded host fault with /secret/path') as Error & { code?: string };
    coded.code = 'E_HOST_CODE';
    const ctx = {
      ...makeDispatchHostCtx().ctx,
      maybeOpenReport: () => {
        throw coded;
      },
    } as unknown as Parameters<typeof handleHostRpc>[1];

    const reply = (await handleHostRpc(
      {
        rpcId: 1,
        seam: 'maybeOpenReport',
        opts: { openRequested: true, jsonOutput: false },
      },
      ctx,
    )) as Extract<RpcReply, { ok: false }>;
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatchObject({
      message: 'host-RPC seam failed',
      code: 'E_HOST_CODE',
    });
    expect(reply.error.stack).toBeUndefined();
    expect(JSON.stringify(reply.error)).not.toContain('secret');
  });

  it('carries the canonical toolErrorCode for a TYPED ToolError fault (compareBaseline reject → exit-2 survives the boundary)', async () => {
    // A5/A6: the compareBaseline seam rejects with a ConfigurationError (a missing
    // baseline). The host fault reply must carry the canonical exit-class code so
    // the worker shim rebuilds a TYPED error and the exit-2 contract survives —
    // alongside the original subcode for diagnostics.
    const ctx = {
      ...makeDispatchHostCtx().ctx,
      compareBaseline: () =>
        Promise.reject(
          new ConfigurationError("No baseline found for 'gitleaks'", {
            code: 'CONFIGURATION.GATE.BASELINE_MISSING',
          }),
        ),
    } as unknown as Parameters<typeof handleHostRpc>[1];

    const reply = (await handleHostRpc(
      { rpcId: 1, seam: 'compareBaseline', tool: 'gitleaks', envelope: {} },
      ctx,
    )) as Extract<RpcReply, { ok: false }>;
    expect(reply.ok).toBe(false);
    expect(reply.error.toolErrorCode).toBe('CONFIGURATION_ERROR');
    expect(reply.error.code).toBe('CONFIGURATION.GATE.BASELINE_MISSING');
  });

  it('returns a bounded generic message for a non-Error host fault', async () => {
    // A non-Error throw must not leak through String(error) — ADR-0146.
    const ctx = {
      ...makeDispatchHostCtx().ctx,
      getExitCode: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw: drives handleHostRpc's catch path.
        throw 'plain string fault with secret';
      },
    } as unknown as Parameters<typeof handleHostRpc>[1];

    const reply = (await handleHostRpc({ rpcId: 1, seam: 'getExitCode' }, ctx)) as Extract<
      RpcReply,
      { ok: false }
    >;
    expect(reply.ok).toBe(false);
    expect(reply.error.message).toBe('host-RPC seam failed');
    expect(reply.error.code).toBeUndefined();
    expect(reply.error.stack).toBeUndefined();
    expect(JSON.stringify(reply.error)).not.toContain('secret');
  });

  it('rejects unknown, cross-plane, and prototype hostPlane methods without a host call', async () => {
    const cap = makeDispatchHostCtx();
    const cases = [
      { plane: 'audit', method: 'exportForCloud', args: [] },
      { plane: 'governance', method: 'listForProject', args: ['/p'] },
      { plane: 'audit', method: '__proto__', args: [] },
      { plane: 'audit', method: 'constructor', args: [] },
      { plane: 'nope', method: 'append', args: [] },
    ] as const;
    for (const c of cases) {
      const reply = (await handleHostRpc(
        {
          rpcId: 1,
          seam: 'hostPlane',
          plane: c.plane as never,
          method: c.method as never,
          args: c.args,
        },
        cap.ctx,
      )) as Extract<RpcReply, { ok: false }>;
      expect(reply.ok).toBe(false);
      expect(reply.error.message).toBe('host-RPC seam failed');
    }
  });

  it('rejects malformed rpcId and non-array hostPlane args', async () => {
    const cap = makeDispatchHostCtx();
    for (const rpcId of [-1, 1.5, Number.NaN] as const) {
      const reply = (await handleHostRpc(
        { rpcId: rpcId as never, seam: 'getExitCode' },
        cap.ctx,
      )) as Extract<RpcReply, { ok: false }>;
      expect(reply.ok).toBe(false);
    }
    const badArgs = (await handleHostRpc(
      {
        rpcId: 1,
        seam: 'hostPlane',
        plane: 'audit',
        method: 'append',
        args: { not: 'array' } as never,
      },
      cap.ctx,
    )) as Extract<RpcReply, { ok: false }>;
    expect(badArgs.ok).toBe(false);
  });

  it('dispatches getExitCode + maybeOpenReport through the ctx', async () => {
    const cap = makeDispatchHostCtx();
    cap.ctx.setExitCode(3);
    const exit = (await handleHostRpc({ rpcId: 1, seam: 'getExitCode' }, cap.ctx)) as Extract<
      RpcReply,
      { ok: true }
    >;
    expect(exit.value).toBe(3);

    const open = await handleHostRpc(
      {
        rpcId: 2,
        seam: 'maybeOpenReport',
        opts: { openRequested: false, jsonOutput: true },
      },
      cap.ctx,
    );
    expect(open.ok).toBe(true);
    expect(cap.calls).toContain('maybeOpenReport');
  });

  it('routes a hostPlane call to ctx.hostPlanes.<plane>.<method>(...args)', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      ...makeDispatchHostCtx().ctx,
      hostPlanes: { audit: { append, query: vi.fn() } },
    } as unknown as Parameters<typeof handleHostRpc>[1];

    const reply = await handleHostRpc(
      {
        rpcId: 1,
        seam: 'hostPlane',
        plane: 'audit',
        method: 'append',
        args: ['t', { e: 1 }],
      },
      ctx,
    );
    expect(reply.ok).toBe(true);
    expect(append).toHaveBeenCalledWith('t', { e: 1 });
  });

  it('rejects an unrecognized seam with a structured error (fail loud, not a silent no-op)', async () => {
    const cap = makeDispatchHostCtx();
    const reply = (await handleHostRpc(
      { rpcId: 1, seam: 'totallyBogus' } as unknown as HostRpcRequest,
      cap.ctx,
    )) as Extract<RpcReply, { ok: false }>;
    expect(reply.ok).toBe(false);
    expect(reply.error.message).toBe('host-RPC seam failed');
  });

  it('rejects a malformed request (missing numeric rpcId) with a structured error', async () => {
    const cap = makeDispatchHostCtx();
    const reply = (await handleHostRpc(
      { seam: 'getExitCode' } as unknown as HostRpcRequest,
      cap.ctx,
    )) as Extract<RpcReply, { ok: false }>;
    expect(reply.ok).toBe(false);
    expect(reply.error.message).toBe('host-RPC seam failed');
  });

  it('returns a structured error when a requested host plane is absent', async () => {
    const cap = makeDispatchHostCtx(); // no hostPlanes on the stub
    const reply = (await handleHostRpc(
      {
        rpcId: 1,
        seam: 'hostPlane',
        plane: 'governance',
        method: 'getGovernanceState',
        args: ['t'],
      },
      cap.ctx,
    )) as Extract<RpcReply, { ok: false }>;
    expect(reply.ok).toBe(false);
    expect(reply.error.message).toBe('host-RPC seam failed');
  });

  it('returns a structured error when a host plane method is absent', async () => {
    const ctx = {
      ...makeDispatchHostCtx().ctx,
      hostPlanes: { entitlements: {} },
    } as unknown as Parameters<typeof handleHostRpc>[1];
    const reply = (await handleHostRpc(
      {
        rpcId: 1,
        seam: 'hostPlane',
        plane: 'entitlements',
        method: 'check',
        args: ['t'],
      },
      ctx,
    )) as Extract<RpcReply, { ok: false }>;
    expect(reply.ok).toBe(false);
    expect(reply.error.message).toBe('host-RPC seam failed');
  });
});
