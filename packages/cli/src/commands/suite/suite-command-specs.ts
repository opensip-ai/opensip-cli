import { suitesConfigSchema } from '@opensip-cli/config';
import { EXIT_CODES } from '@opensip-cli/contracts';
import { currentScope } from '@opensip-cli/core';

import {
  COMMAND_RESULT,
  defineCommand,
  PROJECT_SCOPE,
  RAW_STREAM,
  type HostSpec,
} from '../host-subcommand-shared.js';

import {
  BUILT_IN_AGENT_CONTEXT_SUITE_NAME,
  BUILT_IN_AUDIT_SUITE_NAME,
  listSuites,
  resolveSuite,
} from './built-in-suites.js';
import { emitSuiteCommandFailure, executeSuiteCommand } from './execute-suite-command.js';
import { maybeOpenSuiteReport } from './open-suite-report.js';
import { addSuiteStep } from './suite-add.js';
import { SUITE_RUN_OPTIONS } from './suite-run-options.js';
import { validateSuite } from './validate-suite.js';

import type { CliCommandsContext } from '../shared.js';
import type { SuiteAddResult, SuiteListResult } from '@opensip-cli/contracts';

function configuredSuites(): ReturnType<typeof suitesConfigSchema.parse> {
  return suitesConfigSchema.parse(currentScope()?.configDocument?.suites ?? {});
}

function parseArg(raw: string, previous: unknown): readonly string[] {
  return [...(Array.isArray(previous) ? (previous as readonly string[]) : []), raw];
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
    options: SUITE_RUN_OPTIONS,
    scope: PROJECT_SCOPE,
    // Built-in suites (`audit`) resolve without a config file, so the generic
    // spelling must run on an uninitialized repo too — otherwise it diverges
    // from top-level `audit` on the first run (ADR-0159).
    noInit: true,
    // `raw-stream`: the handler owns its whole output surface — it renders the
    // TTY suite live view itself, and reuses `emitCommandResult` for --json /
    // non-TTY (keeping the exact command-result shape) — so the host renders
    // nothing and never double-renders over the live view.
    output: RAW_STREAM,
    rawStreamReason: 'runtime-render-dispatch',
    handler: async (rawOpts) => {
      const opts = rawOpts as Record<string, unknown> & { _args?: readonly string[] };
      if (ctx.toolContext === undefined) {
        return emitSuiteCommandFailure(
          ctx,
          opts,
          'suite run requires the full ToolCliContext handle.',
        );
      }
      const name = String(opts._args?.[0] ?? '');
      if (
        currentScope()?.projectContext?.scope === 'ephemeral' &&
        name !== BUILT_IN_AUDIT_SUITE_NAME &&
        name !== BUILT_IN_AGENT_CONTEXT_SUITE_NAME
      ) {
        return emitSuiteCommandFailure(
          ctx,
          opts,
          `suite run without opensip init only supports the built-in ` +
            `'${BUILT_IN_AUDIT_SUITE_NAME}' or '${BUILT_IN_AGENT_CONTEXT_SUITE_NAME}' suite.`,
        );
      }
      const resolved = resolveSuite(name, configuredSuites());
      if (resolved === undefined) {
        return emitSuiteCommandFailure(ctx, opts, `Unknown suite '${name}'.`);
      }
      const result = await executeSuiteCommand({
        name,
        resolved,
        opts,
        ctx,
        tools: currentScope()?.tools.list() ?? [],
        defaultChanged: resolved.source === 'built-in' && name === BUILT_IN_AUDIT_SUITE_NAME,
      });
      if (result === undefined) return;
      return maybeOpenSuiteReport({ name, result, opts, ctx });
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
