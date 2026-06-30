import {
  commandProducesVerdict,
  ConfigurationError,
  type CommandSpec,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';

import { assembleOptsFromSpec } from '../assemble-opts.js';

import type { SuiteDefinition, SuiteStep } from '@opensip-cli/config';

const RUN_SCOPE_ARG_KEYS = new Set([
  'cwd',
  'config',
  'debug',
  'json',
  'quiet',
  'verbose',
  'reportTo',
  'apiKey',
  'open',
  'targets',
  'target',
]);

export interface ValidatedSuiteStep {
  readonly index: number;
  readonly tool: Tool;
  readonly spec: CommandSpec<unknown, ToolCliContext>;
  readonly config: SuiteStep;
  readonly args: Readonly<Record<string, unknown>>;
  readonly positionals: readonly unknown[];
}

export interface ValidatedSuite {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly ValidatedSuiteStep[];
}

export function validateSuite(args: {
  readonly name: string;
  readonly suite: SuiteDefinition;
  readonly tools: readonly Tool[];
}): ValidatedSuite {
  const errors: string[] = [];
  if (args.suite.execution !== undefined) {
    errors.push(
      `Suite '${args.name}' declares reserved execution options. execution.mode and execution.stopOnFirstFailure are not supported in v1.`,
    );
  }
  const steps: ValidatedSuiteStep[] = [];
  args.suite.steps.forEach((step, index) => {
    try {
      steps.push(validateStep(args.name, step, index, args.tools));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });
  if (errors.length > 0) {
    throw new ConfigurationError(errors.join('\n'), { code: 'CONFIG.SUITE.INVALID' });
  }
  return {
    name: args.name,
    ...(args.suite.description === undefined ? {} : { description: args.suite.description }),
    steps,
  };
}

function validateStep(
  suiteName: string,
  step: SuiteStep,
  index: number,
  tools: readonly Tool[],
): ValidatedSuiteStep {
  const tool = tools.find((candidate) => candidate.metadata.id === step.tool);
  if (tool === undefined) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} references unknown tool UUID '${step.tool}'.`,
      { code: 'CONFIG.SUITE.UNKNOWN_TOOL' },
    );
  }
  const spec = (tool.commandSpecs ?? []).find((candidate) => candidate.name === step.command);
  if (spec === undefined) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} references unknown command '${step.command}' for tool '${tool.metadata.name}'.`,
      { code: 'CONFIG.SUITE.UNKNOWN_COMMAND' },
    );
  }
  if (spec.output === 'live-view') {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} command '${step.command}' is a live-view command; suites require non-interactive commands in v1.`,
      { code: 'CONFIG.SUITE.LIVE_VIEW_UNSUPPORTED' },
    );
  }
  // A suite composes gate VERDICTS, so every step must be a verdict-producing run
  // command (fit/graph/sim/yagni or an external scanner). A non-verdict command
  // (list/report/info/raw) would run but contribute nothing to the aggregate
  // verdict — reject it fail-closed before any step executes, rather than
  // silently producing an unaccounted step at runtime. (ADR-0093.)
  if (!commandProducesVerdict(spec)) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} command '${step.command}' does not produce a gate verdict. ` +
        `Suite steps must be verdict-producing run commands (e.g. fit, graph, sim, yagni, or an external ` +
        `scanner). Remove this step or point it at a run command.`,
      { code: 'CONFIG.SUITE.NOT_A_RUN_COMMAND' },
    );
  }
  if (step.cwd !== undefined) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} declares reserved per-step cwd. Put run-scope flags on 'suite run' instead.`,
      { code: 'CONFIG.SUITE.RESERVED_CWD' },
    );
  }

  const rawArgs = step.args ?? {};
  for (const key of Object.keys(rawArgs)) {
    if (RUN_SCOPE_ARG_KEYS.has(key)) {
      throw new ConfigurationError(
        `Suite '${suiteName}' step ${index + 1} uses run-scope arg '${key}'. Put run-scope flags on 'suite run' instead.`,
        { code: 'CONFIG.SUITE.RUN_SCOPE_ARG' },
      );
    }
  }

  const { knownKeys } = assembleOptsFromSpec({
    options: spec.options,
    suppliedValues: rawArgs,
  });
  const positionals = positionalArgs(rawArgs);
  for (const key of Object.keys(rawArgs)) {
    if (key === '_args') continue;
    if (!knownKeys.has(key)) {
      throw new ConfigurationError(
        `Suite '${suiteName}' step ${index + 1} arg '${key}' is not an option on '${step.command}'.`,
        { code: 'CONFIG.SUITE.UNKNOWN_ARG' },
      );
    }
  }

  return {
    index,
    tool,
    spec: spec,
    config: step,
    args: rawArgs,
    positionals,
  };
}

function positionalArgs(args: Readonly<Record<string, unknown>>): readonly unknown[] {
  const raw = args._args;
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}
