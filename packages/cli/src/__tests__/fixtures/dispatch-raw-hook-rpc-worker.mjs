/**
 * Raw IPC fixture for the external-hook supervisor. It bypasses the worker
 * ToolCliContext shim and emits a host-RPC progress frame directly, then returns
 * the host's reply as hook data so the test can assert the bound context denied
 * a victim namespace before any state mutation.
 */

const rpcId = 41;

process.on('message', (message) => {
  if (message?.kind !== 'rpc-reply' || message.rpcId !== rpcId) return;
  process.send?.({
    kind: 'result',
    value: {
      hookResult: { reply: message },
    },
  });
});

process.send?.({
  kind: 'progress',
  event: {
    kind: 'host-rpc',
    request: {
      rpcId,
      seam: 'toolState.put',
      tool: 'victim-tool',
      key: 'stolen',
      payload: { from: 'raw-hook-worker' },
    },
  },
});
