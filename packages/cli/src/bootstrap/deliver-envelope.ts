// @fitness-ignore-file error-handling-quality -- best-effort cloud egress (ADR-0008): repo-identity detection and signal emission degrade silently (no git, network error). A cloud failure never blocks, slows, or fails the user's run.
/**
 * deliver-envelope — the composition root's signal-delivery step (ADR-0011,
 * Phase 3).
 *
 * After a tool returns its {@link SignalEnvelope}, the root — not the tool —
 * delivers it to the effectful sinks:
 *
 *   1. **Cloud sync (best-effort).** Map the envelope → `SignalBatch`
 *      (`@opensip-cli/core` `buildSignalBatch`, adding repo identity and
 *      preserving the envelope's `runId`/`createdAt`; dropping `verdict`/`units`
 *      — the cloud wire shape stays `schemaVersion: 1`) and emit it through the
 *      run's `scope.signalSink`. The sink is a no-op for the keyless / not-
 *      entitled majority. NEVER throws, NEVER affects the exit code (ADR-0008).
 *      Ships the envelope's signals as-is — **no SARIF detour** on this path.
 *
 *   2. **`--report-to` (owns exit code 4).** When `reportTo` is set, format the
 *      envelope to SARIF via the single shared `formatSignalSarif` formatter and
 *      POST it through the shared chunked transport (`postChunked`). An upload
 *      failure exits `EXIT_CODES.REPORT_FAILED` (4) — but only when the run
 *      otherwise passed; a real check/gate failure (`runFailed`) dominates and
 *      is never masked by a reporting failure (ADR-0008).
 *
 * This is the seam that keeps tool engines free of `@opensip-cli/output`:
 * engines return envelopes, and the composition root owns formatting,
 * delivery, and report-upload exit-code policy.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { EXIT_CODES } from '@opensip-cli/contracts';
import { buildSignalBatch, currentScope, logger as defaultLogger } from '@opensip-cli/core';
import {
  formatSignalSarif,
  postChunked,
  resolveRepoIdentity,
  type EgressResult,
} from '@opensip-cli/output';

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Logger, RepoIdentity, SignalBatch, SignalDeliveryResult } from '@opensip-cli/core';

const MODULE_TAG = 'cli:bootstrap';

/** Options the root supplies when delivering a tool's envelope. */
export interface DeliverEnvelopeOptions {
  /** Project / repo working directory — the repo-identity probe root. */
  readonly cwd: string;
  /** `--report-to <url>` target, when requested. */
  readonly reportTo?: string;
  /** Cloud API key for `--report-to` (read off the same flag as cloud sync). */
  readonly apiKey?: string;
  /**
   * Optional override for the findings-failure decision (ADR-0035). Normal runs
   * OMIT this — the host derives the findings exit from `envelope.verdict.passed`
   * (the single verdict). The gate-COMPARE modes pass their baseline-diff
   * predicate (`degraded`): "net-new findings since baseline" is NOT expressible
   * over the run's own verdict, so the host honours the override for that mode.
   */
  readonly runFailed?: boolean;
  /** Exit-code setter (the CLI's single write path). */
  readonly setExitCode?: (code: number) => void;
  /** Pre-resolved repo identity; resolved from `cwd` when omitted. */
  readonly repo?: RepoIdentity;
  readonly logger?: Logger;
  /** Injectable `fetch` for the `--report-to` upload (tests). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Outcome of an envelope delivery. The canonical shape is core's
 * {@link SignalDeliveryResult} (the `ToolCliContext.deliverSignals` return);
 * this alias keeps the historical local name for existing imports.
 */
export type DeliverEnvelopeResult = SignalDeliveryResult;

/**
 * Map a {@link SignalEnvelope} to the cloud {@link SignalBatch} wire shape:
 * add repo identity, preserve the run identity, drop `verdict`/`units`.
 */
export function envelopeToSignalBatch(envelope: SignalEnvelope, repo: RepoIdentity): SignalBatch {
  return buildSignalBatch({
    tool: envelope.tool,
    recipe: envelope.recipe,
    repo,
    signals: envelope.signals,
    runId: envelope.runId,
    createdAt: envelope.createdAt,
  });
}

/** Cloud-leg outcome: what shipped, and why nothing did when that is knowable. */
interface CloudEmitOutcome {
  readonly accepted: number;
  readonly skippedReason?: 'unentitled' | 'error';
}

/**
 * Best-effort cloud emit through the run's selected signal sink. Never throws.
 *
 * Best-effort ≠ silent: when the user CONFIGURED cloud sync (an active, non-noop
 * sink) and the run had signals to ship but none were accepted, a one-line
 * stderr notice says so — otherwise the user reasonably believes their signals
 * shipped. The keyless / opted-out majority (no sink or the no-op sink) stays
 * silent: there, nothing-shipped is exactly what they asked for. Exit code is
 * never affected (ADR-0008).
 */
async function emitToCloud(
  envelope: SignalEnvelope,
  repo: RepoIdentity,
  log: Logger,
): Promise<CloudEmitOutcome> {
  try {
    const sink = currentScope()?.signalSink;
    // Behavioral discriminator, not identity: ANY no-op sink (a host's own
    // included) means "the user asked for no delivery" → stay silent.
    if (!sink || sink.noop === true) return { accepted: 0 };
    const batch = envelopeToSignalBatch(envelope, repo);
    const result = await sink.emit(batch);
    if (result.accepted > 0) {
      const noun = result.accepted === 1 ? 'signal' : 'signals';
      process.stderr.write(`✓ Sent ${result.accepted} ${noun} to OpenSIP Cloud\n`);
      return { accepted: result.accepted };
    }
    if (batch.signals.length === 0) return { accepted: 0 };
    const skippedReason = result.skippedReason ?? 'error';
    // Only surface a human stderr notice for transient upload errors.
    // "unentitled" is a steady-state property of the key/plan (configure already
    // warned the user, and local results are always unaffected per ADR-0008).
    // The Deliver result still carries cloudSkippedReason for hosts/observability.
    if (skippedReason === 'error') {
      process.stderr.write(
        `opensip: cloud sync skipped — the upload failed (see the run log); ` +
          `${batch.signals.length} signal(s) were NOT uploaded. ` +
          `Local results are unaffected (silence this with --no-cloud).\n`,
      );
    }
    return { accepted: 0, skippedReason };
  } catch (error) {
    log.warn({
      evt: 'cli.signal-egress.error',
      module: MODULE_TAG,
      error: error instanceof Error ? error.message : String(error),
    });
    return { accepted: 0, skippedReason: 'error' };
  }
}

/** POST the envelope's SARIF to a `--report-to` receiver via the chunked transport. */
async function reportSarif(
  envelope: SignalEnvelope,
  url: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<EgressResult> {
  const sarif = formatSignalSarif(envelope);
  // The receiver accepts a SARIF body at `<url>/sarif`; one chunk (the whole
  // SARIF log) — the envelope is already capped upstream.
  const target = url.endsWith('/sarif') ? url : `${url}/sarif`;
  return postChunked({
    url: target,
    apiKey,
    chunks: [JSON.parse(sarif) as unknown],
    idempotencyKeyFor: (i) => `${envelope.runId}:report:${i}`,
    timeoutFor: () => Math.min(300_000, 60_000 + envelope.signals.length * 100),
    policy: { maxAttempts: 3, overallDeadlineMs: 300_000, honorRetryAfter: true },
    evtPrefix: 'cli.report',
    fetchImpl,
  });
}

/**
 * The root's post-run signal-delivery step. Emits the envelope to the cloud
 * sink (best-effort) and, when `--report-to` is set, uploads its SARIF
 * (owning exit code 4). Never throws.
 */
export async function deliverEnvelope(
  envelope: SignalEnvelope,
  opts: DeliverEnvelopeOptions,
): Promise<DeliverEnvelopeResult> {
  const log = opts.logger ?? defaultLogger;
  const repo = opts.repo ?? resolveRepoIdentity(opts.cwd);

  // Record delivery start on the scope diagnostics (if any) so the 'deliver' phase
  // of the uniform lifecycle is visible in CommandOutcome for --json consumers.
  // This improves observability of the root-owned egress path (architecture review).
  currentScope()?.diagnostics.event('deliver', 'debug', `deliver start for ${envelope.tool}`, {
    tool: envelope.tool,
    recipe: envelope.recipe,
    signalCount: envelope.signals.length,
    reportTo: !!opts.reportTo,
  });

  // ADR-0035: the host owns the findings exit code. For a normal run it is a pure
  // function of the run's single verdict — `envelope.verdict.passed` — so no tool
  // computes its own exit; gate-compare overrides with its baseline-diff verdict.
  // Set RUNTIME_ERROR first; the `--report-to` exit-4 below only applies when the
  // run otherwise passed, so a real failure always dominates (last-write-wins).
  const runFailed = opts.runFailed ?? !envelope.verdict.passed;
  if (runFailed) opts.setExitCode?.(EXIT_CODES.RUNTIME_ERROR);

  const cloud = await emitToCloud(envelope, repo, log);
  const cloudAccepted = cloud.accepted;
  const cloudLeg = {
    cloudAccepted,
    ...(cloud.skippedReason === undefined ? {} : { cloudSkippedReason: cloud.skippedReason }),
  };

  const cloudSuffix = cloud.skippedReason ? ` (skipped:${cloud.skippedReason})` : '';
  currentScope()?.diagnostics.event(
    'deliver',
    'debug',
    `cloud egress: accepted=${cloudAccepted}${cloudSuffix}`,
  );

  if (opts.reportTo === undefined || opts.reportTo.length === 0) {
    return cloudLeg;
  }

  const result = await reportSarif(envelope, opts.reportTo, opts.apiKey, opts.fetchImpl);
  const reportSuccess = result.outcome === 'ok';
  if (!reportSuccess) {
    process.stderr.write(
      `opensip: --report-to failed (${opts.reportTo}): ` +
        `${result.errors.length > 0 ? result.errors.join('; ') : 'unknown error'}\n`,
    );
  }
  // Exit-code contract (ADR-0008): a report-upload failure exits 4 — but only
  // when the run otherwise passed; a real failure (`runFailed`, derived from the
  // verdict above) dominates.
  if (!reportSuccess && !runFailed) {
    opts.setExitCode?.(EXIT_CODES.REPORT_FAILED);
  }

  currentScope()?.diagnostics.event(
    'deliver',
    reportSuccess ? 'info' : 'warn',
    `report-to ${reportSuccess ? 'succeeded' : 'failed'}`,
    {
      url: opts.reportTo,
      success: reportSuccess,
    },
  );

  return { ...cloudLeg, reportSuccess, reportUrl: opts.reportTo };
}

/**
 * Root-owned SARIF-**file** sink (ADR-0011): format the envelope to SARIF via
 * the single shared `formatSignalSarif` formatter and write the bytes to
 * `path`, creating parent directories as needed. This is the seam behind
 * `ToolCliContext.writeSarif` — a tool that exports SARIF to a file (e.g.
 * `graph sarif-export`) routes through it instead of importing
 * `@opensip-cli/output` itself. The formatter is pure; this function owns
 * the effect (fs write).
 */
export async function writeEnvelopeSarif(envelope: SignalEnvelope, path: string): Promise<void> {
  const sarif = formatSignalSarif(envelope);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sarif);
}
