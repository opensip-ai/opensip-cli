// @fitness-ignore-file detached-promises -- the preAction hook is a composition root: its body awaits maybeInitializeOwningTool inside executePostBailoutBootstrap. Matches the same suppression on index.ts and bootstrap/index.ts.
/**
 * pre-action-hook — Commander `preAction` adapter (ADR-0052).
 *
 * Business rules live in {@link planPreActionBootstrap} (phases 1–4) and
 * {@link executePostBailoutBootstrap} (phases 5–9). This module wires those
 * to Commander's preAction/postAction hooks.
 */

import { currentScope, generatePrefixedId } from '@opensip-cli/core';

import { executePostBailoutBootstrap } from './execute-post-bailout-bootstrap.js';
import { planPreActionBootstrap } from './plan-pre-action-bootstrap.js';

import type { PreActionRuntime } from './pre-action-runtime.js';
import type { Command } from 'commander';

export { resolveOwningTool } from './owning-tool-init.js';
export type { PreActionRuntime } from './pre-action-runtime.js';

export function installPreActionHook(
  program: Command,
  version: string,
  runtime: PreActionRuntime,
): void {
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    const runId = generatePrefixedId('run');
    const opts = actionCommand.opts();
    const cwd = (opts.cwd as string) ?? process.cwd();
    const cwdExplicit = actionCommand.getOptionValueSource('cwd') === 'cli';

    const plan = planPreActionBootstrap({
      opts: opts,
      cwd,
      cwdExplicit,
      runId,
      commandName: actionCommand.name(),
      explicitConfigPath: opts.config as string | undefined,
      tools: runtime.tools,
    });

    const { scope } = await executePostBailoutBootstrap({
      plan,
      runtime,
      version,
      // @fitness-ignore-next-line null-safety -- Commander optsWithGlobals always returns OptionValues; `.cloud` is absent-or-boolean.
      noCloud: actionCommand.optsWithGlobals().cloud === false,
      apiKey: opts.apiKey as string | undefined,
    });
    scope.diagnostics.event(
      'load',
      'debug',
      `preAction bootstrap completed for '${actionCommand.name()}'`,
    );
  });

  program.hook('postAction', disposeCurrentScope);
}

export function disposeCurrentScope(): void {
  try {
    const s = currentScope();
    if (s && typeof s.dispose === 'function') {
      s.dispose();
    }
  } catch {
    // @swallow-ok dispose errors on shutdown; the run has already produced its outcome.
  }
}
