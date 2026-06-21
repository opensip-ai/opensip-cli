// @fitness-ignore-file detached-promises -- the preAction hook is a composition root: its body awaits maybeInitializeOwningTool inside executePostBailoutBootstrap. Matches the same suppression on index.ts and bootstrap/index.ts.
/**
 * pre-action-hook — Commander `preAction` adapter (ADR-0052).
 *
 * Business rules live in {@link planPreActionBootstrap} (phases 1–4) and
 * {@link executePostBailoutBootstrap} (phases 5–9). This module wires those
 * to Commander's preAction/postAction hooks.
 */

import { currentScope, exitScope, generatePrefixedId } from '@opensip-cli/core';

import { commandPath } from '../commands/command-scope-index.js';
import { hostEnv } from '../env/host-env-specs.js';
import { setResolvedCommandLabel } from '../telemetry/command-label.js';

import { executePostBailoutBootstrap } from './execute-post-bailout-bootstrap.js';
import { planPreActionBootstrap } from './plan-pre-action-bootstrap.js';

import type { PreActionRuntime } from './pre-action-runtime.js';
import type { CommandScopeIndex } from '../commands/command-scope-index.js';
import type { Command } from 'commander';

export { resolveOwningTool } from './owning-tool-init.js';
export type { PreActionRuntime } from './pre-action-runtime.js';

export function installPreActionHook(
  program: Command,
  version: string,
  runtime: PreActionRuntime,
  commandScopes: CommandScopeIndex,
): void {
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    // M12: stamp the RESOLVED command name for the duration metric's label
    // (bounded cardinality) before any bootstrap that might throw — set as early
    // as the matched command is known.
    setResolvedCommandLabel(actionCommand.name());
    // B1 ("Child runId behavior"): resolve `runId` env-FIRST. A forked/spawned
    // child re-enters this hook and inherits its parent's run via `OPENSIP_RUN_ID`
    // (set in the child env by `correlationToEnv`); a top-level invocation, with
    // no `OPENSIP_RUN_ID` set, mints a fresh id. This is the single inheritance
    // seam — the spec JSON deliberately never carries `runId`, because the logger
    // that stamps every worker line is already live before the spec is parsed.
    const inherited = hostEnv.get<string>('OPENSIP_RUN_ID');
    const runId = inherited && inherited.length > 0 ? inherited : generatePrefixedId('run');
    const opts = actionCommand.opts();
    const cwd = (opts.cwd as string) ?? process.cwd();
    const cwdExplicit = actionCommand.getOptionValueSource('cwd') === 'cli';

    const plan = planPreActionBootstrap({
      opts: opts,
      cwd,
      cwdExplicit,
      runId,
      commandName: actionCommand.name(),
      commandPath: commandPath(actionCommand),
      commandScopes,
      explicitConfigPath: opts.config as string | undefined,
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
  } finally {
    // Complete the per-command lifecycle: clear the ambient ALS slot so a
    // subsequent command in the same process (a long-lived host driving
    // Commander sequentially) starts with a clean slot and its `enterScope`
    // does not trip the always-on re-entrancy guard against this finished run.
    // Production runs one command per process, so this is normally the final
    // teardown; it is a no-op when no scope is current.
    exitScope();
  }
}
