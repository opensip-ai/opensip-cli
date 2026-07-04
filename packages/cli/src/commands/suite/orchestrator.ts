import { performance } from 'node:perf_hooks';

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  currentLogger,
  currentScope,
  generatePrefixedId,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';

import { loadOwningToolCapabilities } from '../../bootstrap/load-tool-capabilities.js';
import { runWithSuiteRunContext, type RunActionHooks } from '../../bootstrap/run-plane.js';

import { buildReviewBrief } from './review-brief-builder.js';
import { resolveSuiteScope } from './suite-scope.js';
import { runStepsSerially } from './suite-step-runner.js';
import { validateSuite, type ValidatedSuite } from './validate-suite.js';

import type { SuiteDefinition } from '@opensip-cli/config';
import type { SuiteRunResult, SuiteStepSummary } from '@opensip-cli/contracts';

export interface RunSuiteInput {
  readonly name: string;
  readonly suite: SuiteDefinition;
  readonly tools: readonly Tool[];
  readonly ctx: ToolCliContext;
  readonly runActionHooks: RunActionHooks;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
}

export async function runSuite(input: RunSuiteInput): Promise<SuiteRunResult> {
  const suite = validateSuite({
    name: input.name,
    suite: input.suite,
    tools: input.tools,
  });
  const suiteRunId = generatePrefixedId('suite');
  const started = performance.now();
  const log = currentLogger();
  const cwd = typeof input.suiteOpts.cwd === 'string' ? input.suiteOpts.cwd : process.cwd();
  const scope = resolveSuiteScope({
    cwd,
    suiteOpts: input.suiteOpts,
    defaultChanged: input.defaultChanged === true,
  });

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

  await loadSuiteStepCapabilities(suite);

  const internalSteps = await runWithSuiteRunContext({ suiteRunId, suiteName: suite.name }, () =>
    runStepsSerially({
      suite,
      suiteRunId,
      ctx: input.ctx,
      runActionHooks: input.runActionHooks,
      suiteOpts: input.suiteOpts,
      defaultChanged: scope.mode === 'changed' && scope.source === 'default',
      fullScopeFiles: resolveBuiltInAuditFullScopeFiles(cwd, {
        defaultChanged: input.defaultChanged === true,
        fullScope: scope.mode === 'full',
      }),
    }),
  );
  const steps = internalSteps.map((step) => step.summary);
  const exitCode = Math.max(0, ...steps.map((step) => step.exitCode));
  const aggregate = deriveSuiteAggregate(steps);
  const reviewBrief = buildReviewBrief({
    suite: suite.name,
    suiteRunId,
    steps: internalSteps,
    changedFiles: scope.mode === 'changed' ? (scope.changedFiles ?? null) : null,
  });
  const durationMs = Math.max(0, performance.now() - started);

  log.info?.({
    evt: 'cli.suite.brief.built',
    suite: suite.name,
    suiteRunId,
    verdict: reviewBrief.verdict,
    risks: reviewBrief.topRisks.length,
    correlatedRisks: reviewBrief.correlatedRisks?.length ?? 0,
    degraded: reviewBrief.degraded.length,
  });

  log.info?.({
    evt: 'cli.suite.run.complete',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
    aggregate,
  });

  return {
    type: 'suite-run',
    suite: suite.name,
    suiteRunId,
    exitCode,
    durationMs,
    scope,
    aggregate,
    steps,
    reviewBrief,
  };
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
    const verdict = step.verdict;
    if (step.error !== undefined) {
      faulted += 1;
    } else if (step.exitCode !== EXIT_CODES.SUCCESS || verdict?.passed === false) {
      failed += 1;
    } else if (verdict?.passed === true) {
      passed += 1;
    }
    errors += verdict?.errors ?? 0;
    warnings += verdict?.warnings ?? 0;
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

async function loadSuiteStepCapabilities(suite: ValidatedSuite): Promise<void> {
  const loaded = new Set<string>();
  const scope = currentScope();
  if (scope?.capabilities === undefined) return;
  const projectDir = scope?.projectContext?.projectRoot ?? process.cwd();
  const pluginsConfig = scope?.configDocument?.plugins ?? {};
  const log = currentLogger();

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
