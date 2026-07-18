import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  currentScope,
  currentTraceparent,
  forkAndSettle,
  getMeter,
  logger,
  SystemError,
  type WorkerMessage,
} from '@opensip-cli/core';

import { buildCapabilityWorkerChildEnv } from './env.js';

import type { CapabilityWorkerSpec } from './types.js';

export const CAPABILITY_WORKER_SUBCOMMAND = '__capability-pack-worker';
const DEFAULT_CAPABILITY_WORKER_TIMEOUT_MS = 120_000;

type CapabilityWorkerMessage = WorkerMessage<never, unknown>;

export async function runCapabilityWorkerSpec(args: {
  readonly spec: CapabilityWorkerSpec;
  readonly cwd: string;
  readonly cliScript?: string;
  readonly timeoutMs?: number;
}): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-capability-worker-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(args.spec), 'utf8');
  try {
    return await forkAndAwait({
      spec: args.spec,
      specPath,
      cwd: args.cwd,
      cliScript: args.cliScript ?? process.argv[1] ?? '',
      timeoutMs: args.timeoutMs ?? DEFAULT_CAPABILITY_WORKER_TIMEOUT_MS,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function forkAndAwait(args: {
  readonly spec: CapabilityWorkerSpec;
  readonly specPath: string;
  readonly cwd: string;
  readonly cliScript: string;
  readonly timeoutMs: number;
}): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const scope = currentScope();
    const runId = scope?.runId;
    const configPath = scope?.projectContext?.configPath;
    const traceparent = currentTraceparent();
    const started = Date.now();
    logger.info({
      evt: 'cli.capability.worker.start',
      module: 'cli:capability',
      domain: args.spec.domainId,
      packageName: args.spec.pkg.name,
    });
    const handle = forkAndSettle(
      {
        command: args.cliScript,
        argv: [
          CAPABILITY_WORKER_SUBCOMMAND,
          args.specPath,
          '--cwd',
          args.cwd,
          ...(configPath === undefined ? [] : ['--config', configPath]),
        ],
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        enableHeartbeat: true,
        enableSigintCancellation: true,
        buildChildEnv: (parentEnv) =>
          buildCapabilityWorkerChildEnv({
            parentEnv,
            runId,
            traceparent,
            resourceDecision: args.spec.resourceDecision,
          }),
        onMessage: (msg: unknown) => {
          const typed = msg as CapabilityWorkerMessage;
          if (typed.kind === 'result') {
            handle.done(() => {
              recordDuration(args.spec, 'success', started);
              resolve(typed.value);
            });
          } else if (typed.kind === 'error') {
            handle.done(() => {
              recordDuration(args.spec, 'error', started);
              reject(workerError(args.spec, typed.message, handle.getStderrTail()));
            });
          }
        },
        onLimitFailure: (failureClass, detail) => {
          recordDuration(args.spec, failureClass, started);
          reject(
            workerError(
              args.spec,
              detail === undefined
                ? `capability worker failed: ${failureClass}`
                : `capability worker failed: ${failureClass} (${detail})`,
              handle.getStderrTail(),
            ),
          );
        },
      },
      { runId },
    );
    handle.child.on('exit', (code: number | null) => {
      rejectPrematureCapabilityWorkerExit({
        handle,
        spec: args.spec,
        started,
        code,
        reject,
      });
    });
  });
}

/**
 * Defer premature-exit rejection so a result/error already queued on the IPC
 * channel is processed first. Linux under load can otherwise reject clean
 * workers that drained their final `process.send` just before exiting.
 */
function rejectPrematureCapabilityWorkerExit(args: {
  readonly handle: ReturnType<typeof forkAndSettle>;
  readonly spec: CapabilityWorkerSpec;
  readonly started: number;
  readonly code: number | null;
  readonly reject: (error: Error) => void;
}): void {
  const { handle, spec, started, code, reject } = args;
  if (handle.isSettled()) return;
  // Two macrotasks (setImmediate + short timer) cover both "already in the
  // parent's queue" and "still crossing the kernel pipe" cases.
  setImmediate(() => {
    if (handle.isSettled()) return;
    setTimeout(() => {
      if (handle.isSettled()) return;
      handle.done(() => {
        recordDuration(spec, 'exit', started);
        reject(
          workerError(
            spec,
            `capability worker exited (code ${code ?? 'null'}) before producing a result`,
            handle.getStderrTail(),
          ),
        );
      });
    }, 50);
  });
}

function recordDuration(spec: CapabilityWorkerSpec, outcome: string, started: number): void {
  const durationMs = Date.now() - started;
  getMeter('opensip-cli')
    .createHistogram('opensip_cli.capability_worker.duration_ms')
    .record(durationMs, {
      domain: spec.domainId,
      operation: requestKind(spec.request),
      outcome,
    });
  logger.info({
    evt: outcome === 'success' ? 'cli.capability.worker.finish' : 'cli.capability.worker.fail',
    module: 'cli:capability',
    domain: spec.domainId,
    packageName: spec.pkg.name,
    outcome,
    durationMs,
  });
}

function requestKind(request: unknown): string {
  if (typeof request === 'object' && request !== null) {
    const kind = (request as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.length <= 80) return kind;
  }
  return 'unknown';
}

function workerError(
  spec: CapabilityWorkerSpec,
  message: string,
  stderrTail?: string,
): SystemError {
  return new SystemError(`capability pack ${spec.pkg.name}: ${message}`, {
    code: 'SYSTEM.CAPABILITY_WORKER.FAILED',
    context: {
      packageName: spec.pkg.name,
      domainId: spec.domainId,
      stderrTail,
    },
  });
}
