import { emitAgentFilteredJsonOutput, EXIT_CODES } from '@opensip-cli/contracts';
import { createToolLogger, currentScope } from '@opensip-cli/core';

import { finalizeGraphSignals, type FinalizedSignals } from './apply-suppressions.js';
import { buildGraphEnvelope } from './build-envelope.js';
import { runCatalogJsonMode, runGateMode } from './graph-modes.js';
import { buildUnifiedReportLines, resolutionBannerText } from './graph-report.js';
import { buildGraphSessionContribution } from './graph-session-contribution.js';
import { GraphProfileBuilder, writeGraphProfile } from './profile.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { GraphRunOutcome } from './graph-run-outcome.js';
import type { RunGraphResult } from './orchestrate.js';
import type { RunPresentation, SignalEnvelope, VerboseDetail } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

const log = createToolLogger('graph:cli');

const EVT_GRAPH_COMPLETE = 'graph.cli.graph.complete';
const MODULE_GRAPH_CLI = 'graph:cli';
const MODULE_GRAPH_RENDER = 'graph:render';

/** Profile bucket for the run shape: workspace fan-out, multi-path, or single graph. */
function profileMode(opts: GraphCommandOptions): string {
  if (opts.workspace === true) return 'workspace';
  if ((opts.paths?.length ?? 0) > 1) return 'multi-path';
  return 'graph';
}

/** Create a profile builder when `--profile-output` is set. */
export function createProfileBuilder(
  opts: GraphCommandOptions,
  startedAt: string,
): GraphProfileBuilder | undefined {
  if (typeof opts.profileOutput !== 'string' || opts.profileOutput.length === 0) {
    return undefined;
  }
  return new GraphProfileBuilder({
    cwd: opts.cwd,
    mode: profileMode(opts),
    resolutionMode: opts.resolution,
    startedAt,
  });
}

/** Write the timing profile when `--profile-output` was requested. */
export function writeProfileIfRequested(
  opts: GraphCommandOptions,
  profile: GraphProfileBuilder | undefined,
): void {
  if (profile === undefined) return;
  if (typeof opts.profileOutput !== 'string' || opts.profileOutput.length === 0) return;
  const outPath = writeGraphProfile(opts.profileOutput, opts.cwd, profile.complete());
  log.info({
    evt: 'graph.profile.write.complete',
    module: MODULE_GRAPH_CLI,
    output: outPath,
  });
}

/**
 * Assemble the run's {@link SignalEnvelope} from its raw engine signals
 * (ADR-0011). Centralises `runId`/`createdAt` resolution off the live scope so
 * cloud egress correlates with the run id the logger stamps; the envelope is
 * pure (the clock read happens here, once).
 */
function envelopeFor(
  opts: GraphCommandOptions,
  result: RunGraphResult,
  durationMs: number,
): SignalEnvelope {
  return buildGraphEnvelope({
    signals: result.signals,
    recipe: opts.recipe,
    runId: currentScope()?.runId ?? '',
    createdAt: new Date().toISOString(),
    durationMs,
    resolutionMode: result.catalog?.resolutionMode,
  });
}

/**
 * Dispatch a completed graph run to its output mode and return the run outcome
 * for signal delivery and session persistence (undefined for plain `--json`).
 */
export async function dispatchGraphResult(
  opts: GraphCommandOptions,
  rawResult: RunGraphResult,
  cli: ToolCliContext,
  startedAt: string,
  suppressionRoot: string,
): Promise<GraphRunOutcome | undefined> {
  // ADR-0014: apply the inline graph-ignore waivers BEFORE any mode consumes
  // the signals — the gate baseline, catalog, render, and session persistence
  // all see the post-waiver set. `--workspace` is covered transitively: each
  // child runs `graph --json` through this function, so the parent aggregates
  // already-waived signals.
  //
  // `suppressionRoot` is the build root the signals' `code.file` paths are
  // RELATIVE TO — i.e. the positional subtree / sharded-child / workspace-unit
  // root, NOT necessarily `opts.cwd`. A `graph <subdir>` run (and every
  // `--workspace` child, which runs `graph <unitRoot> --json`) builds against
  // `runCwd = positionalPaths[0]`, so its signal paths and directive files
  // resolve under that root. Resolving against `opts.cwd` instead made every
  // `@graph-ignore` directive file unreadable (ENOENT), silently leaking the
  // waiver — the bug this parameter closes.
  // Route through the SINGLE suppression chokepoint (finalizeGraphSignals) — the
  // same seam the live/worker producers cross via buildLiveGraphOutput. The
  // branded FinalizedSignals it returns is the only signal shape the
  // session-contribution builder (and, transitively, the verdict + render) will
  // accept, so a future fourth output path cannot deliver un-waived signals: the
  // compiler rejects it.
  const finalized = await finalizeGraphSignals(rawResult.signals, suppressionRoot);
  return deliverGraphResult(
    opts,
    { ...rawResult, signals: finalized.signals },
    cli,
    startedAt,
    finalized,
  );
}

/**
 * Deliver an already-waived run to its output mode (gate / catalog-json /
 * render) and, on the human-facing render path, BUILD the generic-session
 * contribution the host run plane persists (host-owned-run-timing Phase 3 —
 * graph never writes the row itself). Split out of {@link dispatchGraphResult}
 * so the multi-path path — which must waive each path's signals against ITS
 * OWN root before aggregating (the roots differ) — can aggregate the kept
 * signals and deliver once, without a second (wrong-root) suppression pass.
 *
 * The contribution is built HERE, where the branded {@link FinalizedSignals}
 * is in scope, so the dashboard history can only ever carry post-waiver
 * findings (the branding guard is not lost across the return boundary).
 */
export async function deliverGraphResult(
  opts: GraphCommandOptions,
  result: RunGraphResult,
  cli: ToolCliContext,
  startedAt: string,
  finalized: FinalizedSignals,
): Promise<GraphRunOutcome | undefined> {
  const suppressedCount = finalized.suppressedCount;
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  if (opts.gateSave === true || opts.gateCompare === true) {
    // ADR-0036: the envelope arrives fingerprint-stamped — `buildGraphEnvelope`
    // passes graph's byte-preserved strategy into `buildSignalEnvelope`, which
    // stamps at construction (over the canonical remapped ruleIds, exactly what
    // the former post-hoc gate-path stamp produced). The host seams only read
    // `signal.fingerprint`. runGateMode owns the deliverSignals call
    // (host-derived exit), so the command-spec skips it.
    const envelope = envelopeFor(opts, result, durationMs);
    await runGateMode(opts, envelope, cli, result.catalog?.resolutionMode);
    log.info({
      evt: EVT_GRAPH_COMPLETE,
      module: MODULE_GRAPH_CLI,
      suppressed: suppressedCount,
    });
    return { envelope };
  }
  if (typeof opts.catalogOutput === 'string' && opts.catalogOutput.length > 0) {
    await runCatalogJsonMode(opts, result, cli, startedAt);
    log.info({
      evt: EVT_GRAPH_COMPLETE,
      module: MODULE_GRAPH_CLI,
      suppressed: suppressedCount,
    });
    return { envelope: envelopeFor(opts, result, durationMs) };
  }
  const envelope = await renderGraphResult(opts, result, startedAt, cli);
  // Session persistence is dashboard history — populated on human-facing runs
  // only. Skipped for:
  //   - `--json` (the machine-artifact mode AND the carrier each
  //     `executeWorkspaceGraph` child runs under — keeps "one human invocation
  //     = one session"; the --workspace parent persists the single aggregate);
  //   - `--report-to` (an export mode; like gate/catalog it opts out of session
  //     history — the root delivers the envelope to the receiver instead).
  // The host persists the returned `session` after the handler resolves; graph
  // builds it here from the BRANDED FinalizedSignals so the contribution can
  // only ever carry post-waiver findings regardless of which path reached here.
  const isReportTo = typeof opts.reportTo === 'string' && opts.reportTo.length > 0;
  const session =
    opts.json !== true && !isReportTo ? buildGraphSessionContribution(opts, finalized) : undefined;
  cli.setExitCode(EXIT_CODES.SUCCESS);
  log.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    signals: result.signals.length,
    suppressed: suppressedCount,
  });
  // Plain `--json` is the workspace-child carrier: it returns `undefined` so
  // the root does not cloud-emit per child (the parent owns the dashboard
  // aggregate, not per-unit signal batches — audit P1-2). Every other mode
  // (default render, `--report-to`) returns the outcome for root delivery; only
  // the non-export render path carries a `session`.
  return opts.json === true ? undefined : { envelope, ...(session ? { session } : {}) };
}

/**
 * Render the run and return its {@link SignalEnvelope} (ADR-0011).
 *
 * `--json` emits the envelope through the shared `formatSignalJson`
 * (`cli.emitEnvelope`). The default/`--verbose` path hands a {@link RunPresentation}
 * to the render seam (Ink on TTY, plain text in pipes/CI): the SAME `envelope`
 * already built here IS carried on the render object (envelope-first-presentation
 * plan, RP-2), so `presentationToView` derives the PASS/FAIL summary and verdict
 * from it — graph no longer carries a count-based `graph-done` summary. The
 * verbose catalog/findings/entry-point body rides as `verboseDetail`
 * ({kind:'lines'}, ADR-0021), and that verbose/detail surface also carries the
 * per-unit table; graph's fast-tier caveat moves to `RunPresentation.banners` (a
 * muted line above the summary); the non-verbose footer hints are emitted by the
 * shared seam. The host-stamped
 * `durationMs` (ADR-0051) is threaded as `RunPresentation.durationMs` so the
 * summary shows the real wall-clock — graph's envelope units carry `durationMs: 0`,
 * so without this thread `presentationToView`'s unit-sum default would render
 * `0ms`. The envelope is also RETURNED for the composition root's cloud +
 * `--report-to` delivery (egress, a separate plane — untouched here).
 */
async function renderGraphResult(
  opts: GraphCommandOptions,
  result: RunGraphResult,
  startedAt: string,
  cli: ToolCliContext,
): Promise<SignalEnvelope> {
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const envelope = envelopeFor(opts, result, durationMs);
  if (opts.json === true) {
    log.info({
      evt: 'graph.render.json.start',
      module: MODULE_GRAPH_RENDER,
    });
    emitAgentFilteredJsonOutput(cli, envelope, opts);
    log.info({
      evt: 'graph.render.json.complete',
      module: MODULE_GRAPH_RENDER,
    });
    return envelope;
  }
  log.info({
    evt: 'graph.render.presentation.start',
    module: MODULE_GRAPH_RENDER,
  });
  const verbose = opts.verbose === true;
  // ADR-0021: graph's verbose body is carried as VerboseDetail{kind:'lines'} and
  // rendered through the shared resultToView seam — the same path the live runner
  // uses — instead of a graph-only `reportLines`/`footerHints` shape. The
  // non-verbose footer hints are emitted by the seam (envelope-first-presentation
  // RP-2 → `presentationToView`).
  const verboseDetail: VerboseDetail | undefined = verbose
    ? {
        kind: 'lines',
        lines: buildUnifiedReportLines(
          {
            catalog: result.catalog,
            indexes: result.indexes,
            signals: result.signals,
            cacheHit: result.cacheHit,
          },
          { includeSummary: false },
        ),
      }
    : undefined;
  const resolutionBanner = resolutionBannerText(result.catalog?.resolutionMode);
  // envelope-first-presentation RP-2: route graph's static render through the
  // shared RunPresentation. The envelope IS carried (it drives the verdict and
  // optional verbose/detail table); `durationMs` is threaded so the host-owned
  // wall-clock wins over the unit-sum (graph units carry durationMs:0); the
  // resolution caveat moves to `banners`.
  const presentation: RunPresentation = {
    type: 'run-presentation',
    tool: 'graph',
    envelope,
    ...(verboseDetail === undefined ? {} : { verboseDetail }),
    ...(resolutionBanner === undefined ? {} : { banners: [resolutionBanner] }),
    durationMs,
  };
  await cli.render(presentation);
  log.info({
    evt: 'graph.render.presentation.complete',
    module: MODULE_GRAPH_RENDER,
  });
  return envelope;
}
