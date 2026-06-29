// @fitness-ignore-file test-file-naming -- this is a shared test HELPER (the dispatch host-context stub imported by the dispatch e2e + supervisor suites), not a test file; it deliberately is not named *.test.ts.
/**
 * dispatch-host-ctx — a host {@link ToolCliContext} stub for the ADR-0054
 * dispatch tests. Records the final-result-return seams the supervisor replays
 * into (`render` / `emitEnvelope` / `emitJson` / `emitRaw` / `emitError` /
 * `setExitCode`) AND the M4-C host-RPC seams the supervisor performs during a
 * run (`toolState.*` / `saveBaseline` / `deliverSignals` / …). The RPC seams
 * record their effects into capture buckets so the dispatch tests can assert the
 * effect happened HOST-SIDE (the worker only triggered the upcall). The
 * live-view seams remain `unexpectedSeam` — they are host-only and never reached
 * during a dispatch replay.
 *
 * `toolState.get(tool, 'boom')` rejects with a structured error so a test can
 * prove a host-side RPC fault crosses back as a normal thrown error in the
 * handler (fault-not-crash), not a host crash.
 */

import { createReportFailure } from '../../bootstrap/report-failure.js';

import type { ToolCliContext } from '@opensip-cli/core';

/** A captured host context plus the seam-call records the tests assert on. */
export interface CapturedHostCtx {
  readonly ctx: ToolCliContext;
  readonly envelopes: unknown[];
  readonly rendered: unknown[];
  readonly jsons: unknown[];
  readonly raws: unknown[];
  readonly errors: unknown[];
  readonly reportedFailures: unknown[];
  readonly exitCodes: number[];
  /** Ordered flat log of every replayed seam call (`seam:json` form). */
  readonly calls: string[];
  /** In-memory toolState store keyed by `${tool}:${key}`, written host-side via RPC. */
  readonly toolStateStore: Map<string, unknown>;
  /** Baselines saved host-side via the RPC `saveBaseline` upcall. */
  readonly baselines: { tool: string; envelope: unknown }[];
  /** Envelopes delivered host-side via the RPC `deliverSignals` upcall. */
  readonly delivered: unknown[];
  /** General artifacts written host-side via RPC. */
  readonly artifacts: { path: string; bytes: string }[];
  /** Per-run artifact dirs ensured host-side via the `ensureArtifactDir` RPC. */
  readonly ensuredDirs: string[];
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
  const reportedFailures: unknown[] = [];
  const exitCodes: number[] = [];
  const calls: string[] = [];
  const toolStateStore = new Map<string, unknown>();
  const baselines: { tool: string; envelope: unknown }[] = [];
  const delivered: unknown[] = [];
  const artifacts: { path: string; bytes: string }[] = [];
  const ensuredDirs: string[] = [];

  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  } as unknown as ToolCliContext['logger'];

  const reportFailure = createReportFailure({
    getLogger: () => logger,
    setExitCode: (c: number) => {
      exitCodes.push(c);
      calls.push(`exit:${String(c)}`);
    },
    render: (r) => {
      rendered.push(r);
      calls.push(`render:${JSON.stringify(r)}`);
      return Promise.resolve();
    },
    emitError: (d) => {
      errors.push(d);
      calls.push(`error:${JSON.stringify(d)}`);
    },
  });

  const ctx = {
    scope: { runId: scopeRunId } as ToolCliContext['scope'],
    runSession: { timing: {} as ToolCliContext['runSession']['timing'] },
    logger,
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
    reportFailure: async (d: unknown) => {
      reportedFailures.push(d);
      calls.push(`reportFailure:${JSON.stringify(d)}`);
      await reportFailure(d as Parameters<typeof reportFailure>[0]);
    },
    setExitCode: (c: number) => {
      exitCodes.push(c);
      calls.push(`exit:${String(c)}`);
    },
    getExitCode: () => exitCodes.at(-1),
    registerLiveView: unexpectedSeam,
    renderLive: unexpectedSeam as unknown as ToolCliContext['renderLive'],
    maybeOpenReport: () => {
      calls.push('maybeOpenReport');
      return Promise.resolve();
    },
    // ── M4-C host-RPC seams (performed host-side; record the effect) ───────
    deliverSignals: ((envelope: unknown) => {
      delivered.push(envelope);
      calls.push('deliverSignals');
      return Promise.resolve({ cloudAccepted: 0 });
    }) as ToolCliContext['deliverSignals'],
    writeSarif: (() => {
      calls.push('writeSarif');
      return Promise.resolve();
    }) as ToolCliContext['writeSarif'],
    writeArtifact: ((path: string, bytes: string) => {
      artifacts.push({ path, bytes });
      calls.push(`writeArtifact:${path}`);
      return Promise.resolve();
    }) as ToolCliContext['writeArtifact'],
    ensureArtifactDir: ((path: string) => {
      ensuredDirs.push(path);
      calls.push(`ensureArtifactDir:${path}`);
      return Promise.resolve();
    }) as ToolCliContext['ensureArtifactDir'],
    saveBaseline: ((tool: string, envelope: unknown) => {
      baselines.push({ tool, envelope });
      calls.push(`saveBaseline:${tool}`);
      return Promise.resolve();
    }) as ToolCliContext['saveBaseline'],
    compareBaseline: ((tool: string) => {
      calls.push(`compareBaseline:${tool}`);
      return Promise.resolve({
        added: [],
        resolved: [],
        unchanged: [],
        degraded: false,
      });
    }) as ToolCliContext['compareBaseline'],
    exportBaselineSarif: (() => Promise.resolve()) as ToolCliContext['exportBaselineSarif'],
    exportBaselineFingerprints: (() =>
      Promise.resolve()) as ToolCliContext['exportBaselineFingerprints'],
    toolState: {
      get: (tool: string, key: string) => {
        calls.push(`toolState.get:${tool}:${key}`);
        if (key === 'boom') {
          return Promise.reject(new Error('host toolState.get faulted for key boom'));
        }
        return Promise.resolve(toolStateStore.get(`${tool}:${key}`));
      },
      put: (tool: string, key: string, payload: unknown) => {
        toolStateStore.set(`${tool}:${key}`, payload);
        calls.push(`toolState.put:${tool}:${key}`);
        return Promise.resolve();
      },
      delete: (tool: string, key: string) => {
        toolStateStore.delete(`${tool}:${key}`);
        calls.push(`toolState.delete:${tool}:${key}`);
        return Promise.resolve();
      },
      list: (tool: string) => {
        calls.push(`toolState.list:${tool}`);
        const prefix = `${tool}:`;
        const keys = [...toolStateStore.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length));
        return Promise.resolve(keys);
      },
    },
  } satisfies ToolCliContext;
  return {
    ctx,
    envelopes,
    rendered,
    jsons,
    raws,
    errors,
    reportedFailures,
    exitCodes,
    calls,
    toolStateStore,
    baselines,
    delivered,
    artifacts,
    ensuredDirs,
  };
}
