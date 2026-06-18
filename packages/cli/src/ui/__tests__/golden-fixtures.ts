/**
 * Golden render fixtures (envelope-first-presentation plan).
 *
 * Shared, representative result shapes for fit / sim / graph, used by
 * `golden-fixtures.test.tsx` to capture and assert byte-identity of the
 * human-readable render output (TTY + pipe, ±verbose) across the migration.
 *
 * The load-bearing data for fit/sim is the SignalEnvelope + optional
 * verboseDetail. We define those once per case and expose TWO projections:
 *
 *   - `legacyResult` — the pre-migration `fit-done` / `sim-done` / `graph-done`
 *     CommandResult the tools constructed on `main`. RP-0 captures the goldens
 *     from THIS projection (the unmodified render path).
 *   - `presentationOf` — the post-migration `RunPresentation` carrying the same
 *     envelope/verboseDetail (+ banners for graph). RP-1 asserts that rendering
 *     THIS projection reproduces the same goldens byte-for-byte.
 *
 * Keeping both projections side-by-side means the byte-identity proof is a flip
 * of which projection the test renders — the golden text files never change for
 * fit/sim. (Graph's output is intended to change in RP-2; its goldens are the
 * `legacyResult` baseline that RP-2 diffs against, never an equality target.)
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';

import type {
  CommandResult,
  RunPresentation,
  SignalEnvelope,
  VerboseDetail,
} from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

const CREATED_AT = '2026-06-04T00:00:00.000Z';

function fitSignal(over: {
  source: string;
  severity: Signal['severity'];
  message: string;
  filePath: string;
  line?: number;
}): Signal {
  return {
    id: `sig_${over.source}_${String(over.line ?? 0)}`,
    source: over.source,
    provider: 'opensip-cli',
    severity: over.severity,
    category: 'quality',
    ruleId: over.source,
    message: over.message,
    filePath: over.filePath,
    line: over.line,
    metadata: {},
    createdAt: CREATED_AT,
  };
}

// --- fit envelopes ----------------------------------------------------------

/** Clean fit run: one passing check, no signals. */
const FIT_CLEAN_ENVELOPE: SignalEnvelope = buildSignalEnvelope({
  tool: 'fit',
  runId: 'r',
  createdAt: CREATED_AT,
  units: [{ slug: 'naming', passed: true, durationMs: 3, filesValidated: 10, itemType: 'files' }],
  signals: [],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

/** Fit run with findings: one failing check (2 errors), one passing check. */
const FIT_FINDINGS_ENVELOPE: SignalEnvelope = buildSignalEnvelope({
  tool: 'fit',
  runId: 'r',
  createdAt: CREATED_AT,
  units: [
    {
      slug: 'no-console',
      passed: false,
      durationMs: 5,
      filesValidated: 10,
      itemType: 'files',
      ignoredCount: 0,
    },
    {
      slug: 'naming',
      passed: true,
      durationMs: 3,
      filesValidated: 10,
      itemType: 'files',
      ignoredCount: 0,
    },
  ],
  signals: [
    fitSignal({
      source: 'no-console',
      severity: 'high',
      message: 'console.log',
      filePath: 'a.ts',
      line: 3,
    }),
    fitSignal({
      source: 'no-console',
      severity: 'high',
      message: 'console.log',
      filePath: 'b.ts',
      line: 4,
    }),
    fitSignal({ source: 'naming', severity: 'medium', message: 'bad name', filePath: 'c.ts' }),
  ],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

/** Fit run with an errored unit (loader threw) + a unit with ignores. */
const FIT_ERRORED_ENVELOPE: SignalEnvelope = buildSignalEnvelope({
  tool: 'fit',
  runId: 'r',
  createdAt: CREATED_AT,
  units: [
    { slug: 'loader', passed: false, durationMs: 1, error: 'failed to load' },
    {
      slug: 'naming',
      passed: false,
      durationMs: 2,
      filesValidated: 5,
      itemType: 'files',
      ignoredCount: 3,
    },
  ],
  signals: [fitSignal({ source: 'naming', severity: 'medium', message: 'w0', filePath: 'b.ts' })],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

const FIT_VERBOSE_DETAIL: VerboseDetail = {
  kind: 'findings',
  groups: [
    {
      title: 'No Console',
      errorCount: 1,
      warningCount: 0,
      findings: [{ severity: 'error', message: 'console.log', location: 'a.ts:3' }],
    },
  ],
};

// --- sim envelopes ----------------------------------------------------------

const SIM_CLEAN_ENVELOPE: SignalEnvelope = buildSignalEnvelope({
  tool: 'sim',
  recipe: 'example',
  runId: 'run-1',
  createdAt: CREATED_AT,
  units: [
    { slug: 'a', passed: true, durationMs: 10 },
    { slug: 'c', passed: true, durationMs: 15 },
  ],
  signals: [],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

const SIM_FINDINGS_ENVELOPE: SignalEnvelope = buildSignalEnvelope({
  tool: 'sim',
  recipe: 'example',
  runId: 'run-1',
  createdAt: CREATED_AT,
  units: [
    { slug: 'a', passed: true, durationMs: 10 },
    { slug: 'b', passed: false, durationMs: 20 },
  ],
  signals: [
    {
      id: 'sig_b1',
      source: 'b',
      provider: 'opensip-cli',
      severity: 'high',
      category: 'resilience',
      ruleId: 'invariant.violated',
      message: 'invariant broke',
      filePath: '',
      metadata: {},
      createdAt: CREATED_AT,
    },
  ],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

const SIM_VERBOSE_DETAIL: VerboseDetail = {
  kind: 'findings',
  groups: [
    {
      title: 'Scenario B',
      errorCount: 1,
      warningCount: 0,
      findings: [{ severity: 'error', message: 'invariant broke' }],
    },
  ],
};

// --- graph (current graph-done shape; envelope built for RP-2 target) -------

const GRAPH_VERBOSE_DETAIL: VerboseDetail = {
  kind: 'lines',
  lines: ['== Catalog ==', '5 functions across 2 files (cacheHit=false)'],
};

/**
 * One golden case. `legacyResult` is the pre-migration CommandResult (captured
 * in RP-0). `presentation` (when present) is the post-migration RunPresentation
 * that must render byte-identically (asserted in RP-1 for fit/sim).
 */
export interface GoldenCase {
  readonly name: string;
  readonly tool: 'fit' | 'sim' | 'graph';
  /** Pre-migration CommandResult — the RP-0 golden source. */
  readonly legacyResult: CommandResult;
  /**
   * Post-migration RunPresentation carrying the same envelope/verboseDetail.
   * Present for fit/sim (byte-identity targets); graph adds it in RP-2.
   */
  readonly presentation?: RunPresentation;
}

function fitCase(
  name: string,
  envelope: SignalEnvelope,
  verboseDetail: VerboseDetail | undefined,
): GoldenCase {
  return {
    name,
    tool: 'fit',
    legacyResult: {
      type: 'fit-done',
      label: 'fit',
      cwd: '/x',
      envelope,
      ...(verboseDetail ? { verboseDetail } : {}),
    },
    // NB: no `durationMs` on the presentation. fit's current render path ignores
    // any duration override and falls to the envelope unit-sum; RP-1 Task 1.1's
    // builder likewise omits durationMs, so the presentation renders the SAME
    // unit-sum duration → byte-identical. (durationOverride exists for graph,
    // whose units carry durationMs:0 — RP-2.)
    presentation: {
      type: 'run-presentation',
      tool: 'fitness',
      envelope,
      ...(verboseDetail ? { verboseDetail } : {}),
    },
  };
}

function simCase(
  name: string,
  envelope: SignalEnvelope,
  verboseDetail: VerboseDetail | undefined,
): GoldenCase {
  return {
    name,
    tool: 'sim',
    legacyResult: {
      // sim-done carries a durationMs field today (recipe makespan), but the
      // current resultToView fit/sim case IGNORES it and renders the unit-sum.
      // We set it here to mirror the real result shape; it must NOT change the
      // render. RP-1 Task 1.3's presentation builder omits durationMs likewise.
      type: 'sim-done',
      recipeName: 'example',
      cwd: '/x',
      durationMs: 1500,
      envelope,
      ...(verboseDetail ? { verboseDetail } : {}),
    },
    presentation: {
      type: 'run-presentation',
      tool: 'simulation',
      envelope,
      ...(verboseDetail ? { verboseDetail } : {}),
    },
  };
}

/**
 * The golden cases. The fit/sim presentation projections deliberately omit
 * `durationMs` — matching the RP-1 builders — so they render the same unit-sum
 * summary duration the legacy path does, keeping the output byte-identical.
 */
export const GOLDEN_CASES: readonly GoldenCase[] = [
  fitCase('fit-clean', FIT_CLEAN_ENVELOPE, undefined),
  fitCase('fit-findings', FIT_FINDINGS_ENVELOPE, undefined),
  fitCase('fit-findings-verbose', FIT_FINDINGS_ENVELOPE, FIT_VERBOSE_DETAIL),
  fitCase('fit-errored', FIT_ERRORED_ENVELOPE, undefined),
  simCase('sim-clean', SIM_CLEAN_ENVELOPE, undefined),
  simCase('sim-findings', SIM_FINDINGS_ENVELOPE, undefined),
  simCase('sim-findings-verbose', SIM_FINDINGS_ENVELOPE, SIM_VERBOSE_DETAIL),
  // graph: current graph-done shape (RP-0 baseline; RP-2 will diverge).
  {
    name: 'graph-clean',
    tool: 'graph',
    legacyResult: {
      type: 'graph-done',
      summary: { passed: 3, failed: 0, errors: 0, warnings: 0 },
      durationMs: 1200,
    },
  },
  {
    name: 'graph-findings',
    tool: 'graph',
    legacyResult: {
      type: 'graph-done',
      resolutionBanner: 'Resolution: fast (syntactic) — edges are approximate.',
      summary: { passed: 1, failed: 1, errors: 0, warnings: 3 },
      durationMs: 1200,
    },
  },
  {
    name: 'graph-verbose',
    tool: 'graph',
    legacyResult: {
      type: 'graph-done',
      verboseDetail: GRAPH_VERBOSE_DETAIL,
      resolutionBanner: 'Resolution: fast (syntactic) — edges are approximate.',
      summary: { passed: 1, failed: 1, errors: 0, warnings: 0 },
      durationMs: 50,
    },
  },
];
