/**
 * Phase 3 (ADR-0011) end-to-end: the composition root can fully handle an
 * envelope-bearing result through every (formatter × sink) path — `--json`
 * (`emitEnvelope` → `formatSignalJson` → stdout), the terminal table
 * (`renderResult` → `envelopeToTableView`), cloud sync (`deliverEnvelope` →
 * `scope.signalSink`), and `--report-to` (envelope → SARIF → http, owning
 * exit 4) — driven by a hand-built envelope. This pins the migrated root path:
 * envelope-bearing tool results are rendered and delivered by the composition
 * root instead of by tool-local formatters.
 */
import { renderToText } from '@opensip-tools/cli-ui';
import { EXIT_CODES, type CommandOutcome, type FitDoneResult, type SignalEnvelope } from '@opensip-tools/contracts';
import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runWithScope,
  type EmitResult,
  type SignalBatch,
  type SignalSink,
} from '@opensip-tools/core';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverEnvelope } from '../bootstrap/deliver-envelope.js';
import { renderResult } from '../bootstrap/render.js';
import { buildToolCliContext, createLiveViewRegistry } from '../cli-context.js';
import { envelopeToTableView } from '../ui/result-to-view.js';

/** Deterministic two-unit envelope (no clock / id generation). */
const ENVELOPE: SignalEnvelope = {
  schemaVersion: 2,
  tool: 'fit',
  recipe: 'example',
  runId: 'run_routing0001',
  createdAt: '2026-06-04T00:00:00.000Z',
  verdict: {
    score: 50,
    passed: false,
    summary: { total: 2, passed: 1, failed: 1, errors: 1, warnings: 1 },
  },
  units: [
    { slug: 'no-console', passed: false, violationCount: 1, durationMs: 5 },
    { slug: 'no-todo', passed: true, violationCount: 0, durationMs: 3 },
  ],
  signals: [
    {
      id: 'sig_routing0001',
      source: 'no-console',
      provider: 'opensip-tools',
      severity: 'high',
      category: 'quality',
      ruleId: 'no-console',
      message: 'console.log left in source',
      filePath: 'src/a.ts',
      line: 1,
      column: 1,
      code: { file: 'src/a.ts', line: 1, column: 1 },
      metadata: {},
      createdAt: '2026-06-04T00:00:00.000Z',
    },
    {
      id: 'sig_routing0002',
      source: 'no-todo',
      provider: 'opensip-tools',
      severity: 'low',
      category: 'quality',
      ruleId: 'no-todo',
      message: 'TODO comment',
      filePath: 'src/b.ts',
      line: 9,
      column: 2,
      code: { file: 'src/b.ts', line: 9, column: 2 },
      metadata: {},
      createdAt: '2026-06-04T00:00:00.000Z',
    },
  ],
};

function makeScope(signalSink?: SignalSink): RunScope {
  return new RunScope({
    tools: new ToolRegistry(),
    languages: new LanguageRegistry(),
    signalSink,
  });
}

// A `--report-to` receiver returning 400 is non-transient → postChunked aborts
// without retry/backoff (the test stays fast). 200 = success.
const FAIL_400: typeof fetch = () => Promise.resolve(new Response('nope', { status: 400 }));
const OK_200: typeof fetch = () => Promise.resolve(new Response('{}', { status: 200 }));
const NOOP_SINK: SignalSink = { emit: () => Promise.resolve({ accepted: 0, authRejected: false }) };

/** Stringify a `fetch` URL argument (only the string form is exercised here). */
function urlString(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === 'string') return url;
  return url instanceof URL ? url.href : '';
}

let stdout: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdout = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
});

describe('root --json path (emitEnvelope)', () => {
  it('wraps the (unchanged) envelope in a CommandOutcome under .envelope (2.12.0)', () => {
    const { ctx } = buildToolCliContext({
      program: new Command(),
      render: renderResult,
      liveViews: createLiveViewRegistry(),
      maybeOpenDashboard: () => Promise.resolve(),
    });

    ctx.emitEnvelope(ENVELOPE);

    expect(stdout).toHaveLength(1);
    // 2.12.0 (§5.5): --json now emits a CommandOutcome wrapper; the byte-identical
    // envelope rides under `.envelope` (consumers read `.envelope` instead of the
    // top level). kind is derived from the envelope's tool id.
    const outcome = JSON.parse(stdout[0]) as CommandOutcome;
    expect(outcome.kind).toBe('fit.run');
    expect(outcome.status).toBe('ok');
    const parsed = outcome.envelope!;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.verdict.passed).toBe(false);
    expect(parsed.verdict.score).toBe(50);
    expect(parsed.signals).toHaveLength(2);
    // jq-able verdict (now `.envelope.verdict.*`) — the documented CI ergonomic.
    expect(parsed.units.map((u) => u.slug)).toEqual(['no-console', 'no-todo']);
  });
});

describe('root table path (renderResult derives the table from the envelope)', () => {
  it('derives the per-unit table from the envelope the result carries', async () => {
    const result: FitDoneResult = {
      type: 'fit-done',
      label: 'fit',
      cwd: '/tmp',
      envelope: ENVELOPE,
    };

    await runWithScope(makeScope(), () => renderResult(result));

    const out = stdout.join('');
    // One row per UNIT (not per finding) — the envelope-derived neutral table.
    expect(out).toContain('no-console');
    expect(out).toContain('no-todo');
    expect(out).toContain('FAIL');
    expect(out).toContain('PASS');
    // The shared run-summary line is derived from verdict.summary.
    expect(out).toMatch(/1 Passed/);
    expect(out).toMatch(/1 Failed/);
  });
});

describe('envelopeToTableView', () => {
  it('renders a node with one row per unit and the verdict summary', () => {
    const text = renderToText(envelopeToTableView(ENVELOPE));
    expect(text).toContain('no-console');
    expect(text).toContain('no-todo');
    expect(text).toMatch(/1 Passed/);
  });
});

describe('root cloud egress (deliverEnvelope → scope.signalSink)', () => {
  it('maps the envelope to a SignalBatch preserving runId and emits it', async () => {
    const seen: SignalBatch[] = [];
    const sink: SignalSink = {
      emit: (batch: SignalBatch): Promise<EmitResult> => {
        seen.push(batch);
        return Promise.resolve({ accepted: batch.signals.length, authRejected: false });
      },
    };

    const out = await runWithScope(makeScope(sink), () =>
      deliverEnvelope(ENVELOPE, { cwd: process.cwd(), repo: {} }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].schemaVersion).toBe(1); // cloud wire shape stays v1
    expect(seen[0].runId).toBe('run_routing0001'); // run identity preserved
    expect(seen[0].tool).toBe('fit');
    expect(seen[0].signals).toHaveLength(2);
    // verdict/units are dropped on the cloud wire shape.
    expect('verdict' in seen[0]).toBe(false);
    expect('units' in seen[0]).toBe(false);
    expect(out.cloudAccepted).toBe(2);
  });

  it('never throws and reports 0 accepted when the sink reports zero', async () => {
    const sink: SignalSink = {
      emit: () => Promise.resolve({ accepted: 0, authRejected: false }),
    };
    const out = await runWithScope(makeScope(sink), () =>
      deliverEnvelope(ENVELOPE, { cwd: process.cwd(), repo: {} }),
    );
    expect(out.cloudAccepted).toBe(0);
  });

  it('swallows a sink that THROWS and reports 0 accepted (best-effort egress)', async () => {
    // Exercises the cloud-egress catch path: a rejecting sink must never crash
    // the run — egress is best-effort and the local run already succeeded.
    const sink: SignalSink = {
      emit: () => Promise.reject(new Error('network down')),
    };
    const out = await runWithScope(makeScope(sink), () =>
      deliverEnvelope(ENVELOPE, { cwd: process.cwd(), repo: {} }),
    );
    expect(out.cloudAccepted).toBe(0);
  });
});

describe('root --report-to (deliverEnvelope owns exit 4)', () => {
  it('formats the envelope to SARIF and POSTs it on --report-to', async () => {
    const seen: { url: string; body: string }[] = [];
    const captureFetch: typeof fetch = (url, init) => {
      seen.push({
        url: urlString(url),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const out = await runWithScope(makeScope(NOOP_SINK), () =>
      deliverEnvelope(ENVELOPE, {
        cwd: process.cwd(),
        repo: {},
        reportTo: 'https://sink.example',
        fetchImpl: captureFetch,
      }),
    );
    expect(out.reportSuccess).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('/sarif');
    const sarif = JSON.parse(seen[0].body) as { version: string; runs: unknown[] };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(1);
  });

  it('sets exit 4 when the report upload fails on an otherwise-passing run', async () => {
    const setExitCode = vi.fn();
    const out = await runWithScope(makeScope(NOOP_SINK), () =>
      deliverEnvelope(ENVELOPE, {
        cwd: process.cwd(),
        repo: {},
        reportTo: 'https://sink.example',
        runFailed: false,
        setExitCode,
        fetchImpl: FAIL_400,
      }),
    );
    expect(out.reportSuccess).toBe(false);
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.REPORT_FAILED);
  });

  it('does NOT set exit 4 when the run already failed (real failure dominates)', async () => {
    const setExitCode = vi.fn();
    await runWithScope(makeScope(NOOP_SINK), () =>
      deliverEnvelope(ENVELOPE, {
        cwd: process.cwd(),
        repo: {},
        reportTo: 'https://sink.example',
        runFailed: true,
        setExitCode,
        fetchImpl: FAIL_400,
      }),
    );
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('cloud sync stays best-effort and never affects exit code', async () => {
    const setExitCode = vi.fn();
    await runWithScope(makeScope(NOOP_SINK), () =>
      deliverEnvelope(ENVELOPE, { cwd: process.cwd(), repo: {}, setExitCode, fetchImpl: OK_200 }),
    );
    expect(setExitCode).not.toHaveBeenCalled();
  });
});
