/**
 * @fileoverview Command executor for external tool checks
 *
 * Executes external commands (eslint, prettier, etc.) with abort
 * and timeout support, then parses output into violations.
 */

import { execAbortable, type AbortableExecOptions } from './abortable-exec.js'

import type { CheckViolation, CommandConfig } from './check-config.js'

// =============================================================================
// TYPES
// =============================================================================

/** Options for executing an external command. */
export interface CommandExecutorOptions {
  readonly cwd: string
  readonly signal?: AbortSignal | undefined
  readonly timeout?: number | undefined
}

/** Result of executing an external command, including parsed violations. */
export interface CommandExecutionResult {
  readonly violations: CheckViolation[]
  readonly aborted: boolean
  readonly exitCode: number | null
  readonly error?: string
}

// =============================================================================
// EXECUTOR
// =============================================================================

const DEFAULT_EXPECTED_EXIT_CODES: readonly number[] = [0, 1]

/**
 * Execute an external command and parse its output into violations.
 */
export async function executeCommand(
  config: CommandConfig,
  files: readonly string[],
  options: CommandExecutorOptions,
): Promise<CommandExecutionResult> {
  const { cwd, signal, timeout } = options

  const args = typeof config.args === 'function' ? config.args(files) : config.args
  const command = [config.bin, ...args]

  const execOptions: AbortableExecOptions = { cwd, signal, timeout }

  let result: Awaited<ReturnType<typeof execAbortable>>
  try {
    result = await execAbortable(command, execOptions)
  } catch (error) {
    // ENOENT = tool not installed (spawn fails before the process starts)
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ENOENT') || message.includes('not found')) {
      return {
        violations: [],
        aborted: false,
        exitCode: null,
        error: `${config.bin} is not installed. Install it to enable this check.`,
      }
    }
    throw error
  }

  if (result.aborted) {
    return { violations: [], aborted: true, exitCode: result.exitCode }
  }

  // Exit code 127 = command not found (shell mode)
  if (result.exitCode === 127) {
    return {
      violations: [],
      aborted: false,
      exitCode: 127,
      error: `${config.bin} is not installed. Install it to enable this check.`,
    }
  }

  const expectedCodes = config.expectedExitCodes ?? DEFAULT_EXPECTED_EXIT_CODES
  if (result.exitCode !== null && !expectedCodes.includes(result.exitCode)) {
    return {
      violations: [],
      aborted: false,
      exitCode: result.exitCode,
      error:
        `Command exited with unexpected code ${result.exitCode}. ` +
        `Expected one of: ${expectedCodes.join(', ')}. ` +
        `stderr: ${result.stderr.slice(0, 500)}${result.stderr.length > 500 ? ' [truncated]' : ''}`,
    }
  }

  const violations = config.parseOutput(result.stdout, result.stderr, result.exitCode ?? 0, files, cwd)

  return { violations, aborted: false, exitCode: result.exitCode }
}

