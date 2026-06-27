/**
 * tool-command-worker-rpc — unit coverage for the WORKER side of the ADR-0054
 * host-RPC upcall channel. Drives {@link createWorkerRpcClient} directly over a
 * FAKE duplex channel (an in-memory `send`/`on`/`off` triple) so every demux arm
 * runs in-process and deterministically — the real channel is a forked child's
 * IPC, which coverage-v8 cannot instrument.
 *
 * The fake channel captures the installed `message` listener so a test can feed
 * it host replies (and non-replies) synchronously, then assert the matching
 * `call(...)` promise settles (or that an unrelated message is ignored).
 */

import { describe, expect, it, vi } from 'vitest';

import { createWorkerRpcClient } from '../tool-command-worker-rpc.js';

import type { HostRpcCall, HostRpcRequest, RpcReply } from '../tool-command-dispatch-types.js';
import type { WorkerMessage } from '@opensip-cli/core';

type Outbound = WorkerMessage<HostRpcRequest, unknown>;

interface FakeChannel {
  readonly send: (msg: Outbound) => void;
  readonly on: (event: 'message', listener: (msg: unknown) => void) => void;
  readonly off: (event: 'message', listener: (msg: unknown) => void) => void;
  /** Replies the client posted on the `progress` arm, in send order. */
  readonly sent: HostRpcRequest[];
  /** Push a message into the installed listener (simulating a parent → child post). */
  readonly deliver: (msg: unknown) => void;
  /** The listeners currently attached via `on`. */
  readonly listeners: ReadonlySet<(msg: unknown) => void>;
}

function makeChannel(opts: { withSend?: boolean } = {}): FakeChannel {
  const sent: HostRpcRequest[] = [];
  const listeners = new Set<(msg: unknown) => void>();
  const send =
    opts.withSend === false
      ? undefined
      : (msg: Outbound): void => {
          // The client only ever posts host-RPC requests on the `progress` arm.
          if (msg.kind === 'progress') sent.push(msg.event);
        };
  return {
    // `send` is intentionally undefined-able to exercise the no-channel reject arm.
    send: send as FakeChannel['send'],
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    sent,
    deliver: (msg) => {
      for (const listener of listeners) listener(msg);
    },
    listeners,
  };
}

const CALL: HostRpcCall = { seam: 'getExitCode' };

describe('createWorkerRpcClient — happy path', () => {
  it('resolves a call with the host reply value, demultiplexed by rpcId', async () => {
    const channel = makeChannel();
    const client = createWorkerRpcClient(channel);

    const pending = client.call(CALL);
    // The request was posted with a stamped rpcId (the first is 1).
    expect(channel.sent).toHaveLength(1);
    const { rpcId } = channel.sent[0];
    expect(rpcId).toBe(1);

    const reply: RpcReply = {
      kind: 'rpc-reply',
      rpcId,
      ok: true,
      value: { exitCode: 7 },
    };
    channel.deliver(reply);

    await expect(pending).resolves.toEqual({ exitCode: 7 });
  });

  it('assigns monotonically increasing rpcIds across calls', async () => {
    const channel = makeChannel();
    const client = createWorkerRpcClient(channel);

    const first = client.call(CALL);
    const second = client.call(CALL);
    expect(channel.sent.map((r) => r.rpcId)).toEqual([1, 2]);

    channel.deliver({
      kind: 'rpc-reply',
      rpcId: 2,
      ok: true,
      value: 'second',
    } satisfies RpcReply);
    channel.deliver({
      kind: 'rpc-reply',
      rpcId: 1,
      ok: true,
      value: 'first',
    } satisfies RpcReply);
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });
});

describe('createWorkerRpcClient — host fault reply', () => {
  it('rejects with an Error carrying the structured code + stack (rpcError full path)', async () => {
    const channel = makeChannel();
    const client = createWorkerRpcClient(channel);

    const pending = client.call(CALL);
    const { rpcId } = channel.sent[0];
    channel.deliver({
      kind: 'rpc-reply',
      rpcId,
      ok: false,
      error: {
        message: 'boom',
        code: 'E_HOST',
        stack: 'Error: boom\n  at host',
      },
    } satisfies RpcReply);

    await expect(pending).rejects.toMatchObject({
      message: 'boom',
      code: 'E_HOST',
      stack: 'Error: boom\n  at host',
    });
  });

  it('rejects with a bare Error when the fault carries neither code nor stack', async () => {
    // Exercises the FALSE arms of `if (detail.code !== undefined)` (L54) and
    // `if (detail.stack !== undefined)` (L55) in rpcError.
    const channel = makeChannel();
    const client = createWorkerRpcClient(channel);

    const pending = client.call(CALL);
    const { rpcId } = channel.sent[0];
    channel.deliver({
      kind: 'rpc-reply',
      rpcId,
      ok: false,
      error: { message: 'minimal fault' },
    } satisfies RpcReply);

    const err = await pending.catch((error: unknown) => error as Error & { code?: string });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('minimal fault');
    expect(err.code).toBeUndefined();
    // A bare Error keeps its own constructed stack (not the host's).
    expect(err.stack).toContain('minimal fault');
  });

  it('rejects with the code-only fault (stack-absent FALSE arm of L55)', async () => {
    const channel = makeChannel();
    const client = createWorkerRpcClient(channel);

    const pending = client.call(CALL);
    const { rpcId } = channel.sent[0];
    channel.deliver({
      kind: 'rpc-reply',
      rpcId,
      ok: false,
      error: { message: 'coded', code: 'E_ONLY_CODE' },
    } satisfies RpcReply);

    await expect(pending).rejects.toMatchObject({
      message: 'coded',
      code: 'E_ONLY_CODE',
    });
  });
});

describe('createWorkerRpcClient — listener demux defenses', () => {
  it('ignores a message that is not an rpc-reply (L83 not-a-reply arm)', async () => {
    const channel = makeChannel();
    const client = createWorkerRpcClient(channel);
    const pending = client.call(CALL);
    const { rpcId } = channel.sent[0];

    // Non-reply shapes the worker's single listener must defensively ignore: the
    // channel is otherwise child → parent, so these never settle a pending call.
    channel.deliver(undefined);
    channel.deliver(null);
    channel.deliver('a string');
    channel.deliver({ kind: 'progress', event: {} }); // wrong kind
    channel.deliver({ kind: 'rpc-reply', rpcId: 'not-a-number' }); // bad rpcId type

    // Now deliver the real reply and confirm the call still resolves cleanly.
    channel.deliver({
      kind: 'rpc-reply',
      rpcId,
      ok: true,
      value: 'ok',
    } satisfies RpcReply);
    await expect(pending).resolves.toBe('ok');
  });

  it('ignores a reply with an unknown/duplicate rpcId (waiter-undefined arm)', async () => {
    const channel = makeChannel();
    const client = createWorkerRpcClient(channel);
    const pending = client.call(CALL);
    const { rpcId } = channel.sent[0];

    // No pending call has rpcId 999 → defensively ignored, no throw.
    expect(() =>
      channel.deliver({
        kind: 'rpc-reply',
        rpcId: 999,
        ok: true,
        value: 'x',
      } satisfies RpcReply),
    ).not.toThrow();

    channel.deliver({
      kind: 'rpc-reply',
      rpcId,
      ok: true,
      value: 'real',
    } satisfies RpcReply);
    await expect(pending).resolves.toBe('real');

    // A duplicate reply for an already-settled id is also ignored (pending was deleted).
    expect(() =>
      channel.deliver({
        kind: 'rpc-reply',
        rpcId,
        ok: true,
        value: 'dup',
      } satisfies RpcReply),
    ).not.toThrow();
  });

  it('dispose() removes the listener and clears pending', () => {
    const channel = makeChannel();
    const client = createWorkerRpcClient(channel);
    void client.call(CALL);
    expect(channel.listeners.size).toBe(1);

    client.dispose();
    expect(channel.listeners.size).toBe(0);
  });
});

describe('createWorkerRpcClient — no IPC channel', () => {
  it('rejects the call when the channel has no send (integration-only misuse)', async () => {
    const channel = makeChannel({ withSend: false });
    const client = createWorkerRpcClient(channel);

    await expect(
      client.call({ seam: 'writeSarif', envelope: {}, path: 'out/x.sarif' }),
    ).rejects.toThrow(/no IPC channel/);
    // Nothing was posted because there is no transport.
    expect(channel.sent).toHaveLength(0);
  });

  it('dispose() is safe when off is absent on the channel', () => {
    // A channel without `off` must not throw on dispose (optional-chaining arm).
    const listeners = new Set<(msg: unknown) => void>();
    const client = createWorkerRpcClient({
      send: vi.fn(),
      on: (_e, l) => listeners.add(l),
    });
    expect(() => client.dispose()).not.toThrow();
  });
});
