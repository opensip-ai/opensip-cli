import { spawn } from 'node:child_process';

import {
  createBoundedUtf8Capture,
  err,
  ok,
  snapshotEnv,
  type EnvVarSpec,
  type Result,
} from '@opensip-cli/core';

import { readError, sanitizeMcpErrorMessage, type McpReadError } from './mcp-error.js';

import type { RepairApplyVerifyResult } from '@opensip-cli/contracts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
/** Grace after SIGTERM before escalating to SIGKILL (M14). */
const KILL_GRACE_MS = 2000;
const CHILD_ENV_SPECS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OPENSIP_PROFILING',
  'OPENSIP_PROFILE_DIR',
].map((canonical): EnvVarSpec => ({
  canonical,
  docs: 'Forwarded from the parent process into a nested MCP repair mutation CLI run.',
}));

export interface RepairApplyVerifyInput {
  readonly ref: string;
  readonly tool: string;
  readonly signal: string;
  readonly action: string;
  readonly force?: boolean;
  /** Cancellation for this MCP request; distinct from the selected signal id above. */
  readonly abortSignal?: AbortSignal;
}

export interface RepairWritePort {
  applyVerify(
    input: RepairApplyVerifyInput,
  ): Promise<Result<RepairApplyVerifyResult, McpReadError>>;
}

export interface CliRepairWritePortOptions {
  readonly projectRoot: string;
  /** Exact config selected by the parent invocation; absent for no-init runs. */
  readonly configPath?: string;
  readonly cliEntrypoint?: string;
  readonly timeoutMs?: number;
  /** Server-lifetime cancellation captured from the entered RunScope. */
  readonly abortSignal?: AbortSignal;
}

function cliEntrypoint(): string | undefined {
  return process.argv[1];
}

export function repairMutationChildEnv(): NodeJS.ProcessEnv {
  return snapshotEnv(CHILD_ENV_SPECS, { OPENSIP_MCP_MUTATION_CHILD: '1' });
}

function isRepairApplyVerifyResult(value: unknown): value is RepairApplyVerifyResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly type?: unknown }).type === 'repair-apply-verify'
  );
}

function parseApplyVerifyResult(stdout: string): Result<RepairApplyVerifyResult, McpReadError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return err(readError('repair-output-invalid', 'repair apply verify output was not JSON'));
  }
  const data = (parsed as { readonly data?: unknown } | null)?.data;
  if (!isRepairApplyVerifyResult(data)) {
    return err(
      readError(
        'repair-output-invalid',
        'repair apply verify output did not include a repair-apply-verify result',
      ),
    );
  }
  return ok(data);
}

export class CliRepairWritePort implements RepairWritePort {
  private readonly projectRoot: string;
  private readonly configPath: string | undefined;
  private readonly entrypoint: string | undefined;
  private readonly timeoutMs: number;
  private readonly abortSignal: AbortSignal | undefined;

  constructor(options: CliRepairWritePortOptions) {
    this.projectRoot = options.projectRoot;
    this.configPath = options.configPath;
    this.entrypoint = options.cliEntrypoint ?? cliEntrypoint();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.abortSignal = options.abortSignal;
  }

  applyVerify(
    input: RepairApplyVerifyInput,
  ): Promise<Result<RepairApplyVerifyResult, McpReadError>> {
    if (this.entrypoint === undefined || this.entrypoint === '') {
      return Promise.resolve(
        err(
          readError(
            'repair-entrypoint-unavailable',
            'could not resolve the current OpenSIP CLI entrypoint for repair apply verify',
          ),
        ),
      );
    }
    const args = [
      this.entrypoint,
      'repair',
      'apply',
      input.ref,
      '--cwd',
      this.projectRoot,
      ...(this.configPath === undefined ? [] : ['--config', this.configPath]),
      '--tool',
      input.tool,
      '--signal',
      input.signal,
      '--action',
      input.action,
      '--verify',
      '--json',
      ...(input.force === true ? ['--force'] : []),
    ];
    const abortSignals = [this.abortSignal, input.abortSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    if (abortSignals.some((signal) => signal.aborted)) {
      return Promise.resolve(err(readError('cancelled', 'repair apply verify was cancelled')));
    }
    return this.run(args, abortSignals);
  }

  private run(
    args: readonly string[],
    abortSignals: readonly AbortSignal[],
  ): Promise<Result<RepairApplyVerifyResult, McpReadError>> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...args], {
        cwd: this.projectRoot,
        env: repairMutationChildEnv(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = createBoundedUtf8Capture(MAX_CAPTURE_BYTES);
      const stderr = createBoundedUtf8Capture(MAX_CAPTURE_BYTES);
      let settled = false;
      let stopReason: 'cancelled' | 'output-too-large' | 'timeout' | undefined;
      let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = (): void => requestStop('cancelled');

      const settle = (result: Result<RepairApplyVerifyResult, McpReadError>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killEscalationTimer !== undefined) clearTimeout(killEscalationTimer);
        for (const signal of abortSignals) signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      /** M14: SIGTERM first, then SIGKILL if the child ignores cooperative stop. */
      function requestStop(reason: NonNullable<typeof stopReason>): void {
        stopReason ??= reason;
        try {
          child.kill('SIGTERM');
        } catch {
          // @swallow-ok child already exited; kill is best-effort stop
        }
        if (killEscalationTimer !== undefined) return;
        killEscalationTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // @swallow-ok child already exited between TERM and KILL
          }
        }, KILL_GRACE_MS);
      }

      const timer = setTimeout(() => {
        requestStop('timeout');
      }, this.timeoutMs);

      for (const signal of abortSignals) {
        signal.addEventListener('abort', onAbort, { once: true });
        // Close the check→listener race without spawning another mutation after cancellation.
        if (signal.aborted) onAbort();
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.append(chunk);
        if (stdout.truncated) requestStop('output-too-large');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.append(chunk);
        if (stderr.truncated) requestStop('output-too-large');
      });
      child.on('error', (error) => {
        settle(
          err(
            readError(
              'repair-spawn-failed',
              sanitizeMcpErrorMessage(error, { projectRoot: this.projectRoot }),
            ),
          ),
        );
      });
      // M14: always settle — close is the terminal event even after SIGKILL.
      child.on('close', (code, signal) => {
        if (stopReason === 'cancelled') {
          settle(err(readError('cancelled', 'repair apply verify was cancelled')));
          return;
        }
        if (stopReason === 'timeout') {
          settle(err(readError('repair-timeout', 'repair apply verify timed out')));
          return;
        }
        if (stopReason === 'output-too-large' || stdout.truncated || stderr.truncated) {
          settle(err(readError('repair-output-too-large', 'repair output exceeded capture limit')));
          return;
        }
        if (code !== 0 || signal !== null) {
          const detail = stderr.value.trim();
          const message =
            detail === ''
              ? 'repair apply verify child failed'
              : sanitizeMcpErrorMessage(`repair apply verify child failed; stderr: ${detail}`, {
                  projectRoot: this.projectRoot,
                });
          settle(
            err(
              readError('repair-child-failed', message, {
                exitCode: code ?? -1,
                ...(signal === null ? {} : { signal }),
              }),
            ),
          );
          return;
        }
        const parsed = parseApplyVerifyResult(stdout.value);
        if (!parsed.ok && stderr.value.trim() !== '') {
          settle(
            err(
              readError(
                parsed.error.code,
                sanitizeMcpErrorMessage(`${parsed.error.message}; stderr: ${stderr.value}`, {
                  projectRoot: this.projectRoot,
                }),
              ),
            ),
          );
          return;
        }
        settle(parsed);
      });
    });
  }
}
