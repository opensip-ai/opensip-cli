/**
 * dispatch-supervisor — host-side coverage for the ADR-0054 supervisor's replay
 * + failure arms (`dispatchExternalToolCommand` / `replayResult`), forking a
 * tiny result-shape fixture worker (not the full worker entry) so every
 * final-result-return replay arm and the spawn/error paths are exercised in the
 * instrumented host process.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ToolError, type ToolProvenance } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import { dispatchExternalToolCommand } from '../bootstrap/dispatch-external-tool-command.js';

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

function dispatch(cap: CapturedHostCtx, mode: string, workerEntry = RESULT_WORKER): Promise<void> {
  return dispatchExternalToolCommand({
    provenance: PROVENANCE,
    commandName: 'ext-run',
    opts: { mode },
    positionals: [],
    ctx: cap.ctx,
    workerEntry,
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
});
