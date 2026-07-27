import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { buildSignalEnvelope, groupSignalsBySource } from '@opensip-cli/contracts';
import {
  createCancelledError,
  createDeadlineError,
  createToolError,
  currentScope,
  filterSignalsBySuppressions,
  isErrorSignal,
  normalizeFailure,
  NotFoundError,
  runWithTimeout,
  scheduleUnits,
  toPublicFailureProjection,
  yieldToEventLoop,
} from '@opensip-cli/core';

import { yagniFingerprintStrategy } from '../baseline-strategy.js';
import { YAGNI_DETECTORS } from '../detectors/registry.js';
import { yagniErrorCatalog } from '../errors/yagni-error-catalog.js';
import { YAGNI_LAYOUT_KEY } from '../identity.js';
import { applyTargetConventionConfidence } from '../lib/target-conventions.js';
import { buildYagniSessionPayload } from '../persistence/session-payload.js';
import {
  buildYagniRunSummary,
  filterByMinConfidence,
  filterByReductionCategories,
  sortYagniSignals,
} from '../scoring/confidence.js';

import type { SkippedDetector, YagniDetector } from '../detectors/types.js';
import type { YagniConfig } from '../types/yagni-config.js';
import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

/** Runtime options for one YAGNI detector pass. */
export interface ExecuteYagniOptions {
  readonly cwd: string;
  readonly config?: YagniConfig;
  readonly minConfidence?: YagniConfidence;
  readonly detectors?: readonly string[];
  readonly categories?: readonly string[];
  readonly includeTests?: boolean;
  readonly pathRoots?: readonly string[];
  /** Aggregate count progress (pool-shape live view). */
  readonly onProgress?: (completed: number, total: number) => void;
  /** Per-detector lifecycle, for a phases-shape live view that names each detector. */
  readonly onDetectorStart?: (slug: string) => void;
  readonly onDetectorDone?: (slug: string, durationMs: number) => void;
  /** The detectors `planDetectors` excluded (filtered out or disabled), emitted once. */
  readonly onDetectorsSkipped?: (slugs: readonly string[]) => void;
}

/** Envelope plus session payload returned to the host command runner. */
export interface ExecuteYagniResult {
  readonly envelope: SignalEnvelope;
  readonly session: {
    readonly tool: 'yagni';
    readonly cwd: string;
    readonly score: number;
    readonly passed: boolean;
    readonly payload: ReturnType<typeof buildYagniSessionPayload>;
  };
}

const YAGNI_SUPPRESSION_KEYWORDS = {
  file: '@yagni-ignore-file',
  nextLine: '@yagni-ignore-next-line',
} as const;

const DETECTOR_TIMEOUT_MS = 30_000;
const DETECTOR_FAILED = yagniErrorCatalog.require('YAGNI.DETECTOR.EXECUTION_FAILED');

function publicFailureMessage(error: unknown, detector: string): string {
  const initial = normalizeFailure(error);
  const failure =
    initial.known === 'known'
      ? initial
      : normalizeFailure(
          createToolError(DETECTOR_FAILED, `YAGNI detector '${detector}' failed.`, {
            ...(error instanceof Error ? { cause: error } : {}),
            metadata: { detector },
          }),
        );
  const message = toPublicFailureProjection(failure).message;
  return typeof message === 'string' ? message : 'The detector failed.';
}

function isDisabled(detector: YagniDetector, config: YagniConfig): boolean {
  const disabled = config.disabledDetectors ?? [];
  return disabled.includes(detector.id) || disabled.includes(detector.slug);
}

function matchesDetectorFilter(detector: YagniDetector, filter: readonly string[]): boolean {
  if (filter.length === 0) return true;
  return filter.some(
    (slug) =>
      slug === detector.id ||
      slug === detector.slug ||
      slug === detector.slug.replace(/^yagni:/, ''),
  );
}

function validateDetectorFilter(
  detectors: readonly YagniDetector[],
  detectorFilter: readonly string[],
): void {
  const unknown = detectorFilter.find(
    (requested) => !detectors.some((detector) => matchesDetectorFilter(detector, [requested])),
  );
  if (unknown !== undefined) {
    throw new NotFoundError(`Unknown YAGNI detector '${unknown}'.`, {
      code: 'YAGNI.DETECTOR.NOT_FOUND',
      definition: yagniErrorCatalog.require('YAGNI.DETECTOR.NOT_FOUND'),
      metadata: { detector: unknown },
    });
  }
}

function planDetectors(
  detectors: readonly YagniDetector[],
  config: YagniConfig,
  detectorFilter: readonly string[],
): {
  readonly run: readonly YagniDetector[];
  readonly skipped: readonly SkippedDetector[];
  readonly notRunSlugs: readonly string[];
} {
  const run: YagniDetector[] = [];
  const skipped: SkippedDetector[] = [];
  const notRunSlugs: string[] = [];

  for (const detector of detectors) {
    if (!matchesDetectorFilter(detector, detectorFilter)) {
      notRunSlugs.push(detector.slug);
      continue;
    }
    if (isDisabled(detector, config)) {
      skipped.push({
        id: detector.id,
        slug: detector.slug,
        reason: 'disabled',
      });
      notRunSlugs.push(detector.slug);
      continue;
    }
    run.push(detector);
  }

  return { run, skipped, notRunSlugs };
}

function yagniDirectiveId(signal: Signal): string {
  return signal.ruleId.startsWith('yagni:') ? signal.ruleId.slice('yagni:'.length) : signal.ruleId;
}

function sourcePath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(cwd, filePath);
}

async function filterYagniSuppressions(
  cwd: string,
  signals: readonly Signal[],
): Promise<{
  readonly kept: readonly Signal[];
  readonly suppressed: readonly Signal[];
}> {
  const { kept, suppressed } = await filterSignalsBySuppressions({
    signals,
    keywords: YAGNI_SUPPRESSION_KEYWORDS,
    readFile: (filePath) => readFile(sourcePath(cwd, filePath), 'utf8'),
    ruleIdOf: yagniDirectiveId,
  });
  return {
    kept,
    suppressed: suppressed.map((match) => match.signal),
  };
}

function suppressionAdjustedUnits(
  units: readonly UnitResult[],
  keptSignals: readonly Signal[],
  suppressedSignals: readonly Signal[],
): readonly UnitResult[] {
  const keptBySource = groupSignalsBySource(keptSignals);
  const suppressedBySource = groupSignalsBySource(suppressedSignals);
  return units.map((unit) => {
    const signals = keptBySource.get(unit.slug) ?? [];
    const ignoredCount = suppressedBySource.get(unit.slug)?.length ?? 0;
    return {
      ...unit,
      passed: unit.error === undefined && signals.every((s) => !isErrorSignal(s)),
      violationCount: signals.length,
      ...(ignoredCount === 0 ? {} : { ignoredCount }),
    };
  });
}

/**
 * Run the selected YAGNI detectors and build the persisted signal envelope.
 *
 * Detector execution receives analysis inputs only. Host output/gate/delivery/
 * session behavior stays at the command/runner boundaries (documented
 * ToolCliContext seams); this executor returns the completion/contribution.
 *
 * @throws {NotFoundError} When an explicit detector selector is unknown.
 * @throws {Error} When host cancellation interrupts detector execution.
 */
export async function executeYagni(
  opts: ExecuteYagniOptions,
  detectors: readonly YagniDetector[] = YAGNI_DETECTORS,
): Promise<ExecuteYagniResult> {
  const config = opts.config ?? {};
  const includeTests = opts.includeTests ?? config.includeTests ?? false;
  const minConfidence = opts.minConfidence ?? config.defaultMinConfidence ?? 'medium';

  validateDetectorFilter(detectors, opts.detectors ?? []);
  const { run, skipped, notRunSlugs } = planDetectors(detectors, config, opts.detectors ?? []);
  const allSignals: Signal[] = [];
  const units: UnitResult[] = [];
  const total = run.length;
  opts.onProgress?.(0, total);
  if (notRunSlugs.length > 0) opts.onDetectorsSkipped?.(notRunSlugs);

  let completed = 0;
  await scheduleUnits<YagniDetector>({
    units: run,
    mode: 'sequential',
    maxParallel: 1,
    yieldBetweenUnits: true,
    /** @throws {Error} When host cancellation interrupts this detector. */
    runUnit: async (detector) => {
      const started = Date.now();
      let reportedDurationMs: number | undefined;
      opts.onDetectorStart?.(detector.slug);
      // Give both the live renderer and the host interrupt coordinator a
      // macrotask before a CPU-heavy synchronous detector starts.
      if (opts.onDetectorStart) await yieldToEventLoop();
      try {
        const outcome = await runWithTimeout({
          run: () =>
            detector.run({
              cwd: opts.cwd,
              config,
              includeTests,
              ...(opts.pathRoots === undefined ? {} : { pathRoots: opts.pathRoots }),
            }),
          timeoutMs: DETECTOR_TIMEOUT_MS,
        });

        if (outcome.status === 'ok') {
          reportedDurationMs = outcome.result.durationMs || outcome.durationMs;
          const conventionAdjusted = applyTargetConventionConfidence(
            outcome.result.signals,
            opts.cwd,
          );
          const filtered = filterByMinConfidence(conventionAdjusted, minConfidence);
          allSignals.push(...filtered);
          const violationCount = filtered.length;
          units.push({
            slug: detector.slug,
            passed: violationCount === 0 || filtered.every((s) => !isErrorSignal(s)),
            violationCount,
            durationMs: reportedDurationMs,
          });
        } else {
          if (
            outcome.status === 'error' &&
            normalizeFailure(outcome.error).definition.kind === 'cancelled'
          ) {
            throw outcome.error;
          }
          reportedDurationMs = outcome.durationMs;
          const error =
            outcome.status === 'timeout'
              ? createDeadlineError(
                  `YAGNI detector '${detector.slug}' exceeded its ${String(DETECTOR_TIMEOUT_MS)}ms deadline.`,
                )
              : outcome.error;
          units.push({
            slug: detector.slug,
            passed: false,
            durationMs: reportedDurationMs,
            error: publicFailureMessage(error, detector.slug),
          });
        }
      } catch (error) {
        if (normalizeFailure(error).definition.kind === 'cancelled') throw error;
        reportedDurationMs ??= Date.now() - started;
        units.push({
          slug: detector.slug,
          passed: false,
          durationMs: reportedDurationMs,
          error: publicFailureMessage(error, detector.slug),
        });
      } finally {
        reportedDurationMs ??= Date.now() - started;
        opts.onDetectorDone?.(detector.slug, reportedDurationMs);
        completed += 1;
        opts.onProgress?.(completed, total);
      }
      return { shouldStop: false };
    },
  });

  const hostSignal = currentScope()?.abortSignal;
  if (hostSignal?.aborted === true) {
    const reason = hostSignal.reason as unknown;
    if (normalizeFailure(reason).definition.kind === 'cancelled') throw reason;
    throw createCancelledError('YAGNI detector execution was cancelled.');
  }

  const categoryFiltered = filterByReductionCategories(allSignals, opts.categories ?? []);
  const { kept, suppressed } = await filterYagniSuppressions(opts.cwd, categoryFiltered);
  const sortedSignals = sortYagniSignals(kept);
  const finalUnits = suppressionAdjustedUnits(units, sortedSignals, suppressed);

  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const policy = {
    failOnErrors: config.failOnErrors ?? 0,
    failOnWarnings: config.failOnWarnings ?? 0,
  };
  const envelope = buildSignalEnvelope({
    tool: 'yagni',
    runId,
    createdAt,
    units: finalUnits,
    signals: sortedSignals,
    policy,
    runFaulted: finalUnits.some((u) => u.error !== undefined),
    fingerprintStrategy: yagniFingerprintStrategy,
  });

  const yagniSummary = buildYagniRunSummary(envelope.signals, skipped);
  const sessionPayload = buildYagniSessionPayload(envelope, skipped, yagniSummary);

  return {
    envelope,
    session: {
      tool: YAGNI_LAYOUT_KEY,
      cwd: opts.cwd,
      score: envelope.verdict.score,
      passed: envelope.verdict.passed,
      payload: sessionPayload,
    },
  };
}
