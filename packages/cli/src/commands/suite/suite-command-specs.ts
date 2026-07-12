import { suitesConfigSchema } from '@opensip-cli/config';
import { EXIT_CODES } from '@opensip-cli/contracts';
import { currentLogger, currentScope, type Tool } from '@opensip-cli/core';

import { shouldUseSuiteLiveView } from '../../bootstrap/suite-live-view-policy.js';
import {
  COMMAND_RESULT,
  defineCommand,
  PROJECT_SCOPE,
  RAW_STREAM,
  type HostSpec,
} from '../host-subcommand-shared.js';
import { emitCommandResult } from '../mount-result-command.js';

import { BUILT_IN_AUDIT_SUITE_NAME, listSuites, resolveSuite } from './built-in-suites.js';
import { runSuite, type RunSuiteInput } from './orchestrator.js';
import { hasSelector } from './propagated-options.js';
import { addSuiteStep } from './suite-add.js';
import { renderSuiteLive } from './suite-live-view.js';
import { validateSuite } from './validate-suite.js';

import type { CliCommandsContext } from '../shared.js';
import type { SuiteDefinition } from '@opensip-cli/config';
import type { SuiteAddResult, SuiteListResult } from '@opensip-cli/contracts';

function configuredSuites(): ReturnType<typeof suitesConfigSchema.parse> {
  return suitesConfigSchema.parse(currentScope()?.configDocument?.suites ?? {});
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

function parseArg(raw: string, previous: unknown): readonly string[] {
  return [...(isStringArray(previous) ? previous : []), raw];
}

/** One deduped checklist label per step, index-aligned, for the suite live view. */
function buildSuiteStepLabels(suite: SuiteDefinition, tools: readonly Tool[]): string[] {
  return suite.steps.map((step) => {
    const name = tools.find((t) => t.metadata.id === step.tool)?.metadata.name ?? step.tool;
    return name === step.command ? name : `${name} ${step.command}`;
  });
}

function buildSuiteRunSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/suite/suite-command-specs.ts',
      declaration: 'buildSuiteRunSpec',
    },
    name: 'run',
    description: 'Run a configured suite in one shared project scope',
    commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey', 'open'],
    args: [{ name: 'name', description: 'Configured suite name' }],
    options: [
      {
        flag: '--config',
        value: '<path>',
        description: 'Path to opensip-cli.config.yml (overrides default root discovery)',
      },
      {
        flag: '--changed',
        description: 'Propagate changed-file selection to compatible suite steps',
        default: false,
      },
      {
        flag: '--since',
        value: '<ref>',
        description: 'Git ref base for compatible changed-file suite steps',
      },
      {
        flag: '--files',
        value: '<path>',
        description: 'Explicit changed file for compatible suite steps (repeatable)',
        arrayDefault: [],
        parse: parseArg,
      },
      {
        flag: '--full',
        description: 'Run the whole repo (disable the built-in audit changed-scope default)',
        default: false,
      },
    ],
    scope: PROJECT_SCOPE,
    // `raw-stream`: the handler owns its whole output surface — it renders the
    // TTY suite live view itself, and reuses `emitCommandResult` for --json /
    // non-TTY (keeping the exact command-result shape) — so the host renders
    // nothing and never double-renders over the live view.
    output: RAW_STREAM,
    rawStreamReason: 'runtime-render-dispatch',
    handler: async (rawOpts) => {
      const opts = rawOpts as Record<string, unknown> & { _args?: readonly string[] };
      const isJson = opts.json === true;
      const fail = async (message: string): Promise<void> => {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        await emitCommandResult(
          { type: 'error', message, exitCode: EXIT_CODES.CONFIGURATION_ERROR },
          { render: ctx.render, jsonRequested: isJson, exitCode: ctx.getExitCode?.() },
        );
      };

      if (ctx.toolContext === undefined) {
        await fail('suite run requires the full ToolCliContext handle.');
        return;
      }
      if (opts.full === true && hasSelector(opts)) {
        await fail('--full conflicts with --changed/--since/--files.');
        return;
      }
      const name = String(opts._args?.[0] ?? '');
      if (
        currentScope()?.projectContext?.scope === 'ephemeral' &&
        name !== BUILT_IN_AUDIT_SUITE_NAME
      ) {
        await fail(
          `suite run without opensip init only supports the built-in ` +
            `'${BUILT_IN_AUDIT_SUITE_NAME}' suite.`,
        );
        return;
      }
      const resolved = resolveSuite(name, configuredSuites());
      if (resolved === undefined) {
        await fail(`Unknown suite '${name}'.`);
        return;
      }
      currentLogger().debug?.({
        evt: 'cli.suite.resolve.source',
        suite: name,
        source: resolved.source,
      });
      if (ctx.toolRunActionHooks === undefined) {
        await fail('suite run requires the host run-action hooks handle.');
        return;
      }

      const suiteInput: RunSuiteInput = {
        name,
        suite: resolved.suite,
        source: resolved.source,
        tools: currentScope()?.tools.list() ?? [],
        ctx: ctx.toolContext,
        runActionHooks: ctx.toolRunActionHooks,
        suiteOpts: opts,
        defaultChanged: resolved.source === 'built-in' && name === BUILT_IN_AUDIT_SUITE_NAME,
      };

      // TTY (not --json): render the whole suite through one live view — banner,
      // a step checklist (spinner → ✓/✗), then the compact aggregate. Steps run
      // headless inside it. The TTY probe lives in the host policy helper so this
      // handler never touches process.stdout directly.
      if (shouldUseSuiteLiveView({ json: isJson })) {
        const projectRoot = currentScope()?.projectContext?.projectRoot;
        const { result } = await renderSuiteLive({
          suiteInput,
          stepLabels: buildSuiteStepLabels(resolved.suite, suiteInput.tools),
          verbose: opts.verbose === true,
          quiet: opts.quiet === true,
          ...(projectRoot === undefined ? {} : { projectPath: projectRoot }),
          glue: { setExitCode: ctx.setExitCode },
        });
        ctx.setExitCode(result.exitCode);
        return;
      }

      // --json or non-TTY: run without the live view; the exact command-result
      // path emits json or renders the compact aggregate as text.
      const result = await runSuite(suiteInput);
      ctx.setExitCode(result.exitCode);
      await emitCommandResult(result, {
        render: ctx.render,
        jsonRequested: isJson,
        exitCode: ctx.getExitCode?.(),
      });
    },
  });
}

function buildSuiteListSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/suite/suite-command-specs.ts',
      declaration: 'buildSuiteListSpec',
    },
    name: 'list',
    description: 'List configured suites and their resolved steps',
    commonFlags: ['json'],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: () => {
      const tools = currentScope()?.tools.list() ?? [];
      const suites = configuredSuites();
      const entries = listSuites(suites);
      const result: SuiteListResult = {
        type: 'suite-list',
        totalCount: entries.length,
        suites: entries.map(([name, suite]) => {
          const validated = validateSuite({ name, suite, tools });
          return {
            name,
            ...(suite.description === undefined ? {} : { description: suite.description }),
            steps: validated.steps.map((step) => ({
              tool: step.tool.metadata.name,
              stableId: step.tool.metadata.id,
              command: step.spec.name,
              args: step.args,
            })),
          };
        }),
      };
      return Promise.resolve(result);
    },
  });
}

function buildSuiteAddSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/suite/suite-command-specs.ts',
      declaration: 'buildSuiteAddSpec',
    },
    name: 'add',
    description: 'Add a tool command step to a configured suite',
    commonFlags: ['json', 'cwd'],
    args: [{ name: 'name', description: 'Suite name' }],
    options: [
      {
        flag: '--tool',
        value: '<name-or-uuid>',
        description: 'Tool name or stable UUID',
        required: true,
      },
      {
        flag: '--command',
        value: '<name>',
        description: 'Tool command name',
        required: true,
      },
      {
        flag: '--arg',
        value: '<key=value>',
        description: 'Tool option value to write into the suite step',
        variadic: true,
        arrayDefault: [],
        parse: parseArg,
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const scope = currentScope();
      const opts = rawOpts as {
        _args?: readonly string[];
        tool?: string;
        command?: string;
        arg?: readonly string[];
      };
      const suite = String(opts._args?.[0] ?? '');
      const project = scope?.projectContext;
      const output = addSuiteStep({
        suite,
        tool: opts.tool ?? '',
        command: opts.command ?? '',
        argPairs: opts.arg ?? [],
        tools: scope?.tools.list() ?? [],
        projectRoot: project?.projectRoot ?? process.cwd(),
        configPath: project?.configPath,
      });
      const result: SuiteAddResult = {
        type: 'suite-add',
        suite,
        tool: output.tool.metadata.name,
        stableId: output.tool.metadata.id,
        command: opts.command ?? '',
        configPath: output.configPath,
        changed: output.changed,
      };
      if (!output.changed) ctx.setExitCode(EXIT_CODES.SUCCESS);
      return result;
    },
  });
}

export function buildSuiteGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [buildSuiteRunSpec(ctx), buildSuiteListSpec(), buildSuiteAddSpec(ctx)];
}
