/**
 * @fileoverview Command executor for external tool checks
 *
 * Executes external commands (eslint, prettier, etc.) with abort
 * and timeout support, then parses output into violations.
 */

import {
  execAbortable,
  ExecError,
  type AbortableExecOptions,
  type ExecAbortReason,
  type ExecResult,
} from './abortable-exec.js';

import type { CheckViolation, CommandConfig } from './check-config.js';

// =============================================================================
// TYPES
// =============================================================================

/** Options for executing an external command. */
export interface CommandExecutorOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeout?: number | undefined;
}

/** Result of executing an external command, including parsed violations. */
export interface CommandExecutionResult {
  readonly violations: CheckViolation[];
  readonly aborted: boolean;
  /** Set whenever `aborted` is true: why the command stopped early. */
  readonly abortReason?: ExecAbortReason;
  readonly exitCode: number | null;
  readonly error?: string;
  /** True only for ENOENT / exit 127 — optional tool missing, not a command fault. */
  readonly notInstalled?: boolean;
}

// =============================================================================
// EXECUTOR
// =============================================================================

function truncateStream(text: string, max = 500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} [truncated]`;
}

function notInstalledResult(bin: string, exitCode: number | null = null): CommandExecutionResult {
  return {
    violations: [],
    aborted: false,
    exitCode,
    notInstalled: true,
    error: `${bin} is not installed. Install it to enable this check.`,
  };
}

function unexpectedExitResult(
  exitCode: number | null,
  expectedCodes: readonly number[],
  stderr: string,
): CommandExecutionResult {
  return {
    violations: [],
    aborted: false,
    exitCode,
    error:
      `Command exited with unexpected code ${exitCode}. ` +
      `Expected one of: ${expectedCodes.join(', ')}. ` +
      `stderr: ${truncateStream(stderr)}`,
  };
}

function missingExitCodeResult(stderr: string): CommandExecutionResult {
  return {
    violations: [],
    aborted: false,
    exitCode: null,
    error: `Command terminated without an exit code. stderr: ${truncateStream(stderr)}`,
  };
}

function emptyFindingsOnNonzeroResult(
  exitCode: number | null,
  stderr: string,
): CommandExecutionResult {
  return {
    violations: [],
    aborted: false,
    exitCode,
    error:
      `Command exited ${String(exitCode)} with no parseable findings. ` +
      `stderr: ${truncateStream(stderr)}`,
  };
}

const DEFAULT_EXPECTED_EXIT_CODES: readonly number[] = [0, 1];

/**
 * Project an early-stopped exec onto the executor's result.
 *
 * The reason is carried, not dropped: the caller decides between a cancellation and a deadline
 * breach, and it cannot do that from `aborted` alone.
 */
function abortedResult(result: ExecResult): CommandExecutionResult {
  return {
    violations: [],
    aborted: true,
    exitCode: result.exitCode,
    ...(result.abortReason === undefined ? {} : { abortReason: result.abortReason }),
  };
}

/**
 * Execute an external command and parse its output into violations.
 */
export async function executeCommand(
  config: CommandConfig,
  files: readonly string[],
  options: CommandExecutorOptions,
): Promise<CommandExecutionResult> {
  const { cwd, signal, timeout } = options;

  const args = typeof config.args === 'function' ? config.args(files) : config.args;
  const command = [config.bin, ...args];

  const execOptions: AbortableExecOptions = { cwd, signal, timeout };

  let result: Awaited<ReturnType<typeof execAbortable>>;
  try {
    result = await execAbortable(command, execOptions);
  } catch (error) {
    // ENOENT = tool not installed (spawn fails before the process starts)
    if (error instanceof ExecError && error.errno === 'ENOENT') {
      return notInstalledResult(config.bin);
    }
    throw error;
  }

  if (result.aborted) return abortedResult(result);

  // Exit code 127 = command not found (shell mode)
  if (result.exitCode === 127) {
    return notInstalledResult(config.bin, 127);
  }

  if (result.exitCode === null) {
    return missingExitCodeResult(result.stderr);
  }

  const expectedCodes = config.expectedExitCodes ?? DEFAULT_EXPECTED_EXIT_CODES;
  if (!expectedCodes.includes(result.exitCode)) {
    return unexpectedExitResult(result.exitCode, expectedCodes, result.stderr);
  }

  let violations: CheckViolation[];
  try {
    violations = config.parseOutput(result.stdout, result.stderr, result.exitCode, files, cwd);
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    return {
      violations: [],
      aborted: false,
      exitCode: result.exitCode,
      error: `Failed to parse command output: ${message}`,
    };
  }

  // Nonzero exit that is "allowed" as findings, but parse produced nothing —
  // do not green-wash (truncated JSON / wrong schema / silent scanner failure).
  if (result.exitCode !== 0 && violations.length === 0) {
    return emptyFindingsOnNonzeroResult(result.exitCode, result.stderr);
  }

  return { violations, aborted: false, exitCode: result.exitCode };
}
