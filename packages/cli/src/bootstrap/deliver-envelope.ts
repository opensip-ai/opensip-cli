// @fitness-ignore-file error-handling-quality -- best-effort cloud egress (ADR-0008): repo-identity detection and signal emission degrade silently (no git, network error). A cloud failure never blocks, slows, or fails the user's run.
/**
 * deliver-envelope — the composition root's signal-delivery step (ADR-0011,
 * Phase 3).
 *
 * After a tool returns its {@link SignalEnvelope}, the root — not the tool —
 * delivers it to the effectful sinks:
 *
 *   1. **Cloud sync (best-effort).** Map the envelope → `SignalBatch`
 *      (`@opensip-tools/core` `buildSignalBatch`, adding repo identity and
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
 * This is the seam that keeps tool engines free of `@opensip-tools/output`:
 * engines return envelopes, and the composition root owns formatting,
 * delivery, and report-upload exit-code policy.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { EXIT_CODES } from '@opensip-tools/contracts';
import { buildSignalBatch, currentScope, logger as defaultLogger } from '@opensip-tools/core';
import {
  formatSignalSarif,
  postChunked,
  resolveRepoIdentity,
  type EgressResult,
} from '@opensip-tools/output';

import type { SignalEnvelope } from '@opensip-tools/contracts';
import type { Logger, RepoIdentity, SignalBatch } from '@opensip-tools/core';

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

/** Outcome of an envelope delivery (for tests / callers that surface status). */
export interface DeliverEnvelopeResult {
  /** Signals the cloud sink acknowledged (0 for the no-op majority). */
  readonly cloudAccepted: number;
  /** Whether a `--report-to` upload was attempted and succeeded. */
  readonly reportSuccess?: boolean;
  /** The `--report-to` target URL, when one was requested. */
  readonly reportUrl?: string;
}

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

/** Best-effort cloud emit through the run's selected signal sink. Never throws. */
async function emitToCloud(
  envelope: SignalEnvelope,
  repo: RepoIdentity,
  log: Logger,
): Promise<number> {
  try {
    const sink = currentScope()?.signalSink;
    if (!sink) return 0;
    const batch = envelopeToSignalBatch(envelope, repo);
    const result = await sink.emit(batch);
    if (result.accepted > 0) {
      const noun = result.accepted === 1 ? 'signal' : 'signals';
      process.stderr.write(`✓ Sent ${result.accepted} ${noun} to OpenSIP Cloud\n`);
    }
    return result.accepted;
  } catch (error) {
    log.info({
      evt: 'cli.signal-egress.error',
      module: MODULE_TAG,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
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

  // ADR-0035: the host owns the findings exit code. For a normal run it is a pure
  // function of the run's single verdict — `envelope.verdict.passed` — so no tool
  // computes its own exit; gate-compare overrides with its baseline-diff verdict.
  // Set RUNTIME_ERROR first; the `--report-to` exit-4 below only applies when the
  // run otherwise passed, so a real failure always dominates (last-write-wins).
  const runFailed = opts.runFailed ?? !envelope.verdict.passed;
  if (runFailed) opts.setExitCode?.(EXIT_CODES.RUNTIME_ERROR);

  const cloudAccepted = await emitToCloud(envelope, repo, log);

  if (opts.reportTo === undefined || opts.reportTo.length === 0) {
    return { cloudAccepted };
  }

  const result = await reportSarif(envelope, opts.reportTo, opts.apiKey, opts.fetchImpl);
  const reportSuccess = result.outcome === 'ok';
  if (!reportSuccess) {
    process.stderr.write(
      `opensip-tools: --report-to failed (${opts.reportTo}): ` +
        `${result.errors.length > 0 ? result.errors.join('; ') : 'unknown error'}\n`,
    );
  }
  // Exit-code contract (ADR-0008): a report-upload failure exits 4 — but only
  // when the run otherwise passed; a real failure (`runFailed`, derived from the
  // verdict above) dominates.
  if (!reportSuccess && !runFailed) {
    opts.setExitCode?.(EXIT_CODES.REPORT_FAILED);
  }

  return { cloudAccepted, reportSuccess, reportUrl: opts.reportTo };
}

/**
 * Root-owned SARIF-**file** sink (ADR-0011): format the envelope to SARIF via
 * the single shared `formatSignalSarif` formatter and write the bytes to
 * `path`, creating parent directories as needed. This is the seam behind
 * `ToolCliContext.writeSarif` — a tool that exports SARIF to a file (e.g.
 * `graph sarif-export`) routes through it instead of importing
 * `@opensip-tools/output` itself. The formatter is pure; this function owns
 * the effect (fs write).
 */
export async function writeEnvelopeSarif(envelope: SignalEnvelope, path: string): Promise<void> {
  const sarif = formatSignalSarif(envelope);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sarif);
}
