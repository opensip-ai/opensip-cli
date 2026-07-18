import { spawn } from 'node:child_process';

import {
  appendBoundedUtf8Text,
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

  constructor(options: CliRepairWritePortOptions) {
    this.projectRoot = options.projectRoot;
    this.configPath = options.configPath;
    this.entrypoint = options.cliEntrypoint ?? cliEntrypoint();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    return this.run(args);
  }

  private run(args: readonly string[]): Promise<Result<RepairApplyVerifyResult, McpReadError>> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...args], {
        cwd: this.projectRoot,
        env: repairMutationChildEnv(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let truncated = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        const next = appendBoundedUtf8Text(stdout, chunk, MAX_CAPTURE_BYTES);
        stdout = next.value;
        truncated ||= next.truncated;
        if (truncated) child.kill('SIGTERM');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const next = appendBoundedUtf8Text(stderr, chunk, MAX_CAPTURE_BYTES);
        stderr = next.value;
        truncated ||= next.truncated;
        if (truncated) child.kill('SIGTERM');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve(
          err(
            readError(
              'repair-spawn-failed',
              sanitizeMcpErrorMessage(error, { projectRoot: this.projectRoot }),
            ),
          ),
        );
      });
      child.on('close', () => {
        clearTimeout(timer);
        if (timedOut) {
          resolve(err(readError('repair-timeout', 'repair apply verify timed out')));
          return;
        }
        if (truncated) {
          resolve(
            err(readError('repair-output-too-large', 'repair output exceeded capture limit')),
          );
          return;
        }
        const parsed = parseApplyVerifyResult(stdout);
        if (!parsed.ok && stderr.trim() !== '') {
          resolve(
            err(
              readError(
                parsed.error.code,
                sanitizeMcpErrorMessage(`${parsed.error.message}; stderr: ${stderr}`, {
                  projectRoot: this.projectRoot,
                }),
              ),
            ),
          );
          return;
        }
        resolve(parsed);
      });
    });
  }
}
