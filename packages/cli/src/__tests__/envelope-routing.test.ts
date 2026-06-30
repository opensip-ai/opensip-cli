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
import { renderToText } from '@opensip-cli/cli-ui';
import {
  EXIT_CODES,
  type CommandOutcome,
  type RunPresentation,
  type SignalEnvelope,
} from '@opensip-cli/contracts';
import {
  LanguageRegistry,
  noopSignalSink,
  RunScope,
  ToolRegistry,
  runWithScope,
  type EmitResult,
  type SignalBatch,
  type SignalSink,
} from '@opensip-cli/core';
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
      provider: 'opensip-cli',
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
      provider: 'opensip-cli',
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
  baselineIdentity: {
    fingerprintStrategyId: 'fitness.sha256-file-rule-message',
    fingerprintStrategyVersion: 1,
  },
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
// The core no-op sink. deliverEnvelope short-circuits on the `noop: true`
// discriminator (behavioral, NOT identity), so the cloud leg stays silent —
// the keyless/opted-out contract. Any structurally-equivalent no-op sink
// substitutes; see the dedicated substitutability test below.
const NOOP_SINK: SignalSink = noopSignalSink;

/** Stringify a `fetch` URL argument (only the string form is exercised here). */
function urlString(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === 'string') return url;
  return url instanceof URL ? url.href : '';
}

let stdout: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  stdout = [];
  originalExitCode = process.exitCode;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  // The real `emitError` seam threads exit codes to `process.exitCode`; restore
  // it so a test's error exit code does not leak to the runner.
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

function buildEmitErrorCtx() {
  return buildToolCliContext({
    render: renderResult,
    liveViews: createLiveViewRegistry(),
    maybeOpenReport: () => Promise.resolve(),
  }).ctx;
}

describe('root --json error path (emitError)', () => {
  it('emits a status:error CommandOutcome with the suggestion + code (2.12.0 seam)', () => {
    buildEmitErrorCtx().emitError({
      message: 'bad input',
      exitCode: 2,
      suggestion: 'fix it',
      code: 'CONFIG',
    });
    expect(stdout).toHaveLength(1);
    const outcome = JSON.parse(stdout[0]) as CommandOutcome;
    expect(outcome.status).toBe('error');
    expect(outcome.exitCode).toBe(2);
    expect(process.exitCode).toBe(2); // threaded to the process exit
  });

  it('emits a status:error CommandOutcome for a bare message (no suggestion/code)', () => {
    buildEmitErrorCtx().emitError({ message: 'bare error', exitCode: 1 });
    const outcome = JSON.parse(stdout[0]) as CommandOutcome;
    expect(outcome.status).toBe('error');
    expect(outcome.exitCode).toBe(1);
  });
});

describe('root --json path (emitEnvelope)', () => {
  it('wraps the (unchanged) envelope in a CommandOutcome under .envelope (2.12.0)', () => {
    const { ctx } = buildToolCliContext({
      render: renderResult,
      liveViews: createLiveViewRegistry(),
      maybeOpenReport: () => Promise.resolve(),
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

describe('root render path (renderResult derives the run view from the envelope)', () => {
  it('renders the compact non-verbose summary from the envelope the result carries', async () => {
    const result: RunPresentation = {
      type: 'run-presentation',
      tool: 'fitness',
      envelope: ENVELOPE,
    };

    await runWithScope(makeScope(), () => renderResult(result));

    const out = stdout.join('');
    expect(out).not.toContain('no-console');
    expect(out).not.toContain('no-todo');
    expect(out).not.toContain('Unit');
    expect(out).not.toContain('Status');
    // ADR-0035: the headline is the run's single verdict (errors=1 → FAIL).
    expect(out).toContain('FAIL  (1 Errors, 1 Warnings)');
    expect(out).toContain('Use --verbose for detailed results');
  });

  it('renders the per-unit table when the run carries verbose detail', async () => {
    const result: RunPresentation = {
      type: 'run-presentation',
      tool: 'fitness',
      envelope: ENVELOPE,
      verboseDetail: { kind: 'findings', groups: [] },
    };

    await runWithScope(makeScope(), () => renderResult(result));

    const out = stdout.join('');
    // One row per UNIT (not per finding) — the envelope-derived neutral table.
    // Per-unit row status: no-console FAIL, no-todo PASS.
    expect(out).toContain('no-console');
    expect(out).toContain('no-todo');
    expect(out).toContain('PASS'); // no-todo row status
    expect(out).toContain('FAIL  (1 Errors, 1 Warnings)');
    expect(out).not.toContain('Use --verbose for detailed results');
  });
});

describe('envelopeToTableView', () => {
  it('renders a node with one row per unit and the verdict summary', () => {
    const text = renderToText(envelopeToTableView(ENVELOPE));
    expect(text).toContain('no-console');
    expect(text).toContain('no-todo');
    // ADR-0035: the summary line is the single PASS/FAIL verdict (errors=1 → FAIL).
    expect(text).toContain('FAIL  (1 Errors, 1 Warnings)');
  });
});

describe('root cloud egress (deliverEnvelope → scope.signalSink)', () => {
  it('maps the envelope to a SignalBatch preserving runId and emits it', async () => {
    const seen: SignalBatch[] = [];
    const sink: SignalSink = {
      emit: (batch: SignalBatch): Promise<EmitResult> => {
        seen.push(batch);
        return Promise.resolve({
          accepted: batch.signals.length,
          authRejected: false,
        });
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

  it('dedupes signals before cloud egress', async () => {
    const seen: SignalBatch[] = [];
    const sink: SignalSink = {
      emit: (batch: SignalBatch): Promise<EmitResult> => {
        seen.push(batch);
        return Promise.resolve({
          accepted: batch.signals.length,
          authRejected: false,
        });
      },
    };
    const duplicateEnvelope: SignalEnvelope = {
      ...ENVELOPE,
      verdict: {
        ...ENVELOPE.verdict,
        summary: { total: 2, passed: 1, failed: 1, errors: 2, warnings: 1 },
      },
      units: [
        { slug: 'no-console', passed: false, violationCount: 2, durationMs: 5 },
        ENVELOPE.units[1],
      ],
      signals: [
        ...ENVELOPE.signals,
        {
          ...ENVELOPE.signals[0],
          id: 'sig_routing0001_duplicate',
          column: 99,
          code: { file: 'src/a.ts', line: 1, column: 99 },
        },
      ],
    };

    const out = await runWithScope(makeScope(sink), () =>
      deliverEnvelope(duplicateEnvelope, { cwd: process.cwd(), repo: {} }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].signals).toHaveLength(2);
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
    expect(out.cloudSkippedReason).toBe('error');
  });

  it('surfaces an unentitled skip as a reason on the result (no noisy stderr; configure already informed the user)', async () => {
    // Unentitled is a steady-state fact about the key/plan. We still surface the
    // reason in the structured Deliver result (for hosts, logs, and any caller
    // that wants to know "signals did not reach cloud"), but we no longer spam
    // a per-run stderr line for it (the configure flow already warned, and
    // local results are unaffected per ADR-0008). Transient 'error' cases still
    // notify on stderr.
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const sink: SignalSink = {
        emit: () =>
          Promise.resolve({
            accepted: 0,
            authRejected: false,
            skippedReason: 'unentitled',
          }),
      };
      const out = await runWithScope(makeScope(sink), () =>
        deliverEnvelope(ENVELOPE, { cwd: process.cwd(), repo: {} }),
      );
      expect(out.cloudAccepted).toBe(0);
      expect(out.cloudSkippedReason).toBe('unentitled');
      const stderr = writes.join('');
      expect(stderr).not.toContain('cloud sync skipped');
      expect(stderr).not.toContain('not entitled');
    } finally {
      spy.mockRestore();
    }
  });

  it('stays silent on the no-op sink — the keyless/opted-out majority asked for nothing', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const out = await runWithScope(makeScope(noopSignalSink), () =>
        deliverEnvelope(ENVELOPE, { cwd: process.cwd(), repo: {} }),
      );
      expect(out.cloudAccepted).toBe(0);
      expect(out.cloudSkippedReason).toBeUndefined();
      expect(writes.join('')).not.toContain('cloud sync skipped');
    } finally {
      spy.mockRestore();
    }
  });

  it("stays silent on a HOST'S OWN no-op sink (substitutability — `noop: true`, not identity)", async () => {
    // An embedded/SaaS host may install its own no-delivery sink. The root
    // discriminates on the `noop` marker, never on identity with the core
    // singleton — a structurally no-op sink must behave identically to it.
    const hostNoopSink: SignalSink = {
      noop: true,
      emit: () => Promise.resolve({ accepted: 0, authRejected: false }),
    };
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const out = await runWithScope(makeScope(hostNoopSink), () =>
        deliverEnvelope(ENVELOPE, { cwd: process.cwd(), repo: {} }),
      );
      expect(out.cloudAccepted).toBe(0);
      expect(out.cloudSkippedReason).toBeUndefined();
      expect(writes.join('')).not.toContain('cloud sync skipped');
    } finally {
      spy.mockRestore();
    }
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
    const sarif = JSON.parse(seen[0].body) as {
      version: string;
      runs: unknown[];
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(1);
  });

  it('attaches x-opensip-repo: <org>/<repo> derived from the repo remote (slot 16)', async () => {
    const headersSeen: Record<string, string>[] = [];
    const captureFetch: typeof fetch = (_url, init) => {
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const out = await runWithScope(makeScope(NOOP_SINK), () =>
      deliverEnvelope(ENVELOPE, {
        cwd: process.cwd(),
        repo: { remoteUrl: 'git@github.com:opensip-ai/opensip-cli.git' },
        reportTo: 'https://sink.example',
        fetchImpl: captureFetch,
      }),
    );
    expect(out.reportSuccess).toBe(true);
    expect(headersSeen).toHaveLength(1);
    expect(headersSeen[0]['x-opensip-repo']).toBe('opensip-ai/opensip-cli');
  });

  it('omits x-opensip-repo when no <org>/<repo> slug can be derived (soft accept)', async () => {
    const headersSeen: Record<string, string>[] = [];
    const captureFetch: typeof fetch = (_url, init) => {
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    await runWithScope(makeScope(NOOP_SINK), () =>
      deliverEnvelope(ENVELOPE, {
        cwd: process.cwd(),
        repo: {}, // no remote → no slug
        reportTo: 'https://sink.example',
        fetchImpl: captureFetch,
      }),
    );
    expect(headersSeen).toHaveLength(1);
    expect('x-opensip-repo' in headersSeen[0]).toBe(false);
  });

  it('surfaces a distinct hint on 401 (key rejected) vs 403 (missing ingest:write)', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const reject =
        (status: number): typeof fetch =>
        () =>
          Promise.resolve(new Response('denied', { status }));

      await runWithScope(makeScope(NOOP_SINK), () =>
        deliverEnvelope(ENVELOPE, {
          cwd: process.cwd(),
          repo: {},
          reportTo: 'https://sink.example',
          runFailed: false,
          setExitCode: vi.fn(),
          fetchImpl: reject(401),
        }),
      );
      const after401 = writes.join('');
      expect(after401).toContain('--report-to failed');
      expect(after401).toContain('the API key was rejected');

      writes.length = 0;
      await runWithScope(makeScope(NOOP_SINK), () =>
        deliverEnvelope(ENVELOPE, {
          cwd: process.cwd(),
          repo: {},
          reportTo: 'https://sink.example',
          runFailed: false,
          setExitCode: vi.fn(),
          fetchImpl: reject(403),
        }),
      );
      const after403 = writes.join('');
      expect(after403).toContain('ingest:write');
      expect(after403).not.toContain('the API key was rejected');
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves exit-code precedence on a 403 report failure (exit 4 only when run passed)', async () => {
    const setExitCode = vi.fn();
    await runWithScope(makeScope(NOOP_SINK), () =>
      deliverEnvelope(ENVELOPE, {
        cwd: process.cwd(),
        repo: {},
        reportTo: 'https://sink.example',
        runFailed: false,
        setExitCode,
        fetchImpl: () => Promise.resolve(new Response('denied', { status: 403 })),
      }),
    );
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.REPORT_FAILED);
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

  it('sets the findings exit (RUNTIME_ERROR), not exit 4, when the run failed (real failure dominates)', async () => {
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
    // ADR-0035: the host now owns the findings exit — a failed run sets
    // RUNTIME_ERROR, and the report-upload failure (exit 4) is suppressed so the
    // real failure dominates.
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    expect(setExitCode).not.toHaveBeenCalledWith(EXIT_CODES.REPORT_FAILED);
  });

  it('cloud sync stays best-effort and never affects exit code', async () => {
    const setExitCode = vi.fn();
    // A PASSING envelope (no report-to) isolates cloud sync: the host only sets
    // the findings exit when verdict.passed is false (ADR-0035), so with a passing
    // verdict the cloud-only path must leave the exit code untouched.
    const passing: SignalEnvelope = {
      ...ENVELOPE,
      verdict: { ...ENVELOPE.verdict, passed: true },
    };
    await runWithScope(makeScope(NOOP_SINK), () =>
      deliverEnvelope(passing, {
        cwd: process.cwd(),
        repo: {},
        setExitCode,
        fetchImpl: OK_200,
      }),
    );
    expect(setExitCode).not.toHaveBeenCalled();
  });
});
