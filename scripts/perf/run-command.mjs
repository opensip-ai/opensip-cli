import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  createChildProcessTerminator,
  parentSignalCoordinator,
  reserveParentSignalCleanup,
} from './child-process-lifecycle.mjs';
import { readProcessTable, sumProcessTreeRss } from './process-tree-rss.mjs';

const TERMINATION_GRACE_MS = 1000;
const FORCE_KILL_SETTLEMENT_MS = 1000;
const RSS_SAMPLE_TIMEOUT_MS = 1000;

export async function runMeasuredCommand(input) {
  const [command, ...args] = input.command;
  if (command === undefined) throw new Error('runMeasuredCommand requires a command.');

  const stdout = new TailBuffer(input.stdoutTailBytes);
  const stderr = new TailBuffer(input.stderrTailBytes);
  const stdoutCapture =
    input.stdoutCaptureBytes === undefined
      ? undefined
      : new PrefixBuffer(input.stdoutCaptureBytes, 'stdoutCaptureBytes');
  const sampleProcessTable = input.readProcessTable ?? readProcessTable;
  const sampleTimeoutMs = input.rssSampleTimeoutMs ?? RSS_SAMPLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(sampleTimeoutMs) || sampleTimeoutMs <= 0) {
    throw new RangeError('rssSampleTimeoutMs must be a positive safe integer');
  }
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let maxRssBytes;
  let timedOut = false;
  let timeoutHandle;
  let terminationHandle;
  let forceKillSettlementHandle;
  let sampleHandle;
  let sampleInFlight;
  let samplingDisabled = false;
  let commandCompletedAt;
  let commandDurationMs;

  const spawnChild = input.spawnChild ?? spawn;
  const useProcessGroup = input.useProcessGroup ?? process.platform !== 'win32';
  const parentReservation = reserveParentSignalCleanup(
    input.parentSignalCoordinator ?? parentSignalCoordinator,
  );
  if (parentReservation.interrupted()) {
    const signal = parentReservation.signal();
    parentReservation.complete();
    throw new Error(`Command interrupted by parent ${String(signal)} before spawn.`);
  }
  let child;
  try {
    child = spawnChild(command, args, {
      cwd: input.cwd,
      detached: useProcessGroup,
      env: input.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    parentReservation.complete();
    throw error;
  }
  const terminator = createChildProcessTerminator({
    captureProcessDescendants: input.captureProcessDescendants,
    child,
    killProcess: input.killProcess,
    killProcessTree: input.killProcessTree,
    platform: input.platform,
    useProcessGroup,
  });

  const onStdout = (chunk) => {
    stdout.push(chunk);
    stdoutCapture?.push(chunk);
  };
  const onStderr = (chunk) => stderr.push(chunk);
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);

  const sample = () => {
    if (child.pid === undefined || samplingDisabled) return Promise.resolve();
    if (sampleInFlight !== undefined) return sampleInFlight;
    sampleInFlight = sampleRssWithinDeadline(sampleProcessTable, sampleTimeoutMs)
      .then((rows) => {
        if (rows === undefined) {
          samplingDisabled = true;
          return;
        }
        terminator.observeProcessTable(rows);
        const rss = sumProcessTreeRss(rows, child.pid);
        if (rss > 0) maxRssBytes = Math.max(maxRssBytes ?? 0, rss);
      })
      .catch(() => {
        samplingDisabled = true;
      })
      .finally(() => {
        sampleInFlight = undefined;
      });
    return sampleInFlight;
  };

  sampleHandle = setInterval(() => {
    sample();
  }, input.sampleIntervalMs);
  sample();

  const noteCommandCompletion = () => {
    if (commandCompletedAt !== undefined) return;
    commandCompletedAt = new Date().toISOString();
    commandDurationMs = Math.round(performance.now() - start);
  };

  const exit = await new Promise((resolve) => {
    let settled = false;
    let closeResult;
    let forceSignalPromise;
    let terminationReason;
    let resolveTerminationComplete;
    const terminationComplete = new Promise((resolveComplete) => {
      resolveTerminationComplete = resolveComplete;
    });
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      clearTimeout(terminationHandle);
      clearTimeout(forceKillSettlementHandle);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('close', onClose);
      parentReservation.complete();
      terminator.dispose();
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      noteCommandCompletion();
      cleanup();
      resolveTerminationComplete();
      resolve(result);
    };
    const forceKill = (rootClosed = false) => {
      if (forceSignalPromise !== undefined) return forceSignalPromise;
      clearTimeout(terminationHandle);
      forceKillSettlementHandle = setTimeout(
        () =>
          settle(
            closeResult ?? {
              code: undefined,
              signal: 'SIGKILL',
              error: undefined,
            },
          ),
        input.forceKillSettlementMs ?? FORCE_KILL_SETTLEMENT_MS,
      );
      child.stdout?.destroy();
      child.stderr?.destroy();
      const finalObservation = rootClosed ? sampleInFlight : undefined;
      forceSignalPromise = Promise.resolve()
        .then(() => finalObservation)
        .catch(() => false)
        .then(() =>
          rootClosed ? terminator.signalAfterRootClose('SIGKILL') : terminator.signal('SIGKILL'),
        )
        .catch(() => false);
      return forceSignalPromise;
    };
    const beginTermination = (reason) => {
      if (terminationReason !== undefined) return terminationComplete;
      terminationReason = reason;
      clearTimeout(timeoutHandle);
      timedOut = reason === 'timeout';
      terminationHandle = setTimeout(forceKill, input.terminationGraceMs ?? TERMINATION_GRACE_MS);
      Promise.resolve()
        .then(() => terminator.signal('SIGTERM'))
        .catch(() => false);
      return terminationComplete;
    };
    function onError(error) {
      clearTimeout(timeoutHandle);
      if (sampleHandle !== undefined) clearInterval(sampleHandle);
      terminator.markRootClosed();
      noteCommandCompletion();
      closeResult = { code: undefined, signal: undefined, error };
      forceKill().finally(() => settle(closeResult));
    }
    function onClose(code, signal) {
      clearTimeout(timeoutHandle);
      if (sampleHandle !== undefined) clearInterval(sampleHandle);
      terminator.markRootClosed();
      noteCommandCompletion();
      closeResult = { code, signal, error: undefined };
      forceKill(true).finally(() => settle(closeResult));
    }

    child.once('error', onError);
    // `close` follows stdio closure, preserving complete bounded output tails.
    child.once('close', onClose);
    parentReservation.activate(() => beginTermination('parent-signal'));
    if (input.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => beginTermination('timeout'), input.timeoutMs);
    }
  });

  // Command duration ends with the child/stdio settlement. The final best-effort
  // RSS sample below must not inflate startup or install wall-time measurements.
  if (sampleHandle !== undefined) clearInterval(sampleHandle);
  await sample();

  return {
    command: input.command,
    cwd: input.cwd,
    startedAt,
    completedAt: commandCompletedAt,
    status: exit.code ?? (exit.signal === undefined ? 1 : 128),
    signal: exit.signal ?? undefined,
    error: exit.error === undefined ? undefined : String(exit.error.message ?? exit.error),
    timedOut,
    durationMs: commandDurationMs,
    maxRssBytes,
    stdoutTail: stdout.toString(),
    stderrTail: stderr.toString(),
    stdoutCapture: stdoutCapture?.toString(),
    stdoutTruncated: stdoutCapture?.truncated(),
  };
}

function sampleRssWithinDeadline(readTable, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    const deadline = setTimeout(() => settle(), timeoutMs);
    Promise.resolve()
      .then(() => readTable())
      .then(
        (rows) => settle(rows),
        () => settle(),
      );
  });
}

class TailBuffer {
  #limit;
  #chunks = [];
  #bytes = 0;

  constructor(limit) {
    this.#limit = limit;
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const combined = Buffer.concat([...this.#chunks, buffer]);
    const tail =
      combined.byteLength > this.#limit
        ? combined.subarray(combined.byteLength - this.#limit)
        : combined;
    this.#chunks = tail.byteLength === 0 ? [] : [tail];
    this.#bytes = tail.byteLength;
  }

  toString() {
    if (this.#bytes === 0) return '';
    return Buffer.concat(this.#chunks, this.#bytes).toString('utf8');
  }
}

class PrefixBuffer {
  #limit;
  #chunks = [];
  #bytes = 0;
  #truncated = false;

  constructor(limit, name) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
    this.#limit = limit;
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = this.#limit - this.#bytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const prefix = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
    if (prefix.byteLength > 0) {
      this.#chunks.push(prefix);
      this.#bytes += prefix.byteLength;
    }
    if (buffer.byteLength > remaining) this.#truncated = true;
  }

  toString() {
    if (this.#bytes === 0) return '';
    return Buffer.concat(this.#chunks, this.#bytes).toString('utf8');
  }

  truncated() {
    return this.#truncated;
  }
}
