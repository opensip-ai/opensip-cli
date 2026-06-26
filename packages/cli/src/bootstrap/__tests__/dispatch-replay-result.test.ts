/**
 * dispatch-replay-result — unit coverage for {@link replayResult}, the OUTPUT leg
 * of the ADR-0054 dispatch supervisor, exercised IN-PROCESS (no fork) against a
 * recording host context. Proves the two replay channels:
 *
 *   - the handler's RETURN value (`result.returned`) for the return-valued modes
 *     is routed through the SAME `dispatchOutput` seam the in-process path uses —
 *     `--json` short-circuit vs. human `render` for `command-result`,
 *     envelope-vs-render for `signal-envelope` (ADR-0027 parity);
 *   - the explicit FRR seam fields (`render`/`envelope`/`json`/`raw`/`error`/
 *     `exitCode`) replay through their host counterparts, exit code LAST;
 *   - a returned `session` is persisted via the host `completeRun` hook.
 *
 * The forked end-to-end boundary is proven in `external-tool-dispatch.test.ts`;
 * this isolates the replay routing for deterministic branch coverage.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  makeDispatchHostCtx,
  type CapturedHostCtx,
} from '../../__tests__/harness/dispatch-host-ctx.js';
import { replayResult, type DispatchHostCtx } from '../dispatch-replay-result.js';

import type { ToolCommandResult } from '../tool-command-dispatch-types.js';

/** Capture everything written to stdout during `fn` (the `--json` outcome write). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let out = '';
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

interface Recording {
  readonly cap: CapturedHostCtx;
  readonly ctx: DispatchHostCtx;
  readonly completedSessions: unknown[];
}

/** A recording host ctx + a `completeRun` recorder (the supervisor persist hook). */
function makeCtx(): Recording {
  const cap = makeDispatchHostCtx();
  const completedSessions: unknown[] = [];
  const ctx = Object.assign({}, cap.ctx, {
    completeRun: (result: unknown) => {
      completedSessions.push(result);
    },
  }) as DispatchHostCtx;
  return { cap, ctx, completedSessions };
}

const invocation = (opts: Record<string, unknown> = {}) => ({
  commandName: 'ext-run',
  opts: { ...opts, _args: [] },
  positionals: [] as readonly unknown[],
});

describe('replayResult', () => {
  it('routes a command-result RETURN through dispatchOutput: --json writes the JSON outcome', async () => {
    const { cap, ctx } = makeCtx();
    const result: ToolCommandResult = {
      output: 'command-result',
      returned: { type: 'list-checks', checks: [] },
    };
    const out = await captureStdout(() => replayResult(result, ctx, invocation({ json: true })));
    // dispatchOutput → emitCommandResult → renderOutcome (json) → stdout wrapper.
    const outcome = JSON.parse(out) as { data?: { type?: string } };
    expect(outcome.data?.type).toBe('list-checks');
    // The JSON path never renders (no ANSI for machine consumers).
    expect(cap.rendered).toHaveLength(0);
  });

  it('routes a command-result RETURN through dispatchOutput: human mode renders', async () => {
    const { cap, ctx } = makeCtx();
    const result: ToolCommandResult = {
      output: 'command-result',
      returned: { type: 'help' },
    };
    await replayResult(result, ctx, invocation());
    expect(cap.rendered).toHaveLength(1);
    expect(cap.jsons).toHaveLength(0);
  });

  it('routes a signal-envelope RETURN through dispatchOutput: --json emits the envelope', async () => {
    const { cap, ctx } = makeCtx();
    const result: ToolCommandResult = {
      output: 'signal-envelope',
      returned: { tool: 'ext', signals: [] },
    };
    await replayResult(result, ctx, invocation({ json: true }));
    // signal-envelope --json → ctx.emitEnvelope (the host envelope seam).
    expect(cap.envelopes).toHaveLength(1);
    expect(cap.rendered).toHaveLength(0);
  });

  it('routes a signal-envelope RETURN through dispatchOutput: human mode renders', async () => {
    const { cap, ctx } = makeCtx();
    const result: ToolCommandResult = {
      output: 'signal-envelope',
      returned: { tool: 'ext', signals: [] },
    };
    await replayResult(result, ctx, invocation());
    expect(cap.rendered).toHaveLength(1);
    expect(cap.envelopes).toHaveLength(0);
  });

  it('replays reportedFailure through ctx.reportFailure before other seams', async () => {
    const { cap, ctx } = makeCtx();
    const result: ToolCommandResult = {
      output: 'command-result',
      reportedFailure: {
        message: 'worker failed',
        exitCode: 2,
        jsonRequested: false,
      },
      exitCode: 9,
    };
    await replayResult(result, ctx, invocation());
    expect(cap.reportedFailures).toHaveLength(1);
    expect(cap.reportedFailures[0]).toMatchObject({
      message: 'worker failed',
      exitCode: 2,
    });
    expect(cap.calls[0]).toMatch(/^reportFailure:/);
    expect(cap.calls.at(-1)).toBe('exit:9');
  });

  it('replays every explicit FRR seam field, exit code LAST', async () => {
    const { cap, ctx } = makeCtx();
    const result: ToolCommandResult = {
      output: 'command-result',
      error: { message: 'oops', exitCode: 2 },
      render: { type: 'help' },
      envelope: { tool: 't' },
      json: { a: 1 },
      raw: 'raw-line',
      exitCode: 7,
    };
    await replayResult(result, ctx, invocation());
    expect(cap.errors).toHaveLength(1);
    expect(cap.rendered).toHaveLength(1);
    expect(cap.envelopes).toHaveLength(1);
    expect(cap.jsons).toHaveLength(1);
    expect(cap.raws).toHaveLength(1);
    // Exit code applied last.
    expect(cap.calls.at(-1)).toBe('exit:7');
  });

  it('persists a returned session via completeRun', async () => {
    const { ctx, completedSessions } = makeCtx();
    const result: ToolCommandResult = {
      output: 'signal-envelope',
      session: { tool: 'ext', cwd: '/x', score: 100, passed: true },
    };
    await replayResult(result, ctx, invocation());
    expect(completedSessions).toHaveLength(1);
    expect(completedSessions[0]).toEqual({
      session: { tool: 'ext', cwd: '/x', score: 100, passed: true },
    });
  });

  it('is a no-op for an empty result (no returned, no seams, no session)', async () => {
    const { cap, completedSessions, ctx } = makeCtx();
    await replayResult({ output: 'raw-stream' }, ctx, invocation());
    expect(cap.calls).toHaveLength(0);
    expect(completedSessions).toHaveLength(0);
  });

  it('tolerates a missing completeRun hook (lean context) when a session is returned', async () => {
    // A lean host ctx with no run plane: completeRun is undefined; the optional
    // chain is a no-op (no throw).
    const cap = makeDispatchHostCtx();
    await replayResult(
      {
        output: 'signal-envelope',
        session: { tool: 'ext', cwd: '/x', score: 1, passed: true },
      },
      cap.ctx,
      invocation(),
    );
    // No crash; nothing recorded on the FRR buckets.
    expect(cap.calls).toHaveLength(0);
  });
});
