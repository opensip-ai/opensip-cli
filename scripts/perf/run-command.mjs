import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { killProcessTree, readProcessTable, sumProcessTreeRss } from './process-tree-rss.mjs';

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
  let sampleHandle;

  const child = spawn(command, args, {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => stdout.push(chunk));
  child.stderr?.on('data', (chunk) => stderr.push(chunk));

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

  if (input.timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void killProcessTree(child.pid);
    }, input.timeoutMs);
  }

  const exit = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: undefined, signal: undefined, error }));
    child.on('exit', (code, signal) => resolve({ code, signal, error: undefined }));
  });

  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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
