import { performance } from 'node:perf_hooks';

import { EXIT_CODES, type SuiteRunResult, type SuiteStepSummary } from '@opensip-cli/contracts';
import {
  currentLogger,
  currentScope,
  generatePrefixedId,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';

import { loadOwningToolCapabilities } from '../../bootstrap/load-tool-capabilities.js';
import { runWithSuiteRunContext, type RunActionHooks } from '../../bootstrap/run-plane.js';

import { type SuiteSource } from './built-in-suites.js';
import { buildReviewBrief } from './review-brief-builder.js';
import { allocateSuiteLedgerIdentity, persistSuiteRun } from './run-ledger-persist.js';
import { resolveSuiteScope } from './suite-scope.js';
import { runStepsSerially, type SuiteStepEvent } from './suite-step-runner.js';
import {
  logTaskContextManifest,
  prepareTaskContext,
  resultWithPersistence,
  taskContextManifestFor,
  taskContextPointersAvailable,
} from './task-context-orchestration.js';
import { validateSuite, type ValidatedSuite } from './validate-suite.js';

import type { SuiteDefinition } from '@opensip-cli/config';

export interface RunSuiteInput {
  readonly name: string;
  readonly suite: SuiteDefinition;
  readonly source?: SuiteSource;
  readonly tools: readonly Tool[];
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
  /** Optional step-lifecycle sink — the suite live view wires this to progress events. */
  readonly onStepEvent?: (event: SuiteStepEvent) => void;
}

function contextPersistencePrecondition(manifest: SuiteRunResult['contextManifest']): {
  readonly persistencePrecondition?: () => boolean;
} {
  if (manifest === undefined || manifest.readiness === 'unavailable') return {};
  return { persistencePrecondition: () => taskContextPointersAvailable(manifest) };
}

export async function runSuite(input: RunSuiteInput): Promise<SuiteRunResult> {
  const suite = validateSuite({
    name: input.name,
    suite: input.suite,
    tools: input.tools,
  });
  const suiteRunId = generatePrefixedId('suite');
  const started = performance.now();
  const startedAt = new Date();
  const log = currentLogger();
  const requestedCwd =
    typeof input.suiteOpts.cwd === 'string' ? input.suiteOpts.cwd : process.cwd();
  const context = await prepareTaskContext(input, suite, requestedCwd);
  const cwd = context.cwd;
  const suiteOpts = context.aggregates ? { ...input.suiteOpts, cwd } : input.suiteOpts;
  const scope = resolveSuiteScope({
    cwd,
    suiteOpts,
    defaultChanged: input.defaultChanged === true,
  });

  // When scope resolves to full (explicit --full or fallback from failed
  // changed-file resolution), force full-mode step propagation so failed
  // selectors (changed/since) are not re-sent and graph-impact full-file
  // injection is not blocked by hasRuntimeSelector.
  const stepSuiteOpts: Record<string, unknown> =
    scope.mode === 'full' ? { ...suiteOpts, full: true } : suiteOpts;

  log.info?.({
    evt: 'cli.suite.run.start',
    suite: suite.name,
    suiteRunId,
    stepCount: suite.steps.length,
  });
  log.debug?.({
    evt: 'cli.suite.scope.resolved',
    suite: suite.name,
    suiteRunId,
    mode: scope.mode,
    source: scope.source,
    ...(scope.changedFiles === undefined ? {} : { changedFiles: scope.changedFiles }),
    ...(scope.ref === undefined ? {} : { ref: scope.ref }),
  });
  if (scope.source === 'fallback') {
    log.warn?.({
      evt: 'cli.suite.scope.fallback',
      suite: suite.name,
      suiteRunId,
      reason: scope.notice,
    });
  }

  await loadSuiteStepCapabilities(suite, context.aggregates ? cwd : undefined);

  const internalSteps = await runWithSuiteRunContext({ suiteRunId, suiteName: suite.name }, () =>
    runStepsSerially({
      suite,
      suiteRunId,
      ctx: input.ctx,
      runActionHooks: input.runActionHooks,
      suiteOpts: stepSuiteOpts,
      defaultChanged: scope.mode === 'changed' && scope.source === 'default',
      fullScopeFiles: resolveBuiltInAuditFullScopeFiles(cwd, {
        defaultChanged: input.defaultChanged === true,
        fullScope: scope.mode === 'full',
      }),
      ...(input.onStepEvent === undefined ? {} : { onStepEvent: input.onStepEvent }),
    }),
  );
  const steps = internalSteps.map((step) => step.summary);
  // Worst-of suite exit is deliberately a numeric `Math.max` over the ADR-0020
  // code space (ratified in ADR-0093 / ADR-0100 — see ADR-0131): any failing
  // step fails the suite. After Tasks 1.2/1.3 every step exit source (setExitCode,
  // deliverSignals, reportFailure, emitError, process.exit) writes the per-step
  // capture slot, so `step.exitCode` is the single source of truth here — no step
  // touches the host holder mid-run for this aggregate to miss.
  //
  // A CHECK-level runtime fault (a unit threw but the tool still produced an
  // envelope — `verdict` present) is "result unknown" and NON-blocking by default
  // (#2 fault taxonomy): its exit is excluded from the worst-of so a crashed check
  // doesn't fail the suite like a findings failure does — the fault is still
  // raised in the aggregate counts + review brief. A STEP/APP-level failure (NO
  // envelope: a thrown command, ConfigurationError, or ToolError before results,
  // ADR-0060) keeps its ADR-0020 exit taxonomy and still blocks. `failOnFault`
  // (suite execution policy, default false) opts every fault back into blocking.
  const failOnFault = input.suite.execution?.failOnFault === true;
  const isNonBlockingFault = (step: SuiteStepSummary): boolean =>
    step.outcome === 'faulted' && step.verdict !== undefined;
  const blockingSteps = failOnFault ? steps : steps.filter((step) => !isNonBlockingFault(step));
  let exitCode = Math.max(0, ...blockingSteps.map((step) => step.exitCode));
  const aggregate = deriveSuiteAggregate(steps);
  const reviewBrief = context.aggregates
    ? undefined
    : buildReviewBrief({
        suite: suite.name,
        suiteRunId,
        steps: internalSteps,
        changedFiles: scope.mode === 'changed' ? (scope.changedFiles ?? null) : null,
      });
  if (reviewBrief !== undefined) {
    log.info?.({
      evt: 'cli.suite.brief.built',
      suite: suite.name,
      suiteRunId,
      verdict: reviewBrief.verdict,
      risks: reviewBrief.topRisks.length,
      correlatedRisks: reviewBrief.correlatedRisks?.length ?? 0,
      degraded: reviewBrief.degraded.length,
    });
  }

  const ledgerIdentity = allocateSuiteLedgerIdentity(internalSteps);
  const contextManifest = await taskContextManifestFor({
    preparation: context,
    ledger: ledgerIdentity,
    steps: internalSteps,
  });
  if (contextManifest?.readiness === 'unavailable' && input.suite.execution?.failOnFault === true) {
    exitCode = Math.max(exitCode, EXIT_CODES.RUNTIME_ERROR);
  }
  logTaskContextManifest(suite.name, contextManifest);

  // Source-end capture is part of the context run's evidence work. Freeze both
  // completion clocks only after it finishes so persisted wall time and the
  // reported monotonic duration cover the same operation boundary.
  const completedAt = new Date();
  const durationMs = Math.max(0, performance.now() - started);

  log.info?.({
    evt: 'cli.suite.run.complete',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
    aggregate,
  });

  const baseResult: SuiteRunResult = {
    type: 'suite-run',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
    scope,
    aggregate,
    steps,
    ...(reviewBrief === undefined ? {} : { reviewBrief }),
    ...(contextManifest === undefined ? {} : { contextManifest }),
    verbose: input.suiteOpts.verbose === true,
  };
  const runId = persistSuiteRun({
    result: baseResult,
    internalSteps,
    source: input.source ?? 'configured',
    cwd,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    identity: ledgerIdentity,
    ...contextPersistencePrecondition(contextManifest),
  });
  return resultWithPersistence(baseResult, runId);
}

export function deriveSuiteAggregate(
  steps: readonly SuiteStepSummary[],
): SuiteRunResult['aggregate'] {
  let passed = 0;
  let failed = 0;
  let faulted = 0;
  let errors = 0;
  let warnings = 0;

  for (const step of steps) {
    // `step.outcome` is the single source of truth (deriveOutcome over the step's
    // RunVerdict, unioned with host-caught runtime issues). A UNIT-level fault (a
    // check that threw, surfaced as `verdict.faulted`) now counts `faulted`, not
    // `failed` — the old `step.error`-only heuristic only saw run-LEVEL throws.
    // Every step lands in exactly one bucket (the old shape silently dropped a
    // success-exit step that emitted no envelope from all three counts).
    switch (step.outcome) {
      case 'faulted': {
        faulted += 1;
        break;
      }
      case 'failed': {
        failed += 1;
        break;
      }
      case 'passed': {
        passed += 1;
        break;
      }
    }
    errors += step.verdict?.errors ?? 0;
    warnings += step.verdict?.warnings ?? 0;
  }

  return {
    steps: steps.length,
    passed,
    failed,
    faulted,
    errors,
    warnings,
  };
}

async function loadSuiteStepCapabilities(
  suite: ValidatedSuite,
  projectRoot?: string,
): Promise<void> {
  const loaded = new Set<string>();
  const scope = currentScope();
  if (scope?.capabilities === undefined) return;
  const projectDir = projectRoot ?? scope?.projectContext?.projectRoot ?? process.cwd();
  const pluginsConfig = scope?.configDocument?.plugins ?? {};
  const log = currentLogger();

  // @sequential-ok — capability loading registers into shared scope with
  // ordering side effects; bounded by the configured suite steps (a handful) and
  // deduped, so serial-by-design, not unbounded fanout.
  for (const step of suite.steps) {
    const toolId = step.tool.metadata.id;
    if (loaded.has(toolId)) continue;
    loaded.add(toolId);
    const domains = await loadOwningToolCapabilities({
      owningTool: step.tool,
      projectDir,
      pluginsConfig,
    });
    if (domains > 0) {
      log.debug?.({
        evt: 'cli.suite.step.capabilities.loaded',
        suite: suite.name,
        tool: toolId,
        domains,
      });
    }
  }
}

function resolveBuiltInAuditFullScopeFiles(
  cwd: string,
  opts: { readonly defaultChanged: boolean; readonly fullScope: boolean },
): readonly string[] | undefined {
  if (!opts.defaultChanged || !opts.fullScope) return undefined;
  const targets = currentScope()?.targets;
  if (targets === undefined) return undefined;
  const names = targets.getAll().map((target) => target.config.name);
  if (names.length === 0) return undefined;
  const files = targets.resolveTargets(names, cwd);
  return files.length === 0 ? undefined : files;
}
