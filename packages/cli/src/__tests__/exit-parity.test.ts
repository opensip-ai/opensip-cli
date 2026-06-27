/**
 * exit-parity (ADR-0035) — the host owns the findings exit code, and it is a
 * PURE FUNCTION of `envelope.verdict.passed`. `deliverEnvelope` is the single
 * authority for every tool (fit/sim/graph): a failing verdict → RUNTIME_ERROR,
 * a passing verdict → no findings exit. The gate-COMPARE modes pass a `runFailed`
 * override (their baseline-diff verdict), which the host honours instead of the
 * findings verdict.
 *
 * Plus a structural guard: no tool computes its own findings exit anymore —
 * `shouldFail` is gone from production source, and no tool sets RUNTIME_ERROR for
 * the findings path (only the host's deliver-envelope does).
 */

import { execFileSync } from 'node:child_process';

import { buildSignalEnvelope, EXIT_CODES, type SignalEnvelope } from '@opensip-cli/contracts';
import {
  HOST_VERDICT_POLICY_FALLBACK,
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  createSignal,
  runWithScope,
  type SignalSink,
  type ToolShortId,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { deliverEnvelope, deriveReportExitDecision } from '../bootstrap/deliver-envelope.js';

const NOOP_SINK: SignalSink = {
  emit: () => Promise.resolve({ accepted: 0, authRejected: false }),
};

function scope(): RunScope {
  return new RunScope({
    tools: new ToolRegistry(),
    languages: new LanguageRegistry(),
    signalSink: NOOP_SINK,
  });
}

/** Build a {passing|failing}-verdict envelope for a tool under the {1,0} policy. */
function envelope(tool: ToolShortId, failing: boolean): SignalEnvelope {
  return buildSignalEnvelope({
    tool,
    runId: 'r',
    createdAt: '2026-01-01T00:00:00.000Z',
    units: [{ slug: 'u', passed: !failing, durationMs: 1 }],
    signals: failing
      ? [
          createSignal({
            source: 'u',
            severity: 'high',
            ruleId: 'r',
            message: 'x',
          }),
        ]
      : [],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

async function exitFor(env: SignalEnvelope, override?: boolean): Promise<ReturnType<typeof vi.fn>> {
  const setExitCode = vi.fn();
  await runWithScope(scope(), () =>
    deliverEnvelope(env, {
      cwd: process.cwd(),
      repo: {},
      setExitCode,
      ...(override === undefined ? {} : { runFailed: override }),
    }),
  );
  return setExitCode;
}

describe('exit-parity · findings exit is a pure function of verdict.passed', () => {
  // Per-tool matrix: the host treats fit/sim/graph identically — exit follows the
  // verdict. fit (thresholds), graph gate-save (errorCount>0 == {1,0}), and sim
  // (failed>0 == errors>0 after Phase 0) all reduce to the same verdict.
  for (const tool of ['fit', 'sim', 'graph'] as const) {
    it(`${tool}: a failing verdict sets RUNTIME_ERROR`, async () => {
      const setExitCode = await exitFor(envelope(tool, true));
      expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    });

    it(`${tool}: a passing verdict sets no findings exit`, async () => {
      const setExitCode = await exitFor(envelope(tool, false));
      expect(setExitCode).not.toHaveBeenCalled();
    });
  }

  it('gate-compare override (degraded=true) FAILS even when the run verdict passes', async () => {
    const setExitCode = await exitFor(envelope('graph', false), /* runFailed */ true);
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
  });

  it('gate-compare override (degraded=false) PASSES even when the run verdict fails', async () => {
    const setExitCode = await exitFor(envelope('graph', true), /* runFailed */ false);
    expect(setExitCode).not.toHaveBeenCalled();
  });
});

/** Focused exit-code derivation matrix (Task 1 of composition-root-hardening). */
describe('exit-parity · report-upload vs findings precedence matrix (pure seam)', () => {
  const REPORT_FAILED = EXIT_CODES.REPORT_FAILED;

  it('findings failure (runFailed=true) + report fail → keeps RUNTIME_ERROR (no 4)', () => {
    expect(deriveReportExitDecision('https://ex', false, true)).toBeUndefined();
  });

  it('findings failure (verdict fail) + report fail → keeps RUNTIME_ERROR (no 4)', () => {
    expect(deriveReportExitDecision('https://ex', false, true)).toBeUndefined();
  });

  it('passing run + report fail → sets REPORT_FAILED (4)', () => {
    expect(deriveReportExitDecision('https://ex', false, false)).toBe(REPORT_FAILED);
  });

  it('passing run + report success → no report exit', () => {
    expect(deriveReportExitDecision('https://ex', true, false)).toBeUndefined();
  });

  it('no reportTo → never decides a report exit', () => {
    expect(deriveReportExitDecision(undefined, false, false)).toBeUndefined();
    expect(deriveReportExitDecision('', false, false)).toBeUndefined();
  });

  it('findings pass + no report → no exit decision from report seam', () => {
    expect(deriveReportExitDecision(undefined, true, false)).toBeUndefined();
  });
});

describe('exit-parity · structural guard (no tool computes its own findings exit)', () => {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();

  it('`shouldFail` is gone from production source (ADR-0035)', () => {
    const hits = grep(repoRoot, 'shouldFail');
    expect(hits, `shouldFail must not appear in production source:\n${hits.join('\n')}`).toEqual(
      [],
    );
  });

  it('no tool sets RUNTIME_ERROR for the findings path (only the host does)', () => {
    // Allowlist: the host seam (deliver-envelope) owns the findings exit. The
    // remaining writers are NON-findings exits owned by distinct commands: the
    // gate-mode commands (graph-modes gate-save/compare), the --workspace
    // child-aggregation (graph-workspace-mode.ts), graph's top-level error
    // mapper (graph.ts), and the graph equivalence-check subcommand.
    const allow =
      /deliver-envelope|graph-modes|graph-workspace-mode|graph\.ts|equivalence-check-command/;
    const hits = grep(repoRoot, 'setExitCode(EXIT_CODES.RUNTIME_ERROR)').filter(
      (f) => !allow.test(f),
    );
    expect(hits, `findings exit must be host-owned:\n${hits.join('\n')}`).toEqual([]);
  });
});

/**
 * Production-source grep (excludes tests) via `git grep` with an argument array
 * — no shell, so the fixed-string needle cannot be interpreted. Returns matching
 * tracked file paths (gitignored `dist/` is never searched).
 */
function grep(repoRoot: string, needle: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-l', '-F', needle, '--', 'packages', ':!*.test.ts', ':!*.test.tsx'],
      { cwd: repoRoot },
    )
      .toString()
      .trim();
    return out === '' ? [] : out.split('\n');
  } catch {
    // git grep exits 1 (and throws) when there are no matches.
    return [];
  }
}
