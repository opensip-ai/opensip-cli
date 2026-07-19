import { type SuiteRunResult, type SuiteStepSummary } from '@opensip-cli/contracts';
import { currentLogger, currentScope } from '@opensip-cli/core';

import { loadOwningToolCapabilities } from '../../bootstrap/load-tool-capabilities.js';

import type { ValidatedSuite } from './validate-suite.js';

export function deriveSuiteAggregate(
  steps: readonly SuiteStepSummary[],
): SuiteRunResult['aggregate'] {
  let passed = 0;
  let failed = 0;
  let faulted = 0;
  let errors = 0;
  let warnings = 0;

  for (const step of steps) {
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

export async function loadSuiteStepCapabilities(
  suite: ValidatedSuite,
  projectRoot?: string,
): Promise<void> {
  const loaded = new Set<string>();
  const scope = currentScope();
  if (scope?.capabilities === undefined) return;
  const projectDir = projectRoot ?? scope.projectContext?.projectRoot ?? process.cwd();
  const pluginsConfig = scope.configDocument?.plugins ?? {};
  const log = currentLogger();

  // @sequential-ok — registration mutates the shared per-run capability scope.
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

export function resolveBuiltInAuditFullScopeFiles(
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
