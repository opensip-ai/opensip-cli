import {
  commandProducesEvidenceSnapshot,
  commandProducesVerdict,
  ConfigurationError,
  currentScope,
  type CommandSpec,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';

import { isExternalToolProvenance } from '../../bootstrap/tool-provenance.js';
import { hostErrorCatalog } from '../../errors/host-error-catalog.js';
import { assembleOptsFromSpec } from '../assemble-opts.js';

import type { SuiteDefinition, SuiteStep } from '@opensip-cli/config';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const SUITE_INVALID = hostErrorCatalog.require('CONFIG.SUITE.INVALID');
const SUITE_UNKNOWN_REFERENCE = hostErrorCatalog.require('CONFIG.SUITE.UNKNOWN_REFERENCE');

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
  readonly kind: 'verdict' | 'evidence';
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
  // `execution.failOnFault` is a live policy (#2 fault taxonomy); `mode` /
  // `stopOnFirstFailure` remain reserved and are rejected in v1.
  const execution = args.suite.execution;
  if (execution?.mode !== undefined || execution?.stopOnFirstFailure !== undefined) {
    errors.push(
      `Suite '${args.name}' declares reserved execution options. execution.mode and execution.stopOnFirstFailure are not supported in v1.`,
    );
  }
  const steps: ValidatedSuiteStep[] = [];
  args.suite.steps.forEach((step, index) => {
    try {
      steps.push(validateSuiteStep(args.name, step, index, args.tools));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });
  if (errors.length > 0) {
    throw new ConfigurationError(errors.join('\n'), {
      code: SUITE_INVALID.code,
      definition: SUITE_INVALID,
      metadata: { condition: 'shape' },
    });
  }
  return {
    name: args.name,
    ...(args.suite.description === undefined ? {} : { description: args.suite.description }),
    steps,
  };
}

function validateSuiteStep(
  suiteName: string,
  step: SuiteStep,
  index: number,
  tools: readonly Tool[],
): ValidatedSuiteStep {
  const tool = tools.find((candidate) => candidate.metadata.id === step.tool);
  if (tool === undefined) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} references unknown tool UUID '${step.tool}'.`,
      {
        code: SUITE_UNKNOWN_REFERENCE.code,
        definition: SUITE_UNKNOWN_REFERENCE,
        metadata: { condition: 'unknown-tool' },
      },
    );
  }
  const spec = (tool.commandSpecs ?? []).find((candidate) => candidate.name === step.command);
  if (spec === undefined) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} references unknown command '${step.command}' for tool '${tool.metadata.name}'.`,
      {
        code: SUITE_UNKNOWN_REFERENCE.code,
        definition: SUITE_UNKNOWN_REFERENCE,
        metadata: { condition: 'unknown-command' },
      },
    );
  }
  const kind = validateStepCapability(suiteName, step, index, tool, spec);
  const { rawArgs, positionals } = validateStepArguments(suiteName, step, index, spec);

  return {
    index,
    tool,
    spec,
    config: step,
    args: rawArgs,
    positionals,
    kind,
  };
}

function validateStepCapability(
  suiteName: string,
  step: SuiteStep,
  index: number,
  tool: Tool,
  spec: CommandSpec<unknown, ToolCliContext>,
): ValidatedSuiteStep['kind'] {
  if (spec.output === 'live-view') {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} command '${step.command}' is a live-view command; suites require non-interactive commands in v1.`,
      {
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'live-view-unsupported' },
      },
    );
  }
  const producesVerdict = commandProducesVerdict(spec);
  const producesEvidence = commandProducesEvidenceSnapshot(spec);
  if (producesVerdict && producesEvidence) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} command '${step.command}' declares both verdict and evidence snapshot capabilities. Combined semantics are unsupported in v1.`,
      {
        code: SUITE_UNKNOWN_REFERENCE.code,
        definition: SUITE_UNKNOWN_REFERENCE,
        metadata: { condition: 'ambiguous-capability' },
      },
    );
  }
  if (!producesVerdict && !producesEvidence) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} command '${step.command}' does not produce a gate verdict. ` +
        `Suite steps must produce a verdict or an evidence snapshot. Remove this step or point it at a run/evidence command.`,
      {
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'not-a-run-command' },
      },
    );
  }
  if (producesEvidence && isExternalToolProvenance(tool, currentScope()?.toolProvenance ?? [])) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} evidence command '${step.command}' would use the external worker transport, which does not carry evidence snapshots in v1.`,
      {
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'evidence-external' },
      },
    );
  }
  return producesEvidence ? 'evidence' : 'verdict';
}

function validateStepArguments(
  suiteName: string,
  step: SuiteStep,
  index: number,
  spec: CommandSpec<unknown, ToolCliContext>,
): {
  readonly rawArgs: Readonly<Record<string, unknown>>;
  readonly positionals: readonly unknown[];
} {
  if (step.cwd !== undefined) {
    throw new ConfigurationError(
      `Suite '${suiteName}' step ${index + 1} declares reserved per-step cwd. Put run-scope flags on 'suite run' instead.`,
      {
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'reserved-cwd' },
      },
    );
  }

  const rawArgs = step.args ?? {};
  for (const key of Object.keys(rawArgs)) {
    if (RUN_SCOPE_ARG_KEYS.has(key)) {
      throw new ConfigurationError(
        `Suite '${suiteName}' step ${index + 1} uses run-scope arg '${key}'. Put run-scope flags on 'suite run' instead.`,
        {
          code: SUITE_INVALID.code,
          definition: SUITE_INVALID,
          metadata: { condition: 'run-scope-arg' },
        },
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
        {
          code: SUITE_INVALID.code,
          definition: SUITE_INVALID,
          metadata: { condition: 'unknown-arg' },
        },
      );
    }
  }
  return { rawArgs, positionals };
}

function positionalArgs(args: Readonly<Record<string, unknown>>): readonly unknown[] {
  const raw = args._args;
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}
