import { EXIT_CODES, type SuiteRunResult } from '@opensip-cli/contracts';
import { currentLogger, currentScope, type Tool } from '@opensip-cli/core';

import { shouldUseSuiteLiveView } from '../../bootstrap/suite-live-view-policy.js';
import { emitCommandResult } from '../mount-result-command.js';

import { runSuite, type RunSuiteInput } from './orchestrator.js';
import { hasSelector } from './propagated-options.js';
import { renderSuiteLive } from './suite-live-view.js';

import type { ResolvedSuite } from './built-in-suites.js';
import type { CliCommandsContext } from '../shared.js';
import type { SuiteDefinition } from '@opensip-cli/config';

export interface ExecuteSuiteCommandInput {
  readonly name: string;
  readonly resolved: ResolvedSuite;
  readonly opts: Readonly<Record<string, unknown>>;
  readonly ctx: CliCommandsContext;
  readonly tools: readonly Tool[];
  readonly defaultChanged: boolean;
}

/** Emit a suite-command configuration failure through the host-owned output seam. */
export async function emitSuiteCommandFailure(
  ctx: CliCommandsContext,
  opts: Readonly<Record<string, unknown>>,
  message: string,
): Promise<undefined> {
  ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  await emitCommandResult(
    { type: 'error', message, exitCode: EXIT_CODES.CONFIGURATION_ERROR },
    {
      render: ctx.render,
      jsonRequested: opts.json === true,
      exitCode: ctx.getExitCode?.(),
    },
  );
  return undefined;
}

/** One deduped checklist label per step, index-aligned, for the suite live view. */
function buildSuiteStepLabels(suite: SuiteDefinition, tools: readonly Tool[]): string[] {
  return suite.steps.map((step) => {
    const name = tools.find((tool) => tool.metadata.id === step.tool)?.metadata.name ?? step.tool;
    return name === step.command ? name : `${name} ${step.command}`;
  });
}

/** Execute one already-resolved suite through the canonical host output policy. */
export async function executeSuiteCommand(
  input: ExecuteSuiteCommandInput,
): Promise<SuiteRunResult | undefined> {
  const { ctx, defaultChanged, name, opts, resolved, tools } = input;

  if (ctx.toolContext === undefined) {
    return emitSuiteCommandFailure(ctx, opts, 'suite run requires the full ToolCliContext handle.');
  }
  if (opts.full === true && hasSelector(opts)) {
    return emitSuiteCommandFailure(ctx, opts, '--full conflicts with --changed/--since/--files.');
  }
  if (ctx.toolRunActionHooks === undefined) {
    return emitSuiteCommandFailure(
      ctx,
      opts,
      'suite run requires the host run-action hooks handle.',
    );
  }

  currentLogger().debug?.({
    evt: 'cli.suite.resolve.source',
    suite: name,
    source: resolved.source,
  });

  const suiteInput: RunSuiteInput = {
    name,
    suite: resolved.suite,
    source: resolved.source,
    tools,
    ctx: ctx.toolContext,
    runActionHooks: ctx.toolRunActionHooks,
    suiteOpts: opts,
    defaultChanged,
  };

  if (shouldUseSuiteLiveView({ json: opts.json === true })) {
    const projectRoot = currentScope()?.projectContext?.projectRoot;
    const { result } = await renderSuiteLive({
      suiteInput,
      stepLabels: buildSuiteStepLabels(resolved.suite, tools),
      verbose: opts.verbose === true,
      quiet: opts.quiet === true,
      ...(projectRoot === undefined ? {} : { projectPath: projectRoot }),
      glue: { setExitCode: ctx.setExitCode },
    });
    ctx.setExitCode(result.exitCode);
    return result;
  }

  const result = await runSuite(suiteInput);
  ctx.setExitCode(result.exitCode);
  await emitCommandResult(result, {
    render: ctx.render,
    jsonRequested: opts.json === true,
    exitCode: ctx.getExitCode?.(),
  });
  return result;
}
