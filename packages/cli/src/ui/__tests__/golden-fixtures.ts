/**
 * Golden render fixtures (envelope-first-presentation plan).
 *
 * Shared, representative result shapes for fit / sim / graph, used by
 * `golden-fixtures.test.tsx` to capture and assert byte-identity of the
 * human-readable render output (TTY + pipe, ±verbose) across the migration.
 *
 * The load-bearing data for fit/sim is the SignalEnvelope + optional
 * verboseDetail. Each case exposes its `presentation` — the post-migration
 * `RunPresentation` carrying the envelope/verboseDetail (+ banners for graph) —
 * which the test renders against the committed goldens. fit/sim goldens were
 * captured byte-for-byte from the pre-migration render path (the migration must
 * not change a single byte); graph's goldens were regenerated in RP-2 to the new
 * envelope-backed output (intentional, enumerated deltas), not a byte-identity
 * target.
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';

import type { RunPresentation, SignalEnvelope, VerboseDetail } from '@opensip-cli/contracts';
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

// --- graph (RP-2: envelope-backed RunPresentation; output INTENTIONALLY changes) ---

const GRAPH_VERBOSE_DETAIL: VerboseDetail = {
  kind: 'lines',
  lines: ['== Catalog ==', '5 functions across 2 files (cacheHit=false)'],
};

/** Graph signal — `category: 'architecture'`, source === ruleId (post Option-A remap). */
function graphSignal(over: {
  source: string;
  severity: Signal['severity'];
  message: string;
  filePath: string;
  line?: number;
}): Signal {
  return {
    id: `gsig_${over.source}_${String(over.line ?? 0)}`,
    source: over.source,
    provider: 'opensip-cli',
    severity: over.severity,
    category: 'architecture',
    ruleId: over.source,
    message: over.message,
    filePath: over.filePath,
    line: over.line,
    metadata: {},
    createdAt: CREATED_AT,
  };
}

/**
 * Clean graph run: rules fired with no error-severity findings. Graph units
 * carry `durationMs: 0` (build-envelope.ts) — so the RunPresentation MUST thread
 * `durationMs` for the summary to show the real wall-clock (not 0ms). This is
 * the non-regression guarantee (RP-0 Task 0.4 durationOverride thread).
 */
const GRAPH_CLEAN_ENVELOPE: SignalEnvelope = buildSignalEnvelope({
  tool: 'graph',
  runId: 'r',
  createdAt: CREATED_AT,
  units: [
    { slug: 'graph.architecture.cycle', passed: true, violationCount: 0, durationMs: 0 },
    { slug: 'graph.dead-code.orphan-subtree', passed: true, violationCount: 0, durationMs: 0 },
  ],
  signals: [],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

/** Graph run with warning-severity findings on a fast (syntactic) catalog. */
const GRAPH_FINDINGS_ENVELOPE: SignalEnvelope = buildSignalEnvelope({
  tool: 'graph',
  runId: 'r',
  createdAt: CREATED_AT,
  resolutionMode: 'fast',
  units: [
    { slug: 'graph.dead-code.orphan-subtree', passed: true, violationCount: 3, durationMs: 0 },
    { slug: 'graph.architecture.cycle', passed: true, violationCount: 0, durationMs: 0 },
  ],
  signals: [
    graphSignal({
      source: 'graph.dead-code.orphan-subtree',
      severity: 'medium',
      message: 'orphan subtree',
      filePath: 'src/a.ts',
      line: 1,
    }),
    graphSignal({
      source: 'graph.dead-code.orphan-subtree',
      severity: 'low',
      message: 'orphan subtree',
      filePath: 'src/b.ts',
      line: 2,
    }),
    graphSignal({
      source: 'graph.dead-code.orphan-subtree',
      severity: 'low',
      message: 'orphan subtree',
      filePath: 'src/c.ts',
      line: 3,
    }),
  ],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

/** Graph's fast-tier resolution caveat — rendered as a muted banner above the table. */
const GRAPH_RESOLUTION_BANNER =
  'Resolution: fast (syntactic) — edges are approximate; re-run with --resolution exact for semantic precision.';

/**
 * Build a graph RunPresentation. `durationMs` is threaded (host-owned, ADR-0051)
 * so the summary shows the real wall-clock despite graph's `durationMs: 0` units.
 */
function graphCase(
  name: string,
  envelope: SignalEnvelope,
  opts: {
    readonly verboseDetail?: VerboseDetail;
    readonly banner?: string;
    readonly durationMs: number;
  },
): GoldenCase {
  const presentation: RunPresentation = {
    type: 'run-presentation',
    tool: 'graph',
    envelope,
    ...(opts.verboseDetail ? { verboseDetail: opts.verboseDetail } : {}),
    ...(opts.banner === undefined ? {} : { banners: [opts.banner] }),
    durationMs: opts.durationMs,
  };
  return { name, tool: 'graph', presentation };
}

/**
 * One golden case. `presentation` is the {@link RunPresentation} the test renders
 * against the committed goldens (byte-identity targets for fit/sim; the
 * regenerated envelope-backed output for graph).
 */
export interface GoldenCase {
  readonly name: string;
  readonly tool: 'fit' | 'sim' | 'graph';
  readonly presentation: RunPresentation;
}

function fitCase(
  name: string,
  envelope: SignalEnvelope,
  verboseDetail: VerboseDetail | undefined,
): GoldenCase {
  // NB: no `durationMs` on the presentation. fit's render path falls to the
  // envelope unit-sum; the RP-1 builder likewise omits durationMs, so the
  // presentation renders the unit-sum duration. (durationOverride exists for
  // graph, whose units carry durationMs:0 — RP-2.)
  const presentation: RunPresentation = {
    type: 'run-presentation',
    tool: 'fitness',
    envelope,
    ...(verboseDetail ? { verboseDetail } : {}),
  };
  return { name, tool: 'fit', presentation };
}

function simCase(
  name: string,
  envelope: SignalEnvelope,
  verboseDetail: VerboseDetail | undefined,
): GoldenCase {
  // The sim builder omits durationMs (the render falls to the envelope unit-sum),
  // mirroring production.
  const presentation: RunPresentation = {
    type: 'run-presentation',
    tool: 'simulation',
    envelope,
    ...(verboseDetail ? { verboseDetail } : {}),
  };
  return { name, tool: 'sim', presentation };
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
  // graph: RP-2 envelope-backed RunPresentation. Output is INTENTIONALLY changed
  // from the RP-0 graph-done baseline (enumerated deltas in the phase file): the
  // count-based summary → envelope verdict, the per-unit (per-rule) table is
  // added, and resolutionBanner → banners. These goldens are the NEW expected
  // output (regenerated under UPDATE_GOLDENS), not a byte-identity target.
  graphCase('graph-clean', GRAPH_CLEAN_ENVELOPE, { durationMs: 1200 }),
  graphCase('graph-findings', GRAPH_FINDINGS_ENVELOPE, {
    banner: GRAPH_RESOLUTION_BANNER,
    durationMs: 1200,
  }),
  graphCase('graph-verbose', GRAPH_FINDINGS_ENVELOPE, {
    verboseDetail: GRAPH_VERBOSE_DETAIL,
    banner: GRAPH_RESOLUTION_BANNER,
    durationMs: 50,
  }),
];
