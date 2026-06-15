// @fitness-ignore-file semgrep-scan -- reviewed: pattern justified for this module
// @fitness-ignore-file error-handling-suite -- catch blocks delegate errors through established patterns
/**
 * @fileoverview Abortable command execution for fitness checks
 *
 * Provides shell command execution with abort signal and timeout support.
 * Child processes are properly cleaned up on abort.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { SystemError } from '@opensip-cli/core';

/**
 * Options for abortable command execution
 */
export interface AbortableExecOptions {
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
  maxBuffer?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeout?: number | undefined;
}

/**
 * Result of command execution
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  aborted: boolean;
}

/**
 * Error thrown when command execution fails
 */
class ExecError extends SystemError {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null,
    public readonly aborted: boolean,
  ) {
    super(message, { code: 'SYSTEM.FITNESS.EXEC_FAILED' });
    this.name = 'ExecError';
  }
}

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Execute a command with abort support.
 *
 * @param command - Either a shell command string or an array of [bin, ...args] (no shell).
 * @throws {SystemError} When the command array is empty
 * @throws {ExecError} When the child process fails to spawn
 */
export function execAbortable(
  command: string | readonly string[],
  options: AbortableExecOptions = {},
): Promise<ExecResult> {
  const {
    cwd = process.cwd(),
    signal,
    maxBuffer = DEFAULT_MAX_BUFFER_BYTES,
    env = process.env,
    timeout,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: '', exitCode: null, aborted: true });
      return;
    }

    let child: ChildProcess;
    if (typeof command === 'string') {
      // Shell mode (string command) — callers pass hardcoded commands (e.g., lint/test runners).
      // Array overload is preferred for untrusted input (no shell, no injection risk).
      // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- shell=true required for string commands; input is developer-defined check commands, not user input
      // eslint-disable-next-line sonarjs/os-command -- developer-supplied check command; not user-controllable
      child = spawn(command, [], {
        cwd,
        env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } else {
      // Array mode (no shell, safer)
      if (command.length === 0) {
        reject(
          new SystemError('Command array must not be empty', {
            code: 'SYSTEM.FITNESS.EXEC_EMPTY_COMMAND',
          }),
        );
        return;
      }
      const [bin, ...args] = command;
      // @fitness-ignore-next-line no-non-null-assertions -- command length validated above
      child = spawn(bin ?? '', args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    }

    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timeoutId: NodeJS.Timeout | undefined;

    // setEncoding routes chunks through a StringDecoder that buffers
    // partial multi-byte UTF-8 sequences across 'data' chunk boundaries.
    // Without it, a non-ASCII char (unicode in a file path, an error
    // message) split across two chunks decodes to replacement chars and
    // corrupts the captured output used for downstream text matching.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length + chunk.length <= maxBuffer) {
        stdout += chunk;
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length + chunk.length <= maxBuffer) {
        stderr += chunk;
      }
    });

    const abortHandler = (): void => {
      if (!aborted) {
        aborted = true;
        killProcess(child);
      }
    };

    signal?.addEventListener('abort', abortHandler);

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        if (!aborted) {
          aborted = true;
          killProcess(child);
        }
      }, timeout);
    }

    child.on('close', (code: number | null) => {
      signal?.removeEventListener('abort', abortHandler);
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, exitCode: code, aborted });
    });

    child.on('error', (err: Error) => {
      signal?.removeEventListener('abort', abortHandler);
      if (timeoutId) clearTimeout(timeoutId);
      reject(
        new ExecError(`Failed to spawn process: ${err.message}`, stdout, stderr, null, aborted),
      );
    });
  });
}

/**
 * Kill a child process and all its descendants.
 */
function killProcess(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // @swallow-ok Process group kill failed, try direct kill
      try {
        child.kill('SIGKILL');
      } catch {
        // @swallow-ok Process already exited
      }
    }
  }
}
