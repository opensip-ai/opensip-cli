/**
 * dispatch-supervisor — host-side coverage for the ADR-0054 supervisor's replay
 * + failure arms (`dispatchExternalToolCommand` / `replayResult`), forking a
 * tiny result-shape fixture worker (not the full worker entry) so every
 * final-result-return replay arm and the spawn/error paths are exercised in the
 * instrumented host process.
 *
 * The supervisor forks `node <cliScript> __tool-command-worker <specPath> --cwd
 * <cwd>` (M4-E). Here `cliScript` is pointed at the tiny `dispatch-result-worker`
 * fixture, which parses the spec path out of that argv shape and posts a chosen
 * result shape — exercising the supervisor's replay arms without the full CLI
 * bootstrap (discovery/config/scope), which the e2e suite covers separately.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError, ToolError, type ToolProvenance } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import { dispatchExternalToolCommand } from '../bootstrap/dispatch-external-tool-command.js';
import { dispatchExternalToolHook } from '../bootstrap/dispatch-external-tool-hook.js';

import { makeDispatchHostCtx, type CapturedHostCtx } from './harness/dispatch-host-ctx.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT_WORKER = join(HERE, 'fixtures', 'dispatch-result-worker.mjs');
const FIXTURE_DIR = join(HERE, 'fixtures', 'external-dispatch-tool');

const PROVENANCE: ToolProvenance = {
  source: 'installed',
  id: 'external-dispatch-tool',
  stableId: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
  version: '0.0.0',
  resolvedPath: FIXTURE_DIR,
  manifestHash: 'h',
};

function dispatch(cap: CapturedHostCtx, mode: string, cliScript = RESULT_WORKER): Promise<void> {
  return dispatchExternalToolCommand({
    provenance: PROVENANCE,
    commandName: 'ext-run',
    opts: { mode },
    positionals: [],
    ctx: cap.ctx,
    cliScript,
    timeoutMs: 5000,
  });
}

describe('dispatchExternalToolCommand — replay + failure arms', () => {
  it('replays every final-result-return seam, exit code last', async () => {
    const cap = makeDispatchHostCtx();
    await dispatch(cap, 'all-frr');
    expect(cap.calls).toContain(
      'error:{"message":"oops","exitCode":2,"suggestion":"fix it","code":"X"}',
    );
    expect(cap.calls).toContain('render:{"type":"help"}');
    expect(cap.calls).toContain('json:{"a":1}');
    expect(cap.calls).toContain('raw:raw-line');
    // Exit code is applied LAST.
    expect(cap.calls.at(-1)).toBe('exit:7');
  });

  it('replays a plain envelope + exit result', async () => {
    const cap = makeDispatchHostCtx();
    await dispatch(cap, 'envelope');
    expect(cap.calls).toContain('envelope:{"tool":"t"}');
    expect(cap.calls).toContain('exit:0');
  });

  it('tolerates a malformed host-RPC request and still settles on the result', async () => {
    const cap = makeDispatchHostCtx();
    await dispatch(cap, 'progress-then-result');
    expect(cap.calls).toContain('exit:0');
  });

  it('rejects with a structured ToolError on a worker error message', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'error-msg')).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects with a structured ToolError when the worker entry cannot spawn', async () => {
    const cap = makeDispatchHostCtx();
    await expect(
      dispatch(cap, 'envelope', join(HERE, 'fixtures', 'this-entry-does-not-exist.mjs')),
    ).rejects.toThrow(/failed/);
  });

  // ADR-0054 M4-E/M4-F: a worker `config-invalid` error maps to the SAME typed
  // ConfigurationError (exit 2) the host coarse pass throws (single config-error
  // contract), not a generic SystemError.
  it('maps a worker config-invalid error to a ConfigurationError', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'config-invalid')).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('dispatchExternalToolHook — M4-F lifecycle hook supervisor', () => {
  it('forks the worker in hook mode and returns the worker hookResult', async () => {
    const cap = makeDispatchHostCtx();
    const result = await dispatchExternalToolHook({
      provenance: PROVENANCE,
      hook: 'collectReportData',
      cwd: HERE,
      ctx: cap.ctx,
      cliScript: RESULT_WORKER,
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true, n: 42 });
  });

  it('rejects with a structured ToolError when the hook worker cannot spawn', async () => {
    const cap = makeDispatchHostCtx();
    await expect(
      dispatchExternalToolHook({
        provenance: PROVENANCE,
        hook: 'sessionReplay',
        hookArg: { id: 's1' },
        cwd: HERE,
        ctx: cap.ctx,
        cliScript: join(HERE, 'fixtures', 'this-entry-does-not-exist.mjs'),
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(ToolError);
  });
});
