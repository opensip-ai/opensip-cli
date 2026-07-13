import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { killProcessTree, readProcessTable, sumProcessTreeRss } from './process-tree-rss.mjs';

const TERMINATION_GRACE_MS = 1000;
const FORCE_KILL_SETTLEMENT_MS = 1000;

export async function runMeasuredCommand(input) {
  const [command, ...args] = input.command;
  if (command === undefined) throw new Error('runMeasuredCommand requires a command.');

  const stdout = new TailBuffer(input.stdoutTailBytes);
  const stderr = new TailBuffer(input.stderrTailBytes);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let maxRssBytes;
  let timedOut = false;
  let timeoutHandle;
  let terminationHandle;
  let forceKillSettlementHandle;
  let sampleHandle;

  const spawnChild = input.spawnChild ?? spawn;
  const child = spawnChild(command, args, {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onStdout = (chunk) => stdout.push(chunk);
  const onStderr = (chunk) => stderr.push(chunk);
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);

  const sample = async () => {
    if (child.pid === undefined) return;
    const rows = await readProcessTable().catch(() => []);
    const rss = sumProcessTreeRss(rows, child.pid);
    if (rss > 0) maxRssBytes = Math.max(maxRssBytes ?? 0, rss);
  };

  sampleHandle = setInterval(() => {
    void sample();
  }, input.sampleIntervalMs);
  void sample();

  const exit = await new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      clearTimeout(terminationHandle);
      clearTimeout(forceKillSettlementHandle);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const signalTree = (signal) => {
      if (child.pid === undefined) return;
      try {
        Promise.resolve(killProcessTree(child.pid, signal)).catch(() => false);
      } catch {
        // Process-tree termination is best-effort; hard settlement stays bounded.
      }
    };
    const forceKill = () => {
      forceKillSettlementHandle = setTimeout(
        () => settle({ code: undefined, signal: 'SIGKILL', error: undefined }),
        input.forceKillSettlementMs ?? FORCE_KILL_SETTLEMENT_MS,
      );
      child.stdout?.destroy();
      child.stderr?.destroy();
      try {
        child.kill('SIGKILL');
      } catch {
        // The root may already have exited; still escalate across its known tree.
      }
      signalTree('SIGKILL');
    };
    const beginTermination = () => {
      timedOut = true;
      terminationHandle = setTimeout(forceKill, input.terminationGraceMs ?? TERMINATION_GRACE_MS);
      signalTree('SIGTERM');
    };
    function onError(error) {
      settle({ code: undefined, signal: undefined, error });
    }
    function onClose(code, signal) {
      settle({ code, signal, error: undefined });
    }

    child.once('error', onError);
    // `close` follows stdio closure, preserving complete bounded output tails.
    child.once('close', onClose);
    if (input.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(beginTermination, input.timeoutMs);
    }
  });

  if (sampleHandle !== undefined) clearInterval(sampleHandle);
  await sample();

  const completedAt = new Date().toISOString();
  const durationMs = Math.round(performance.now() - start);
  return {
    command: input.command,
    cwd: input.cwd,
    startedAt,
    completedAt,
    status: exit.code ?? (exit.signal === undefined ? 1 : 128),
    signal: exit.signal ?? undefined,
    error: exit.error === undefined ? undefined : String(exit.error.message ?? exit.error),
    timedOut,
    durationMs,
    maxRssBytes,
    stdoutTail: stdout.toString(),
    stderrTail: stderr.toString(),
  };
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
