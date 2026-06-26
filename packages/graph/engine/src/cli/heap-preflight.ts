/**
 * Heap-size preflight — auto-elevates Node's `--max-old-space-size`
 * to match the repo's size before any heavy work runs.
 *
 * V8 fixes the heap cap at process startup; we can't change it
 * mid-flight. So the only safe way to "auto-set" the heap is to
 * re-exec the process with the right `NODE_OPTIONS` and let the
 * child do the actual work. We guard re-exec with the
 * `OPENSIP_HEAP_ELEVATED` sentinel so the child doesn't loop back into
 * the preflight check.
 *
 * Policy:
 *   - >2500 source files → target 12288 MB cap
 *   - >1000 source files → target 8192 MB cap
 *   - otherwise → keep default (V8's ~4 GB)
 *
 * If total system RAM can't comfortably hold the elevated heap
 * (heap + 2 GB OS headroom), we warn the user and continue at the
 * current heap. The pressure monitor catches the impending OOM
 * gracefully — better than tanking the whole machine into swap.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import v8 from 'node:v8';

import { createToolLogger } from '@opensip-cli/core';

import { pickAdapter } from '../lang-adapter/registry.js';

const log = createToolLogger('graph:cli');

const SENTINEL_ENV = 'OPENSIP_HEAP_ELEVATED';
const OS_HEADROOM_MB = 2048; // RAM we keep available for the OS + other apps.
const BYTES_PER_MB = 1024 * 1024;

export interface HeapTarget {
  readonly fileThreshold: number;
  readonly heapMb: number;
}

/** Heap targets in descending order of file threshold. */
export const HEAP_TARGETS: readonly HeapTarget[] = [
  { fileThreshold: 2500, heapMb: 12_288 },
  { fileThreshold: 1000, heapMb: 8192 },
];

export interface PreflightInput {
  readonly cwd: string;
  /** Optional override for the adapter's config-file path. */
  readonly configPathOverride?: string;
  /**
   * When true, print the human-facing "elevating heap" line to stderr. Off
   * by default: the elevation is silent unless `graph --verbose` asked for
   * detail. The structured `graph.heap.preflight.elevate` log is emitted
   * either way, so telemetry / log consumers lose nothing when it's off.
   */
  readonly verbose?: boolean;
}

/**
 * Decide the target heap (in MB) for a given file count, or `null` if
 * the default V8 heap is sufficient.
 */
export function decideHeapTargetMb(fileCount: number): number | null {
  for (const target of HEAP_TARGETS) {
    if (fileCount > target.fileThreshold) return target.heapMb;
  }
  return null;
}

/**
 * Current V8 heap cap in MB. Reads from `v8.getHeapStatistics()` so it
 * reflects whatever `--max-old-space-size` was set to at boot (including
 * the default).
 */
function currentHeapLimitMb(): number {
  return Math.round(v8.getHeapStatistics().heap_size_limit / BYTES_PER_MB);
}

/** Total system RAM in MB. */
export function totalSystemMemoryMb(): number {
  return Math.round(os.totalmem() / BYTES_PER_MB);
}

/**
 * Whether the system has room for a heap of `targetMb` plus
 * `OS_HEADROOM_MB` for everything else.
 */
export function systemHasMemoryFor(targetMb: number): boolean {
  return totalSystemMemoryMb() >= targetMb + OS_HEADROOM_MB;
}

/**
 * Run preflight. Returns `false` to indicate the caller should
 * continue normally; `true` means we are re-execing and the caller
 * should not proceed (process will exit shortly via the spawned child).
 *
 * The promise that resolves to `true` actually never resolves in
 * practice — the parent process exits when the child does. But TS
 * needs a return type for callers that want to short-circuit.
 */
export async function runHeapPreflight(input: PreflightInput): Promise<boolean> {
  if (process.env[SENTINEL_ENV] === '1') {
    // We are the elevated child. Do nothing.
    return false;
  }

  const adapter = pickAdapter(input.cwd);
  const discovery = adapter.discoverFiles({
    cwd: input.cwd,
    configPathOverride: input.configPathOverride,
  });
  const fileCount = discovery.files.length;
  const targetMb = decideHeapTargetMb(fileCount);
  if (targetMb === null) {
    log.info({
      evt: 'graph.heap.preflight.skip',
      module: 'graph:cli',
      fileCount,
      reason: 'below-threshold',
    });
    return false;
  }

  const currentMb = currentHeapLimitMb();
  if (currentMb >= targetMb) {
    log.info({
      evt: 'graph.heap.preflight.skip',
      module: 'graph:cli',
      fileCount,
      targetMb,
      currentMb,
      reason: 'already-elevated',
    });
    return false;
  }

  if (!systemHasMemoryFor(targetMb)) {
    const totalMb = totalSystemMemoryMb();
    log.warn({
      evt: 'graph.heap.preflight.insufficient',
      module: 'graph:cli',
      fileCount,
      targetMb,
      totalSystemMb: totalMb,
    });
    process.stderr.write(
      `graph: detected ${String(fileCount)} files; would elevate heap to ${String(targetMb)} MB, ` +
        `but system has only ${String(totalMb)} MB RAM (need ~${String(targetMb + OS_HEADROOM_MB)} MB).\n` +
        `Continuing with current heap (${String(currentMb)} MB cap). If the run aborts, try ` +
        `\`opensip graph <path>\` or \`opensip graph --workspace\` to scope the run.\n`,
    );
    return false;
  }

  /* v8 ignore start */
  await reExecWithHeap(targetMb, fileCount, currentMb, input.verbose === true);
  return true;
  /* v8 ignore stop */
}

/**
 * Re-exec the current Node process with an elevated
 * `--max-old-space-size`. stdio is inherited so the child writes
 * directly to the user's terminal; the parent waits and propagates
 * the child's exit code.
 */
/* v8 ignore start */
async function reExecWithHeap(
  targetMb: number,
  fileCount: number,
  currentMb: number,
  verbose: boolean,
): Promise<void> {
  const flag = `--max-old-space-size=${String(targetMb)}`;
  const existingNodeOptions = process.env.NODE_OPTIONS ?? '';
  const mergedNodeOptions =
    existingNodeOptions.length > 0 ? `${existingNodeOptions} ${flag}` : flag;

  // Structured log always fires — telemetry/log consumers see every
  // elevation regardless of verbosity.
  log.info({
    evt: 'graph.heap.preflight.elevate',
    module: 'graph:cli',
    fileCount,
    targetMb,
    currentMb,
  });
  // Human-facing line only under --verbose: silent heap elevation keeps the
  // default output clean (the re-exec is an implementation detail).
  if (verbose) {
    process.stderr.write(
      `graph: ${String(fileCount)} files detected — elevating heap to ${String(targetMb)} MB ` +
        `(was ${String(currentMb)} MB).\n`,
    );
  }

  const child = spawn(process.execPath, process.argv.slice(1), {
    env: {
      ...process.env,
      NODE_OPTIONS: mergedNodeOptions,
      [SENTINEL_ENV]: '1',
    },
    stdio: 'inherit',
  });

  await new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        // process.kill is async at the syscall layer; in the rare race
        // where it doesn't deliver, fall through to a clean exit.
        resolve();
        return;
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
/* v8 ignore stop */
