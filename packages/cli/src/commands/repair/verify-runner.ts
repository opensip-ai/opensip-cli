import { spawn } from 'node:child_process';

import { appendBoundedUtf8Text, snapshotEnv, type EnvVarSpec } from '@opensip-cli/core';

import { changedFilesForRepair } from './changes.js';
import {
  classifyVerification,
  parseVerificationEnvelope,
  unverifiedWithoutRun,
  verificationFailure,
} from './verify.js';

import type {
  RepairApplyResult,
  RepairVerificationCommand,
  RepairVerificationResult,
} from '@opensip-cli/contracts';

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
].map(
  (canonical): EnvVarSpec => ({
    canonical,
    docs: 'Forwarded from the parent process into a nested repair verification CLI run.',
  }),
);

export interface ProcessRunRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface ProcessRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export type ProcessRunner = (request: ProcessRunRequest) => Promise<ProcessRunResult>;

export interface VerifyRepairInput {
  readonly projectRoot: string;
  readonly applyResult: RepairApplyResult;
  readonly runner?: ProcessRunner;
  readonly cliEntrypoint?: string;
  readonly timeoutMs?: number;
}

function currentCliEntrypoint(): string | undefined {
  return process.argv[1];
}

function childEnv(): NodeJS.ProcessEnv {
  return snapshotEnv(CHILD_ENV_SPECS, { OPENSIP_REPAIR_VERIFY_CHILD: '1' });
}

export const defaultProcessRunner: ProcessRunner = (request) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: childEnv(),
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
    }, request.timeoutMs);

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
      resolve({
        exitCode: null,
        stdout,
        stderr: error.message,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        truncated,
      });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated,
      });
    });
  });

function canonicalTool(tool: string): string {
  return tool === 'fitness' ? 'fit' : tool;
}

function buildFitCommand(input: VerifyRepairInput): RepairVerificationCommand {
  const args = [
    'fit',
    '--check',
    input.applyResult.signal.ruleId,
    '--changed',
    '--include-impacted',
    '--json',
  ];
  return {
    tool: 'fit',
    args,
    cwd: input.projectRoot,
    check: input.applyResult.signal.ruleId,
  };
}

export async function verifyRepair(input: VerifyRepairInput): Promise<RepairVerificationResult> {
  const tool = canonicalTool(input.applyResult.session.tool);
  const files = changedFilesForRepair(input.applyResult);
  if (tool !== 'fit') {
    return unverifiedWithoutRun({
      tool,
      ruleId: input.applyResult.signal.ruleId,
      files,
      failure: verificationFailure(
        'verification-tool-unsupported',
        `repair verification is not implemented for tool '${input.applyResult.session.tool}'`,
      ),
    });
  }

  const entrypoint = input.cliEntrypoint ?? currentCliEntrypoint();
  const command = buildFitCommand(input);
  if (entrypoint === undefined || entrypoint === '') {
    return unverifiedWithoutRun({
      tool,
      ruleId: input.applyResult.signal.ruleId,
      files,
      command,
      failure: verificationFailure(
        'verification-entrypoint-unavailable',
        'could not resolve the current OpenSIP CLI entrypoint for verification',
      ),
    });
  }

  const runner = input.runner ?? defaultProcessRunner;
  const processResult = await runner({
    command: process.execPath,
    args: [entrypoint, ...command.args],
    cwd: input.projectRoot,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (processResult.timedOut) {
    return unverifiedWithoutRun({
      tool,
      ruleId: input.applyResult.signal.ruleId,
      files,
      command,
      failure: verificationFailure('verification-timeout', 'verification command timed out'),
    });
  }
  if (processResult.truncated) {
    return unverifiedWithoutRun({
      tool,
      ruleId: input.applyResult.signal.ruleId,
      files,
      command,
      failure: verificationFailure(
        'verification-output-too-large',
        'verification command output exceeded the capture limit',
      ),
    });
  }

  const parsed = parseVerificationEnvelope(processResult.stdout);
  if (!parsed.ok) {
    return unverifiedWithoutRun({
      tool,
      ruleId: input.applyResult.signal.ruleId,
      files,
      command,
      failure: parsed.failure,
    });
  }

  return classifyVerification({
    tool,
    ruleId: input.applyResult.signal.ruleId,
    files,
    envelope: parsed.envelope,
    signal: input.applyResult.signal,
    command,
    exitCode: processResult.exitCode,
    durationMs: processResult.durationMs,
  });
}
