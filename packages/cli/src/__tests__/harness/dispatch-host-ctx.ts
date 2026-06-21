// @fitness-ignore-file test-file-naming -- this is a shared test HELPER (the dispatch host-context stub imported by the dispatch e2e + supervisor suites), not a test file; it deliberately is not named *.test.ts.
/**
 * dispatch-host-ctx — a host {@link ToolCliContext} stub for the ADR-0054
 * dispatch tests. Records the final-result-return seams the supervisor replays
 * into (`render` / `emitEnvelope` / `emitJson` / `emitRaw` / `emitError` /
 * `setExitCode`) and fails loudly on any host-RPC / live-view seam (none should
 * be touched during a dispatch-slice replay). Shared so the supervisor and
 * end-to-end suites assert against the same surface.
 */

import type { ToolCliContext } from '@opensip-cli/core';

/** A captured host context plus the seam-call records the tests assert on. */
export interface CapturedHostCtx {
  readonly ctx: ToolCliContext;
  readonly envelopes: unknown[];
  readonly rendered: unknown[];
  readonly jsons: unknown[];
  readonly raws: unknown[];
  readonly errors: unknown[];
  readonly exitCodes: number[];
  /** Ordered flat log of every replayed seam call (`seam:json` form). */
  readonly calls: string[];
}

const noop = (): void => {
  /* logger sink: intentionally silent in tests */
};

function unexpectedSeam(): never {
  throw new Error('host seam not expected during dispatch replay');
}

export function makeDispatchHostCtx(scopeRunId = 'test-run'): CapturedHostCtx {
  const envelopes: unknown[] = [];
  const rendered: unknown[] = [];
  const jsons: unknown[] = [];
  const raws: unknown[] = [];
  const errors: unknown[] = [];
  const exitCodes: number[] = [];
  const calls: string[] = [];
  const ctx = {
    scope: { runId: scopeRunId } as ToolCliContext['scope'],
    runSession: { timing: {} as ToolCliContext['runSession']['timing'] },
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    } as unknown as ToolCliContext['logger'],
    render: (r: unknown) => {
      rendered.push(r);
      calls.push(`render:${JSON.stringify(r)}`);
      return Promise.resolve();
    },
    emitEnvelope: (e: unknown) => {
      envelopes.push(e);
      calls.push(`envelope:${JSON.stringify(e)}`);
    },
    emitJson: (v: unknown) => {
      jsons.push(v);
      calls.push(`json:${JSON.stringify(v)}`);
    },
    emitRaw: (v: unknown) => {
      raws.push(v);
      calls.push(`raw:${String(v)}`);
    },
    emitError: (d: unknown) => {
      errors.push(d);
      calls.push(`error:${JSON.stringify(d)}`);
    },
    setExitCode: (c: number) => {
      exitCodes.push(c);
      calls.push(`exit:${String(c)}`);
    },
    getExitCode: () => exitCodes.at(-1),
    registerLiveView: unexpectedSeam,
    renderLive: unexpectedSeam as unknown as ToolCliContext['renderLive'],
    maybeOpenReport: () => Promise.resolve(),
    deliverSignals: unexpectedSeam as unknown as ToolCliContext['deliverSignals'],
    writeSarif: unexpectedSeam as unknown as ToolCliContext['writeSarif'],
    saveBaseline: unexpectedSeam as unknown as ToolCliContext['saveBaseline'],
    compareBaseline: unexpectedSeam as unknown as ToolCliContext['compareBaseline'],
    exportBaselineSarif: unexpectedSeam as unknown as ToolCliContext['exportBaselineSarif'],
    exportBaselineFingerprints:
      unexpectedSeam as unknown as ToolCliContext['exportBaselineFingerprints'],
    toolState: {
      get: unexpectedSeam,
      put: unexpectedSeam,
      delete: unexpectedSeam,
      list: unexpectedSeam,
    },
  } satisfies ToolCliContext;
  return { ctx, envelopes, rendered, jsons, raws, errors, exitCodes, calls };
}
