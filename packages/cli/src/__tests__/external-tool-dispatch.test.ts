/**
 * external-tool-dispatch — ADR-0054 out-of-process external tool command
 * dispatch, end-to-end over a REAL forked worker (increment M4-D vertical
 * slice).
 *
 * These tests FORK the BUILT worker entry (`dist/bootstrap/tool-command-worker-
 * entry.js`) — the same "fork a real child" discipline as
 * `core/.../subprocess-transport.test.ts`. They require the cli package to be
 * built (the test resolves the dist worker entry relative to this file). The
 * fixture EXTERNAL tool's handler runs IN THE WORKER (imported there by
 * `importToolRuntime`), never in this host process. The suite proves:
 *
 *   - happy path: the handler's emitted envelope + exit code cross the boundary
 *     and the supervisor replays them through the host seams;
 *   - isolation: a handler that `process.exit(1)`s, throws, hangs (timeout), or
 *     calls an unmarshalled host-RPC seam is contained as a STRUCTURED
 *     parent-side failure while THIS host process survives.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ToolError, type ToolProvenance } from '@opensip-cli/core';
import { describe, it, expect, beforeAll } from 'vitest';

import { dispatchExternalToolCommand } from '../bootstrap/dispatch-external-tool-command.js';

import { makeDispatchHostCtx, type CapturedHostCtx } from './harness/dispatch-host-ctx.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The test source lives at packages/cli/src/__tests__; the built worker entry
// lives at packages/cli/dist/bootstrap. Resolve it from the package root.
const PKG_ROOT = join(HERE, '..', '..');
const WORKER_ENTRY = join(PKG_ROOT, 'dist', 'bootstrap', 'tool-command-worker-entry.js');
const FIXTURE_DIR = join(HERE, 'fixtures', 'external-dispatch-tool');

const PROVENANCE: ToolProvenance = {
  source: 'installed',
  id: 'external-dispatch-tool',
  stableId: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
  version: '0.0.0',
  packageName: '@opensip-cli-fixture/external-dispatch-tool',
  resolvedPath: FIXTURE_DIR,
  manifestHash: 'test-hash',
};

function dispatch(
  cap: CapturedHostCtx,
  mode: string,
  opts: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<void> {
  return dispatchExternalToolCommand({
    provenance: PROVENANCE,
    commandName: 'ext-run',
    opts: { mode, ...opts },
    positionals: [],
    ctx: cap.ctx,
    workerEntry: WORKER_ENTRY,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('dispatchExternalToolCommand — ADR-0054 out-of-process boundary', () => {
  beforeAll(() => {
    if (!existsSync(WORKER_ENTRY)) {
      throw new Error(
        `built worker entry not found at ${WORKER_ENTRY} — run \`pnpm --filter=opensip-cli build\` first`,
      );
    }
  });

  it('happy path: the handler runs in the worker and its result crosses the boundary', async () => {
    const cap = makeDispatchHostCtx();
    await dispatch(cap, 'ok', { echo: 'hello' });

    // The envelope the fixture emitted IN THE WORKER was replayed through the
    // host emitEnvelope seam.
    expect(cap.envelopes).toHaveLength(1);
    const env = cap.envelopes[0] as {
      tool: string;
      signals: { marker: string; echoedOpt: string }[];
    };
    expect(env.tool).toBe('external-dispatch-tool');
    expect(env.signals[0]?.marker).toBe('ext-ran');
    expect(env.signals[0]?.echoedOpt).toBe('hello');
    // The worker's setExitCode(0) was replayed.
    expect(cap.exitCodes).toContain(0);
  });

  it('isolation: a handler process.exit(1) is contained as a structured failure (host survives)', async () => {
    const cap = makeDispatchHostCtx();
    // If isolation FAILED, the child exit would take this process down before the
    // assertion ran. Reaching the rejection proves containment.
    await expect(dispatch(cap, 'exit')).rejects.toBeInstanceOf(ToolError);
    // No result replayed.
    expect(cap.envelopes).toHaveLength(0);
  });

  it('isolation: a handler throw crosses IPC as a structured failure', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'throw')).rejects.toThrow(/external handler boom/);
  });

  it('isolation: a hung handler is SIGKILLed by the supervisor timeout', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'hang', {}, 750)).rejects.toThrow(/timed out|failed/);
  }, 10_000);

  it('an unmarshalled host-RPC seam fails loud (unsupported-seam) — never a silent no-op', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'bad-seam')).rejects.toThrow(/failed/);
  });

  it('the host still dispatches a happy run AFTER containing a fault (host survived)', async () => {
    // Prove the host process is still fully functional after the isolation cases:
    // contain a fault, then dispatch a clean run in the SAME process and assert it
    // crosses the boundary correctly. A crashed host could not run this.
    const faulted = makeDispatchHostCtx();
    await expect(dispatch(faulted, 'exit')).rejects.toBeInstanceOf(ToolError);

    const ok = makeDispatchHostCtx();
    await dispatch(ok, 'ok', { echo: 'after-fault' });
    const env = ok.envelopes[0] as { signals: { echoedOpt: string }[] };
    expect(env.signals[0]?.echoedOpt).toBe('after-fault');
    expect(ok.exitCodes).toContain(0);
  });

  it('rejects a bundled tool with a structured misuse error (bundled runs in-process)', async () => {
    const cap = makeDispatchHostCtx();
    await expect(
      dispatchExternalToolCommand({
        provenance: { ...PROVENANCE, source: 'bundled' },
        commandName: 'ext-run',
        opts: { mode: 'ok' },
        positionals: [],
        ctx: cap.ctx,
        workerEntry: WORKER_ENTRY,
      }),
    ).rejects.toThrow(/bundled tools run in-process/);
  });

  it('rejects when an external tool has no resolved package dir to dispatch from', async () => {
    const cap = makeDispatchHostCtx();
    await expect(
      dispatchExternalToolCommand({
        provenance: { ...PROVENANCE, resolvedPath: undefined },
        commandName: 'ext-run',
        opts: { mode: 'ok' },
        positionals: [],
        ctx: cap.ctx,
        workerEntry: WORKER_ENTRY,
      }),
    ).rejects.toThrow(/no resolved package path/);
  });
});
