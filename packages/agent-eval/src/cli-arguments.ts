import { hasControlCharacter } from './control-text.js';

import type { Arm, GoldTask } from './model/task.js';

const SMOKE_TASK_ID = 'entrypoint-trace.customer-ts';
const MAX_ARGV_COUNT = 512;
const MAX_ARG_BYTES = 8 * 1024;

export const USAGE = `Usage: pnpm agent-eval [options]

Options:
  --task <id>                 Run one task (repeatable; default: all)
  --arm <control|opensip|both>  Select an arm (default: both)
  --json <path>               Set the JSON report path
  --opensip-entrypoint <js>   Measure an installed opensip-cli package JS bin
  --smoke                     Run the entrypoint-trace smoke task with both arms
  --list                      List registered task ids
  --help                      Show this help
`;

type ArmOption = Arm | 'both';

export interface ParsedCliOptions {
  readonly arm: ArmOption;
  readonly help: boolean;
  readonly jsonPath?: string;
  readonly list: boolean;
  /** Absolute path to an installed opensip-cli package JS bin instead of workspace `dist`. */
  readonly opensipEntrypoint?: string;
  readonly smoke: boolean;
  readonly taskIds: readonly string[];
}

export class InvocationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvocationError';
  }
}

function isArmOption(value: string): value is ArmOption {
  return value === 'control' || value === 'opensip' || value === 'both';
}

/**
 * Enforce global count and per-value byte limits before parsing argv.
 *
 * @throws {InvocationError} When argv exceeds either supported resource bound.
 */
function validateArgvBounds(argv: readonly string[]): void {
  if (argv.length > MAX_ARGV_COUNT) throw new InvocationError('Too many arguments.');
  if (argv.some((value) => Buffer.byteLength(value, 'utf8') > MAX_ARG_BYTES)) {
    throw new InvocationError('An argument exceeds the supported size.');
  }
}

/**
 * Read and validate the value following one CLI flag.
 *
 * @throws {InvocationError} When the value is absent, flag-shaped, or contains controls.
 */
function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('-')) {
    throw new InvocationError(`${flag} requires a value.`);
  }
  if (hasControlCharacter(value)) {
    throw new InvocationError(`${flag} contains an invalid value.`);
  }
  return value;
}

interface MutableParseState {
  arm: ArmOption;
  armProvided: boolean;
  help: boolean;
  jsonPath?: string;
  list: boolean;
  opensipEntrypoint?: string;
  smoke: boolean;
  taskIds: string[];
}

/**
 * Apply one value-bearing flag to mutable parser state.
 *
 * @throws {InvocationError} When a value is invalid or a singleton flag is repeated.
 */
function parseValueFlag(
  argv: readonly string[],
  index: number,
  state: MutableParseState,
): number | undefined {
  const flag = argv[index];
  if (flag === '--task') {
    state.taskIds.push(readValue(argv, index, flag));
    return index + 2;
  }
  if (flag === '--arm') {
    if (state.armProvided) throw new InvocationError('--arm may be specified only once.');
    const arm = readValue(argv, index, flag);
    if (!isArmOption(arm)) {
      throw new InvocationError('--arm must be control, opensip, or both.');
    }
    state.arm = arm;
    state.armProvided = true;
    return index + 2;
  }
  if (flag === '--json') {
    if (state.jsonPath !== undefined) {
      throw new InvocationError('--json may be specified only once.');
    }
    state.jsonPath = readValue(argv, index, flag);
    return index + 2;
  }
  if (flag === '--opensip-entrypoint') {
    if (state.opensipEntrypoint !== undefined) {
      throw new InvocationError('--opensip-entrypoint may be specified only once.');
    }
    state.opensipEntrypoint = readValue(argv, index, flag);
    return index + 2;
  }
  return undefined;
}

function parseBooleanFlag(flag: string, state: MutableParseState): boolean {
  switch (flag) {
    case '--help': {
      state.help = true;
      return true;
    }
    case '--list': {
      state.list = true;
      return true;
    }
    case '--smoke': {
      state.smoke = true;
      return true;
    }
    default: {
      return false;
    }
  }
}

/**
 * Enforce mutually exclusive help, list, smoke, and evaluation modes.
 *
 * @throws {InvocationError} When parsed options select incompatible modes.
 */
function validateModeCombinations(state: MutableParseState): void {
  if (state.smoke && (state.taskIds.length > 0 || state.armProvided || state.list || state.help)) {
    throw new InvocationError('--smoke cannot be combined with task, arm, list, or help options.');
  }
  const evaluationOptionPresent =
    state.taskIds.length > 0 ||
    state.armProvided ||
    state.jsonPath !== undefined ||
    state.opensipEntrypoint !== undefined ||
    state.smoke;
  if (state.list && (state.help || evaluationOptionPresent)) {
    throw new InvocationError('--list cannot be combined with evaluation or help options.');
  }
  if (state.help && evaluationOptionPresent) {
    throw new InvocationError('--help cannot be combined with evaluation options.');
  }
}

/**
 * Parse and validate the command's complete, closed argv vocabulary.
 *
 * @throws {InvocationError} When argv is unsafe, unknown, incomplete, or internally incompatible.
 */
export function parseArgs(argv: readonly string[]): ParsedCliOptions {
  validateArgvBounds(argv);
  const state: MutableParseState = {
    arm: 'both',
    armProvided: false,
    help: false,
    list: false,
    smoke: false,
    taskIds: [],
  };
  let index = 0;
  while (index < argv.length) {
    const nextIndex = parseValueFlag(argv, index, state);
    if (nextIndex !== undefined) {
      index = nextIndex;
      continue;
    }
    const flag = argv[index] ?? '';
    if (!parseBooleanFlag(flag, state)) throw new InvocationError('Unknown option.');
    index += 1;
  }
  validateModeCombinations(state);
  return {
    arm: state.arm,
    help: state.help,
    ...(state.jsonPath === undefined ? {} : { jsonPath: state.jsonPath }),
    list: state.list,
    ...(state.opensipEntrypoint === undefined
      ? {}
      : { opensipEntrypoint: state.opensipEntrypoint }),
    smoke: state.smoke,
    taskIds: [...state.taskIds],
  };
}

function deduplicate(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function knownTaskIds(registry: Readonly<Record<string, GoldTask>>): readonly string[] {
  return Object.keys(registry);
}

/**
 * Resolve requested task ids against the closed task registry.
 *
 * @throws {InvocationError} When a requested task is unknown or unavailable.
 */
export function selectTasks(
  options: ParsedCliOptions,
  registry: Readonly<Record<string, GoldTask>>,
): readonly GoldTask[] {
  let requested: readonly string[];
  if (options.smoke) requested = [SMOKE_TASK_ID];
  else if (options.taskIds.length === 0) requested = knownTaskIds(registry);
  else requested = deduplicate(options.taskIds);
  const tasks: GoldTask[] = [];
  for (const id of requested) {
    if (!Object.hasOwn(registry, id)) {
      throw new InvocationError(
        `Unknown task id. Known task ids: ${knownTaskIds(registry).join(', ')}`,
      );
    }
    const task = registry[id];
    if (task === undefined) throw new InvocationError('The selected task is unavailable.');
    tasks.push(task);
  }
  return tasks;
}

export function selectedArms(options: ParsedCliOptions): readonly Arm[] {
  if (options.smoke || options.arm === 'both') return ['control', 'opensip'];
  return [options.arm];
}
