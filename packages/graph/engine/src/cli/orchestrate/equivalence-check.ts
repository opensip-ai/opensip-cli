/**
 * REAL-REPO equivalence guardrail — the dogfood gate that catches an
 * edge-resolution regression on a genuine multi-package TypeScript monorepo.
 *
 * WHY THIS EXISTS (the gap it closes):
 *   The in-test equivalence gate (`__tests__/equivalence*.test.ts`) builds BOTH
 *   engines through a SYNTHETIC text adapter that reuses the production
 *   cross-package helpers (`resolveSpecifierToPackage` + `buildExportIndex`), so
 *   the two engines "agree by construction" — it structurally CANNOT model the
 *   real TypeScript `dist/*.d.ts` resolution where the
 *   exact-engine-under-resolution bug actually lived. That is false confidence.
 *
 *   This guardrail instead builds BOTH catalogs on a REAL repo (default: this
 *   one) with the REAL TypeScript adapter — so workspace `@scope/pkg` imports
 *   resolve through Node16 to built `dist/*.d.ts`, exactly the divergence class
 *   the bug occupied. It then diffs (exact ≡ sharded) via `diffCatalogs` and
 *   classifies the residual by OWNER FILE:
 *
 *     - functionsOnly{A,B} MUST be 0 (the function sets are byte-equal
 *       post-reconciliation) — any non-zero is a hard FAILURE.
 *     - TEST/FIXTURE-owned edge divergences are benign (the graph rules skip
 *       test files, so they are gate-invisible) — counted separately, never
 *       gated.
 *     - PRODUCTION edge divergences are the meaningful signal, classified by
 *       DIRECTION on the unified model (ADR-0033): phantom (sharded-only),
 *       decline (exact-only), conflict (both resolve to different targets). Each
 *       direction is compared against its COMMITTED FLOOR; the guardrail FAILS
 *       when any direction EXCEEDS its floor (a NEW divergence on the unified
 *       model) and PASSES (with a tighten hint) on a decrease. Per-direction
 *       gating so a fixed conflict can't mask a new phantom. A ratchet, mirroring
 *       the repo's net-new SARIF philosophy. (The both-engine-DECLINE blind spot
 *       this differential cannot see is guarded by the pinned-corpus completeness
 *       floor in `resolution-completeness-floor.test.ts`.)
 *
 * Engine-layer + language-agnostic: it drives `runGraph` (exact) and
 * `runShardedGraph` (sharded) through the same shard-resolution the production
 * `graph` command uses (`resolveShardsForCwd`), so there is ONE resolver, never
 * a drifting copy. Cold + no-cache on both sides (a fresh oracle every run).
 */

import { diffCatalogs } from './cross-shard-resolve.js';

import type { EdgeDifference } from './cross-shard-resolve.js';
import type { Shard } from './shard-model.js';
import type { Catalog, ResolutionMode } from '../../types.js';

/** A function-set divergence: one engine discovered a function the other did not. */
export type FunctionSetBreach = readonly string[];

/**
 * Owner-file classification of an edge divergence. Matches the paths the graph
 * rules skip (so the divergence is gate-invisible): any `__tests__/` or
 * `__fixtures__/` tree segment, or a `*.test.*` / `*.spec.*` filename. Operates
 * on project-relative catalog `filePath`s, posix-normalized.
 */
export function isTestOrFixturePath(filePath: string): boolean {
  const p = filePath.replaceAll('\\', '/');
  return (
    p.includes('/__tests__/') ||
    p.startsWith('__tests__/') ||
    p.includes('/__fixtures__/') ||
    p.startsWith('__fixtures__/') ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[A-Za-z0-9]+$/.test(p)
  );
}

/**
 * A RESOLVED-edge divergence is the meaningful signal: a call site where the two
 * engines disagree on a NON-EMPTY resolved target set (one resolved it, the
 * other didn't, or they resolved it differently). A call site that is UNRESOLVED
 * (`to: []`) on one side and simply absent on the other contributes nothing to
 * the resolved call graph — both engines agree there is no target — so it is
 * NOT a resolved divergence (it is reported separately as a structural/
 * unresolved divergence, not gated). This is what isolates the dropped/added
 * REAL cross-package edges the guardrail exists to catch.
 */
function isResolvedDivergence(d: EdgeDifference): boolean {
  return d.toA !== d.toB && (d.toA.length > 0 || d.toB.length > 0);
}

/**
 * The DIRECTION of a resolved-edge divergence — which engine resolved the site,
 * once both engines run ONE model (Phase 3 convergence, ADR-0033). Direction no
 * longer encodes "wrongness" (neither engine is the oracle: a sharded-only edge
 * is frequently a REAL edge the single-program type checker under-resolved, e.g.
 * `scope.graph?.rules.getAll()` through an optional chain). It is a DIAGNOSTIC
 * label — "which bound is insufficient" — and each direction is ratcheted to its
 * measured floor so any NEW divergence on the unified model fails, with a
 * documented residual class per direction.
 *
 *   - `phantom`  — sharded resolved, exact declined  (exact-only gap)
 *   - `decline`  — exact resolved, sharded declined  (sharded-only gap)
 *   - `conflict` — BOTH resolved, to DIFFERENT targets (a real disambiguation
 *                  bug: at least one engine picked the wrong same-name occurrence)
 *
 * `conflict` is the load-bearing class — both engines confidently disagree, so
 * one is provably wrong. `phantom`/`decline` are one-sided gaps where the other
 * engine simply has more/less reach.
 */
export type DivergenceDirection = 'phantom' | 'decline' | 'conflict';

/** Classify a resolved divergence by which engine(s) resolved it. */
export function divergenceDirection(d: EdgeDifference): DivergenceDirection {
  if (d.toA.length === 0) return 'phantom'; // exact empty, sharded resolved
  if (d.toB.length === 0) return 'decline'; // sharded empty, exact resolved
  return 'conflict'; // both resolved, different targets
}

/**
 * A committed budget: the per-direction ratchet floors for production resolved-
 * edge divergences on the unified model (ADR-0033). Replaces the single
 * `productionResolvedEdgeDivergences` total: after convergence, a flat total can
 * hide a direction flip (a fixed conflict masking a new phantom). Each direction
 * is gated independently; any count EXCEEDING its floor FAILS, a decrease passes
 * with a tighten hint, equal passes.
 */
export interface EquivalenceBudget {
  /** Accepted sharded-only (exact-declined) production divergences. */
  readonly phantomDivergences: number;
  /** Accepted exact-only (sharded-declined) production divergences. */
  readonly declineDivergences: number;
  /** Accepted both-resolved-differently production divergences (the same-name
   *  disambiguation class — a real bug, tracked for follow-up). */
  readonly conflictDivergences: number;
  /**
   * Accepted SCC membership divergences. SCCs are a DOWNSTREAM consequence of the
   * resolved-edge residual (a differing cross-package edge can reshape a
   * component), so on a repo with a non-zero edge residual SCC differences are
   * expected and budgeted, not hard-failed. Same ratchet semantics.
   */
  readonly sccDivergences: number;
  /**
   * Optional human note recorded alongside the numbers (what each residual class
   * is). Ignored by the comparison.
   */
  readonly note?: string;
}

/** The classified outcome of one equivalence run. */
export interface EquivalenceReport {
  /** functionsOnlyInA (exact-only) — MUST be empty (a hard failure if not). */
  readonly functionsOnlyInExact: FunctionSetBreach;
  /** functionsOnlyInB (sharded-only) — MUST be empty (a hard failure if not). */
  readonly functionsOnlyInSharded: FunctionSetBreach;
  /** SCC membership divergences (budgeted — a downstream consequence of edges). */
  readonly sccDifferences: readonly string[];
  /** Every differing edge key, owner-attributed (resolved + structural). */
  readonly allEdgeDifferences: readonly EdgeDifference[];
  /**
   * RESOLVED-edge divergences owned by a PRODUCTION file — the gated signal
   * (dropped/added real edges in non-test code). The directional partitions
   * below sum to this.
   */
  readonly productionResolvedDifferences: readonly EdgeDifference[];
  /** Production divergences where SHARDED resolved but EXACT declined. */
  readonly productionPhantom: readonly EdgeDifference[];
  /** Production divergences where EXACT resolved but SHARDED declined. */
  readonly productionDecline: readonly EdgeDifference[];
  /** Production divergences where BOTH resolved, to DIFFERENT targets. */
  readonly productionConflict: readonly EdgeDifference[];
  /**
   * RESOLVED-edge divergences owned by a TEST/FIXTURE file — benign
   * (gate-invisible: the graph rules skip test files). Reported, not gated.
   */
  readonly testResolvedDifferences: readonly EdgeDifference[];
  /**
   * STRUCTURAL divergences — a call site recorded as UNRESOLVED (`to: []`) on one
   * engine and absent on the other. Neither resolved a target, so this does not
   * change the resolved call graph; reported for transparency, never gated.
   */
  readonly structuralDifferences: readonly EdgeDifference[];
  /** Catalog function counts, for the report header. */
  readonly exactFunctionCount: number;
  readonly shardedFunctionCount: number;
}

/** Build the exact + sharded catalogs on `cwd`, diff, and classify by owner file. */
export interface BuildEquivalenceInput {
  /** Target repo root (default: process.cwd()). */
  readonly cwd: string;
  /**
   * The resolved shard set for `cwd` (≥2 shards). Resolved by the caller via the
   * production `resolveShardsForCwd` so the guardrail shards the project the
   * SAME way a real `graph` run does. An empty/≤1 set is a usage error (the repo
   * must be shardable for the comparison to be meaningful).
   */
  readonly shards: readonly Shard[];
  /** CLI entry script for spawning shard workers (`process.argv[1]`). */
  readonly cliScript: string;
  /** Exact single-program build (the oracle). */
  readonly buildExact: (cwd: string) => Promise<Catalog | null>;
  /** Sharded build. */
  readonly buildSharded: (input: {
    shards: readonly Shard[];
    projectRoot: string;
    cliScript: string;
    resolutionMode: ResolutionMode;
  }) => Promise<Catalog>;
}

function functionCount(catalog: Catalog): number {
  let n = 0;
  for (const occs of Object.values(catalog.functions)) n += occs?.length ?? 0;
  return n;
}

/**
 * Run the real-repo equivalence comparison and classify the residual. Diffs as
 * `diffCatalogs(exact, sharded)` — so `functionsOnlyInA` is exact-only and
 * `functionsOnlyInB` is sharded-only — then partitions the edge differences by
 * owner file (production vs test/fixture).
 *
 * @throws {Error} If the exact (single-program) build produces no catalog — the
 *   target repo must contain analyzable source for the comparison to be meaningful.
 */
export async function buildEquivalenceReport(
  input: BuildEquivalenceInput,
): Promise<EquivalenceReport> {
  const exact = await input.buildExact(input.cwd);
  if (exact === null) {
    throw new Error(
      'Equivalence check: the exact (single-program) build produced no catalog ' +
        '(no parseable input). The target repo must contain analyzable source.',
    );
  }
  const sharded = await input.buildSharded({
    shards: input.shards,
    projectRoot: input.cwd,
    cliScript: input.cliScript,
    resolutionMode: 'exact',
  });

  const eq = diffCatalogs(exact, sharded);
  const resolved = eq.edgeDifferences.filter(isResolvedDivergence);
  const structuralDifferences = eq.edgeDifferences.filter((d) => !isResolvedDivergence(d));
  const productionResolvedDifferences = resolved.filter(
    (d) => !isTestOrFixturePath(d.ownerFilePath),
  );
  const testResolvedDifferences = resolved.filter((d) => isTestOrFixturePath(d.ownerFilePath));
  const byDirection = (dir: DivergenceDirection): readonly EdgeDifference[] =>
    productionResolvedDifferences.filter((d) => divergenceDirection(d) === dir);
  return {
    functionsOnlyInExact: eq.functionsOnlyInA,
    functionsOnlyInSharded: eq.functionsOnlyInB,
    sccDifferences: eq.sccDifferences,
    allEdgeDifferences: eq.edgeDifferences,
    productionResolvedDifferences,
    productionPhantom: byDirection('phantom'),
    productionDecline: byDirection('decline'),
    productionConflict: byDirection('conflict'),
    testResolvedDifferences,
    structuralDifferences,
    exactFunctionCount: functionCount(exact),
    shardedFunctionCount: functionCount(sharded),
  };
}

/**
 * Resolved CROSS-PACKAGE edge count in a catalog — the completeness metric for
 * the pinned-corpus floor (ADR-0033). A `crossShard` edge with a non-empty
 * target set is a recovered cross-package call; declined boundary calls are
 * PRUNED from the catalog (they leave only the intra placeholder), so this count
 * IS the resolved numerator. On a PINNED corpus (fixed call-site denominator) a
 * non-decreasing count is equivalent to a non-decreasing resolution RATE — it
 * catches a both-engine completeness regression (one that drops edges in BOTH
 * engines, so the differential gate above stays silent).
 */
export function countResolvedCrossPackageEdges(catalog: Catalog): number {
  let n = 0;
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs ?? []) {
      for (const e of o.calls) {
        if (e.crossShard === true && e.to.length > 0) n++;
      }
    }
  }
  return n;
}

/** The verdict of comparing a report against a budget. */
export interface EquivalenceVerdict {
  /** True ⇒ the guardrail FAILS (non-zero exit). */
  readonly failed: boolean;
  /** True ⇒ a function-set breach (a hard failure regardless of budget). */
  readonly functionSetBreached: boolean;
  /** Observed sharded-only (exact-declined) production divergence count. */
  readonly phantomCount: number;
  /** Observed exact-only (sharded-declined) production divergence count. */
  readonly declineCount: number;
  /** Observed both-resolved-differently production divergence count. */
  readonly conflictCount: number;
  /** Total observed production resolved-edge divergence count (sum of the three). */
  readonly productionCount: number;
  /** Observed SCC divergence count. */
  readonly sccCount: number;
  /** The budget's accepted SCC count. */
  readonly sccBudget: number;
  /** Human-readable lines for the CLI output (always populated). */
  readonly lines: readonly string[];
}

/**
 * Compare a report against the committed budget and produce the gate verdict +
 * human-readable lines. After Phase 3 convergence (ADR-0033) the gate is the
 * DIRECTIONAL soundness invariant: any NEW divergence on the unified model fails,
 * each direction ratcheted to its measured floor.
 *
 *   - Any function-set breach (functionsOnly{Exact,Sharded}) ⇒ HARD FAIL: the
 *     function SET must be byte-equal post-reconciliation (a discovery/merge
 *     regression, never an edge gap).
 *   - phantom / decline / conflict production divergences each > their floor ⇒
 *     FAIL, printing the offending owner edges for the breached direction(s).
 *     Gating per-direction (not a flat total) so a fixed conflict can't mask a
 *     new phantom.
 *   - SCC divergences > budget ⇒ FAIL (a downstream consequence of the edge
 *     residual — budgeted, not hard-failed, since the real-repo residual is
 *     non-zero).
 *   - any metric < its floor ⇒ PASS, with a hint to tighten that number.
 *   - == floor ⇒ PASS.
 *
 * Structural (unresolved-vs-absent) divergences are reported but never gated.
 */
export function judgeEquivalence(
  report: EquivalenceReport,
  budget: EquivalenceBudget,
): EquivalenceVerdict {
  const lines: string[] = [];
  const phantomCount = report.productionPhantom.length;
  const declineCount = report.productionDecline.length;
  const conflictCount = report.productionConflict.length;
  const productionCount = report.productionResolvedDifferences.length;
  const sccCount = report.sccDifferences.length;
  const sccBudget = budget.sccDivergences;
  const functionSetBreached =
    report.functionsOnlyInExact.length > 0 || report.functionsOnlyInSharded.length > 0;

  lines.push(
    `Graph engine equivalence (exact ≡ sharded) on the real repo:`,
    `  functions: exact=${String(report.exactFunctionCount)} sharded=${String(report.shardedFunctionCount)}`,
    `  functionsOnlyInExact=${String(report.functionsOnlyInExact.length)} ` +
      `functionsOnlyInSharded=${String(report.functionsOnlyInSharded.length)}`,
    `  production resolved-edge divergences (total=${String(productionCount)}) by direction:`,
    `    phantom  (sharded-only): ${String(phantomCount)} (budget ${String(budget.phantomDivergences)})`,
    `    decline  (exact-only):   ${String(declineCount)} (budget ${String(budget.declineDivergences)})`,
    `    conflict (both differ):  ${String(conflictCount)} (budget ${String(budget.conflictDivergences)})`,
    `  test/fixture resolved divergences: ${String(report.testResolvedDifferences.length)} (benign)`,
    `  scc divergences: ${String(sccCount)} (budget ${String(sccBudget)})`,
    `  structural (unresolved-vs-absent) divergences: ${String(report.structuralDifferences.length)} (informational)`,
  );

  if (functionSetBreached) {
    lines.push(
      `  FAIL: function-set divergence — the two engines disagree on the FUNCTION SET.`,
      `        This MUST be 0 (a discovery/merge regression, not an edge gap).`,
    );
    appendSample(lines, 'exact-only function', report.functionsOnlyInExact);
    appendSample(lines, 'sharded-only function', report.functionsOnlyInSharded);
  }

  const directions = [
    {
      label: 'phantom (sharded-only)',
      key: 'phantomDivergences',
      count: phantomCount,
      budget: budget.phantomDivergences,
      diffs: report.productionPhantom,
    },
    {
      label: 'decline (exact-only)',
      key: 'declineDivergences',
      count: declineCount,
      budget: budget.declineDivergences,
      diffs: report.productionDecline,
    },
    {
      label: 'conflict (both differ)',
      key: 'conflictDivergences',
      count: conflictCount,
      budget: budget.conflictDivergences,
      diffs: report.productionConflict,
    },
  ] as const;
  let directionBreached = false;
  for (const d of directions) {
    judgeMetric(lines, {
      label: `${d.label} divergence`,
      key: d.key,
      count: d.count,
      budget: d.budget,
    });
    if (d.count > d.budget) {
      directionBreached = true;
      lines.push(`    NEW ${d.label} edges (owner file:line  exact=[..] sharded=[..]):`);
      for (const diff of d.diffs) {
        lines.push(
          `      ${diff.ownerFilePath}:${String(diff.line)}:${String(diff.column)}  ` +
            `exact=[${diff.toA}] sharded=[${diff.toB}]`,
        );
      }
    }
  }

  const sccOverBudget = sccCount > sccBudget;
  judgeMetric(lines, {
    label: 'SCC divergence',
    key: 'sccDivergences',
    count: sccCount,
    budget: sccBudget,
  });

  const failed = functionSetBreached || directionBreached || sccOverBudget;
  lines.push(failed ? `  RESULT: FAIL` : `  RESULT: PASS`);
  return {
    failed,
    functionSetBreached,
    phantomCount,
    declineCount,
    conflictCount,
    productionCount,
    sccCount,
    sccBudget,
    lines,
  };
}

/** Emit the PASS/FAIL/tighten line for one budgeted metric. */
function judgeMetric(
  lines: string[],
  m: { label: string; key: string; count: number; budget: number },
): void {
  if (m.count > m.budget) {
    lines.push(
      `  FAIL: ${m.label} ${String(m.count)} EXCEEDS budget ${String(m.budget)} (+${String(m.count - m.budget)}).`,
    );
  } else if (m.count < m.budget) {
    lines.push(
      `  PASS: ${m.label} ${String(m.count)} is BELOW budget ${String(m.budget)}; ` +
        `tighten the ratchet: set ${m.key}=${String(m.count)} in the budget JSON.`,
    );
  } else {
    lines.push(`  PASS: ${m.label} matches budget (${String(m.budget)}).`);
  }
}

/** Append up to 5 sample identities of a breach list (keeps output bounded). */
function appendSample(lines: string[], label: string, ids: readonly string[]): void {
  for (const id of ids.slice(0, 5)) lines.push(`    ${label}: ${id}`);
  if (ids.length > 5) lines.push(`    … and ${String(ids.length - 5)} more ${label}(s)`);
}
