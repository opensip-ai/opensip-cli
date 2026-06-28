import { suitesConfigSchema } from '@opensip-cli/config';
import { EXIT_CODES } from '@opensip-cli/contracts';
import { currentScope } from '@opensip-cli/core';

import {
  COMMAND_RESULT,
  defineCommand,
  PROJECT_SCOPE,
  type HostSpec,
} from '../host-subcommand-shared.js';

import { runSuite } from './orchestrator.js';
import { addSuiteStep } from './suite-add.js';
import { validateSuite } from './validate-suite.js';

import type { CliCommandsContext } from '../shared.js';
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

function buildSuiteRunSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'run',
    description: 'Run a configured suite in one shared project scope',
    commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey', 'open'],
    args: [{ name: 'name', description: 'Configured suite name' }],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: async (rawOpts) => {
      if (ctx.toolContext === undefined) {
        ctx.setExitCode(EXIT_CODES.RUNTIME_ERROR);
        return {
          type: 'error',
          message: 'suite run requires the full ToolCliContext handle.',
          exitCode: EXIT_CODES.RUNTIME_ERROR,
        };
      }
      const opts = rawOpts as Record<string, unknown> & {
        _args?: readonly string[];
      };
      const name = String(opts._args?.[0] ?? '');
      const suite = configuredSuites()[name];
      if (suite === undefined) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return {
          type: 'error',
          message: `Unknown suite '${name}'.`,
          exitCode: EXIT_CODES.CONFIGURATION_ERROR,
        };
      }
      const result = await runSuite({
        name,
        suite,
        tools: currentScope()?.tools.list() ?? [],
        ctx: ctx.toolContext,
        suiteOpts: opts,
      });
      ctx.setExitCode(result.exitCode);
      return result;
    },
  });
}

function buildSuiteListSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'list',
    description: 'List configured suites and their resolved steps',
    commonFlags: ['json'],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: () => {
      const tools = currentScope()?.tools.list() ?? [];
      const suites = configuredSuites();
      const result: SuiteListResult = {
        type: 'suite-list',
        totalCount: Object.keys(suites).length,
        suites: Object.entries(suites).map(([name, suite]) => {
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
