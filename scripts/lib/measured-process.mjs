/**
 * @fileoverview One reusable, bounded, shell-free measured-process substrate.
 *
 * This module is the SINGLE home for the generic child-process machinery that
 * both the performance benchmarks (`scripts/perf/*`) and the platform-acceptance
 * runner (`scripts/platform-acceptance/*`) depend on:
 *   - process-tree RSS sampling + POSIX/Windows tree termination
 *     (formerly `scripts/perf/process-tree-rss.mjs`),
 *   - the parent-signal coordinator + per-child terminator
 *     (formerly `scripts/perf/child-process-lifecycle.mjs`),
 *   - byte-ring output tails + the timed, RSS-sampled run loop `runMeasuredCommand`
 *     (formerly `scripts/perf/run-command.mjs`), and
 *   - the injectable `MeasuredProcessPort` / `runMeasuredProcess` used by journey
 *     executors, whose spec/result match `journey-catalog.d.mts` VERBATIM.
 *
 * The three `scripts/perf/*` files are now narrow re-export shims over this
 * module, so every existing benchmark import and behavior is preserved while
 * platform acceptance depends on `scripts/lib/` rather than on benchmark
 * ownership. This file is NOT exported from any workspace package; it stays a
 * repository script (dependency-free apart from Node built-ins).
 *
 * Hard rules:
 *   - Never `shell: true`; commands are argv arrays, `argv[0]` the resolved
 *     executable. `runMeasuredProcess` never accepts a shell command string.
 *   - Output is bounded (tails + an optional capture prefix).
 *   - RSS is a TAGGED measurement: `{ status:'available', peakBytes }` only after
 *     a valid sample, else `{ status:'unavailable', reasonCode }`. An absent
 *     sample is NEVER coerced to zero.
 *   - RSS sampling is platform-dependent (POSIX `ps`; unsupported on Windows).
 *     Tree termination preserves the POSIX + Windows behavior it always had.
 *
 * @typedef {import('../platform-acceptance/journey-catalog.d.mts').MeasuredProcessRunSpec} MeasuredProcessRunSpec
 * @typedef {import('../platform-acceptance/journey-catalog.d.mts').MeasuredProcessResult} MeasuredProcessResult
 * @typedef {import('../platform-acceptance/journey-catalog.d.mts').MeasuredProcessPort} MeasuredProcessPort
 * @typedef {import('../platform-acceptance/journey-catalog.d.mts').RssMeasurement} RssMeasurement
 */

import { execFile, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

// ===========================================================================
// Section 1 — process-tree RSS sampling + tree termination
// (formerly scripts/perf/process-tree-rss.mjs)
// ===========================================================================

const execFileAsync = promisify(execFile);
const PROCESS_TABLE_TIMEOUT_MS = 1000;
const PROCESS_TREE_KILL_TIMEOUT_MS = 1000;

export async function readProcessTable(options = {}) {
  if ((options.platform ?? process.platform) === 'win32') return [];
  const execute = options.execFileAsync ?? execFileAsync;
  const timeoutMs = options.timeoutMs ?? PROCESS_TABLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('process table timeout must be a positive safe integer');
  }
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,rss='], {
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
  });
  return parseProcessTable(stdout);
}

export function parseProcessTable(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidRaw, ppidRaw, rssRaw] = line.split(/\s+/);
      return {
        pid: Number.parseInt(pidRaw ?? '', 10),
        ppid: Number.parseInt(ppidRaw ?? '', 10),
        rssBytes: Number.parseInt(rssRaw ?? '', 10) * 1024,
      };
    })
    .filter(
      (row) =>
        Number.isInteger(row.pid) && Number.isInteger(row.ppid) && Number.isFinite(row.rssBytes),
    );
}

export function sumProcessTreeRss(rows, rootPid) {
  const childrenByParent = new Map();
  const rowsByPid = new Map();
  for (const row of rows) {
    rowsByPid.set(row.pid, row);
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }

  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const row = rowsByPid.get(pid);
    if (row !== undefined) total += row.rssBytes;
    for (const child of childrenByParent.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }
  return total;
}

/** Capture the current descendants while the root still owns their parent links. */
export async function captureProcessDescendants(rootPid, options = {}) {
  requirePositivePid(rootPid);
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return [];
  const rows = await readProcessTable({
    execFileAsync: options.execFileAsync,
    platform,
    timeoutMs: options.timeoutMs,
  });
  return processDescendantsFromTable(rows, rootPid);
}

/** Project a captured process table into the descendants of one live root. */
export function processDescendantsFromTable(rows, rootPid) {
  requirePositivePid(rootPid);
  return collectDescendants(rows, rootPid);
}

/** Best-effort signal of a previously captured PID set, deepest descendants first. */
export function signalCapturedProcesses(processIds, signal = 'SIGTERM', options = {}) {
  const killProcess = options.killProcess ?? process.kill;
  for (const pid of [...processIds].toReversed()) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      // A captured descendant may itself lead a detached process group. Signal
      // that group first so children created just after the snapshot cannot escape.
      killProcess(-pid, signal);
      continue;
    } catch {
      // Most descendants are not group leaders; fall through to their exact PID.
    }
    try {
      killProcess(pid, signal);
    } catch {
      // A captured process may already have exited; escalation remains best-effort.
    }
  }
}

export async function killProcessTree(rootPid, signal = 'SIGTERM', options = {}) {
  requirePositivePid(rootPid);
  const platform = options.platform ?? process.platform;
  const killProcess = options.killProcess ?? process.kill;
  if (platform === 'win32') {
    const execute = options.execFileAsync ?? execFileAsync;
    try {
      await execute('taskkill', ['/pid', String(rootPid), '/t', '/f'], {
        killSignal: 'SIGKILL',
        timeout: options.timeoutMs ?? PROCESS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
      });
      return true;
    } catch {
      try {
        killProcess(rootPid, signal);
      } catch {
        // taskkill and direct root termination are both best-effort.
      }
      return false;
    }
  }
  const descendants = await captureProcessDescendants(rootPid, {
    execFileAsync: options.execFileAsync,
    platform,
    timeoutMs: options.timeoutMs,
  }).catch(() => []);
  signalCapturedProcesses(descendants, signal, { killProcess });
  try {
    killProcess(rootPid, signal);
  } catch {
    // The root may already have exited; timeout cleanup is best-effort.
  }
  return true;
}

function requirePositivePid(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    throw new RangeError('process tree root PID must be a positive safe integer');
  }
}

function collectDescendants(rows, rootPid) {
  const childrenByParent = new Map();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return out;
}

// ===========================================================================
// Section 2 — parent-signal coordination + per-child terminator
// (formerly scripts/perf/child-process-lifecycle.mjs)
// ===========================================================================

const PARENT_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);
const DEFAULT_PARENT_SIGNAL_CLEANUP_TIMEOUT_MS = 3000;

/**
 * Coordinate process-level interruption across every currently running child.
 * The real coordinator re-raises the signal only after bounded child cleanup;
 * tests can provide an EventEmitter-like source and a harmless re-raise seam.
 */
export function createParentSignalCoordinator(options = {}) {
  const signalSource = options.signalSource ?? process;
  const reraiseSignal = options.reraiseSignal ?? ((signal) => process.kill(process.pid, signal));
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_PARENT_SIGNAL_CLEANUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new RangeError('parent signal cleanup timeout must be a positive safe integer');
  }

  const cleanups = new Map();
  let attached = false;
  let handlingSignal = false;
  let activeSignal;
  let cleanupDeadline;
  let pendingCleanups = 0;
  let relayScheduled = false;
  let relayed = false;
  let nextId = 1;

  const listeners = new Map(PARENT_SIGNALS.map((signal) => [signal, () => handleSignal(signal)]));

  const attach = () => {
    if (attached) return;
    for (const [signal, listener] of listeners) signalSource.on(signal, listener);
    attached = true;
  };
  const detach = () => {
    if (!attached) return;
    for (const [signal, listener] of listeners) signalSource.off(signal, listener);
    attached = false;
  };
  const relay = () => {
    if (relayed || activeSignal === undefined) return;
    relayed = true;
    clearTimeout(cleanupDeadline);
    detach();
    reraiseSignal(activeSignal);
  };
  const scheduleRelay = () => {
    if (!handlingSignal || relayed || pendingCleanups !== 0 || relayScheduled) return;
    relayScheduled = true;
    queueMicrotask(() => {
      relayScheduled = false;
      if (pendingCleanups === 0) relay();
    });
  };
  const invokeCleanup = (cleanup, signal) => {
    if (relayed) {
      try {
        Promise.resolve(cleanup(signal)).catch(() => false);
      } catch {
        // The original signal has already been relayed; late cleanup is best-effort.
      }
      return;
    }
    pendingCleanups += 1;
    let result;
    try {
      result = cleanup(signal);
    } catch {
      result = false;
    }
    Promise.resolve(result)
      .catch(() => false)
      .finally(() => {
        pendingCleanups -= 1;
        scheduleRelay();
      });
  };
  const handleSignal = (signal) => {
    if (handlingSignal) return;
    handlingSignal = true;
    activeSignal = signal;
    cleanupDeadline = setTimeout(relay, cleanupTimeoutMs);
    for (const cleanup of [...cleanups.values()]) invokeCleanup(cleanup, signal);
    scheduleRelay();
  };

  return Object.freeze({
    register(cleanup) {
      if (typeof cleanup !== 'function') {
        throw new TypeError('parent signal cleanup must be a function');
      }
      if (handlingSignal && activeSignal !== undefined) {
        invokeCleanup(cleanup, activeSignal);
        return Function.prototype;
      }
      const id = nextId;
      nextId += 1;
      cleanups.set(id, cleanup);
      attach();
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        cleanups.delete(id);
        if (cleanups.size === 0 && !handlingSignal) detach();
      };
    },
  });
}

/** Reserve parent-signal cleanup before spawning, then activate it after child setup. */
export function reserveParentSignalCleanup(coordinator) {
  let activeCleanup;
  let activeSignal;
  let cleanupStarted = false;
  let completed = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const startCleanup = () => {
    if (cleanupStarted || activeCleanup === undefined || activeSignal === undefined) return;
    cleanupStarted = true;
    try {
      Promise.resolve(activeCleanup(activeSignal)).catch(() => false);
    } catch {
      // The coordinator still observes completion through the reservation promise.
    }
  };
  const unregister = coordinator.register((signal) => {
    activeSignal ??= signal;
    startCleanup();
    return completion;
  });

  return Object.freeze({
    activate(cleanup) {
      if (typeof cleanup !== 'function') {
        throw new TypeError('reserved parent signal cleanup must be a function');
      }
      if (activeCleanup !== undefined) {
        throw new Error('reserved parent signal cleanup is already active');
      }
      activeCleanup = cleanup;
      startCleanup();
    },
    complete() {
      if (completed) return;
      completed = true;
      unregister();
      resolveCompletion();
    },
    interrupted() {
      return activeSignal !== undefined;
    },
    signal() {
      return activeSignal;
    },
  });
}

/** Build a retained-descendant terminator for one spawned child process. */
export function createChildProcessTerminator(input) {
  const captureProcessDescendantsImpl =
    input.captureProcessDescendants ?? captureProcessDescendants;
  const killProcessTreeImpl = input.killProcessTree ?? killProcessTree;
  const killProcess = input.killProcess ?? process.kill;
  const platform = input.platform ?? process.platform;
  const retainedDescendants = new Set();
  let captureInFlight;
  let disposed = false;
  let rootClosed = false;

  const retain = (processIds, rootPid, preservePrevious = rootClosed) => {
    const observed = new Set();
    for (const pid of processIds) {
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== rootPid) {
        observed.add(pid);
      }
    }
    if (!preservePrevious) retainedDescendants.clear();
    for (const pid of observed) retainedDescendants.add(pid);
  };

  const capture = () => {
    if (disposed) return Promise.resolve();
    const rootPid = input.child.pid;
    if (rootPid === undefined || platform === 'win32') return Promise.resolve();
    if (captureInFlight !== undefined) return captureInFlight;
    captureInFlight = Promise.resolve()
      .then(() => captureProcessDescendantsImpl(rootPid, { platform }))
      .then((processIds) => {
        if (disposed) return;
        retain(processIds, rootPid);
      })
      .catch(() => false)
      .finally(() => {
        captureInFlight = undefined;
      });
    return captureInFlight;
  };

  const signalWindows = async (rootPid, signal) => {
    let treeTerminated;
    try {
      treeTerminated = (await killProcessTreeImpl(rootPid, signal, { platform })) !== false;
    } catch {
      treeTerminated = false;
    }
    if (treeTerminated) return;
    try {
      input.child.kill?.(signal);
    } catch {
      // taskkill and root-handle termination are both best-effort.
    }
  };

  const signalRetainedAndGroup = (rootPid, signal) => {
    signalCapturedProcesses(retainedDescendants, signal, { killProcess });
    if (!input.useProcessGroup) return false;
    try {
      killProcess(-rootPid, signal);
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    capture,
    /** Snapshot the currently retained descendant PIDs (for residual accounting). */
    retainedPids() {
      return [...retainedDescendants];
    },
    markRootClosed() {
      rootClosed = true;
    },
    observeProcessTable(rows) {
      if (disposed || platform === 'win32') return;
      const rootPid = input.child.pid;
      if (rootPid === undefined) return;
      const rootPresent = rows.some((row) => row.pid === rootPid);
      retain(processDescendantsFromTable(rows, rootPid), rootPid, rootClosed || !rootPresent);
    },
    async signal(signal) {
      if (disposed) return;
      const rootPid = input.child.pid;
      if (rootPid === undefined) return;
      if (platform === 'win32') {
        await signalWindows(rootPid, signal);
        return;
      }

      // Escalate every PID retained during the pre-termination snapshot even if
      // the root has since exited and the descendant has been reparented.
      if (signal === 'SIGKILL') {
        signalCapturedProcesses(retainedDescendants, signal, { killProcess });
      }
      await capture();
      if (disposed) return;
      if (signalRetainedAndGroup(rootPid, signal)) return;
      try {
        input.child.kill?.(signal);
      } catch {
        // The root may already have exited; retained descendants were still signalled.
      }
    },
    async signalAfterRootClose(signal = 'SIGKILL') {
      if (disposed) return;
      rootClosed = true;
      const rootPid = input.child.pid;
      if (rootPid === undefined) return;
      if (platform === 'win32') {
        // After confirmed root close, taskkill/direct PID signalling risks
        // terminating a reused PID and cannot recover reparented descendants.
        // Reliable successful-exit containment on Windows requires a Job Object.
        return;
      }
      if (captureInFlight !== undefined) await captureInFlight;
      if (disposed) return;
      signalRetainedAndGroup(rootPid, signal);
    },
    dispose() {
      disposed = true;
      retainedDescendants.clear();
    },
  });
}

export const parentSignalCoordinator = createParentSignalCoordinator();

// ===========================================================================
// Section 3 — bounded output tails + the measured run loop
// (formerly scripts/perf/run-command.mjs; additive stdin/abort/residual/RSS-reason)
// ===========================================================================

const TERMINATION_GRACE_MS = 1000;
const FORCE_KILL_SETTLEMENT_MS = 1000;
const RSS_SAMPLE_TIMEOUT_MS = 1000;

/**
 * Run one command (an argv array; NEVER a shell string), bounding output, timing
 * it, and sampling process-tree RSS. Preserves its historical result shape for
 * benchmark callers and ADDS (additive, ignorable) `cancelled`,
 * `residualDescendants`, and `rssUnavailableReason` fields plus optional
 * `stdin` / `abortSignal` / `trackResidualDescendants` inputs used by the
 * platform-acceptance port.
 */
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
  let cancelled = false;
  let timeoutHandle;
  let terminationHandle;
  let forceKillSettlementHandle;
  let sampleHandle;
  let sampleInFlight;
  let samplingDisabled = false;
  let commandCompletedAt;
  let commandDurationMs;
  // RSS-availability tracking (never coerce an absent sample to zero).
  let anyTableRead = false;
  let rssTableUnavailable = false;
  let rssSamplerFault = false;
  let retainedSnapshot = [];

  const spawnChild = input.spawnChild ?? spawn;
  const useProcessGroup = input.useProcessGroup ?? process.platform !== 'win32';
  const stdinMode = input.stdin === undefined ? 'ignore' : 'pipe';
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
      stdio: [stdinMode, 'pipe', 'pipe'],
    });
  } catch (error) {
    parentReservation.complete();
    throw error;
  }
  if (input.stdin !== undefined && child.stdin) {
    // A bounded stdin payload; ignore EPIPE if the child closes its input early.
    child.stdin.on('error', () => {
      /* ignore EPIPE when the child closes its stdin early */
    });
    child.stdin.end(input.stdin);
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
          rssTableUnavailable = true;
          return;
        }
        anyTableRead = true;
        terminator.observeProcessTable(rows);
        const rss = sumProcessTreeRss(rows, child.pid);
        if (rss > 0) maxRssBytes = Math.max(maxRssBytes ?? 0, rss);
      })
      .catch(() => {
        samplingDisabled = true;
        rssSamplerFault = true;
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
      input.abortSignal?.removeEventListener('abort', onAbort);
      parentReservation.complete();
      if (input.trackResidualDescendants) retainedSnapshot = terminator.retainedPids();
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
      cancelled = reason === 'abort';
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
    function onAbort() {
      beginTermination('abort');
    }

    child.once('error', onError);
    // `close` follows stdio closure, preserving complete bounded output tails.
    child.once('close', onClose);
    parentReservation.activate(() => beginTermination('parent-signal'));
    if (input.abortSignal !== undefined) {
      if (input.abortSignal.aborted) beginTermination('abort');
      else input.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    if (input.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => beginTermination('timeout'), input.timeoutMs);
    }
  });

  // Command duration ends with the child/stdio settlement. The final best-effort
  // RSS sample below must not inflate startup or install wall-time measurements.
  if (sampleHandle !== undefined) clearInterval(sampleHandle);
  await sample();

  let residualDescendants = 0;
  if (input.trackResidualDescendants) {
    residualDescendants = await countResidualDescendants(
      retainedSnapshot,
      sampleProcessTable,
      sampleTimeoutMs,
    );
  }

  let rssUnavailableReason;
  if (maxRssBytes === undefined) {
    if (rssSamplerFault) rssUnavailableReason = RSS_REASON_CODES.SAMPLER_FAULT;
    else if (rssTableUnavailable && !anyTableRead)
      rssUnavailableReason = RSS_REASON_CODES.PROCESS_TABLE_UNAVAILABLE;
    else rssUnavailableReason = RSS_REASON_CODES.CHILD_TOO_SHORT;
  }

  return {
    command: input.command,
    cwd: input.cwd,
    startedAt,
    completedAt: commandCompletedAt,
    status: exit.code ?? (exit.signal === undefined ? 1 : 128),
    signal: exit.signal ?? undefined,
    error: exit.error === undefined ? undefined : String(exit.error.message ?? exit.error),
    timedOut,
    cancelled,
    durationMs: commandDurationMs,
    maxRssBytes,
    rssUnavailableReason,
    residualDescendants,
    stdoutTail: stdout.toString(),
    stderrTail: stderr.toString(),
    stdoutCapture: stdoutCapture?.toString(),
    stdoutTruncated: stdoutCapture?.truncated(),
  };
}

/** Count how many previously-retained descendant PIDs are still alive. */
async function countResidualDescendants(pids, readTable, timeoutMs) {
  if (pids.length === 0) return 0;
  const rows = await sampleRssWithinDeadline(readTable, timeoutMs);
  // An unverifiable final read is reported as residual — fail-closed, never a
  // silent "clean".
  if (rows === undefined) return pids.length;
  const alive = new Set();
  for (const row of rows) alive.add(row.pid);
  let count = 0;
  for (const pid of pids) if (alive.has(pid)) count += 1;
  return count;
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

// ===========================================================================
// Section 4 — the injectable MeasuredProcessPort
// (matches journey-catalog.d.mts MeasuredProcessRunSpec / MeasuredProcessResult)
// ===========================================================================

const DEFAULT_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_BYTES = 256 * 1024;
const DEFAULT_DIAGNOSTIC_TAIL_BYTES = 4096;
const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_JOURNEY_TIMEOUT_MS = 180_000;

/**
 * Stable, kebab-case reason codes for the RSS measurement's `unavailable` tag.
 * Surfaced in `MeasuredProcessResult.rss.reasonCode`.
 */
export const RSS_REASON_CODES = Object.freeze({
  UNSUPPORTED_PLATFORM: 'rss-unsupported-platform',
  PROCESS_TABLE_UNAVAILABLE: 'rss-process-table-unavailable',
  CHILD_TOO_SHORT: 'rss-child-too-short',
  SAMPLER_FAULT: 'rss-sampler-fault',
  // No measured child ran under this port yet, so there is nothing to sample.
  NOT_SAMPLED: 'rss-not-sampled',
});

/**
 * Stable, kebab-case classification of a measured invocation's overall outcome.
 * Derivable from the `MeasuredProcessResult` fields (the result carries no
 * reasonCode of its own); a journey/runner reads these to phrase a failure.
 */
export const MEASURED_PROCESS_REASON_CODES = Object.freeze({
  SPAWN_UNAVAILABLE: 'spawn-unavailable',
  COMMAND_FAILED: 'command-failed',
  TIMED_OUT: 'timed-out',
  CANCELLED: 'cancelled',
  OUTPUT_OVERFLOW: 'output-overflow',
  CLEANUP_FAILED: 'cleanup-failed',
});

/** Derive the stable outcome reason-code for a measured result, or null on clean success. */
export function classifyMeasuredOutcome(result) {
  const M = MEASURED_PROCESS_REASON_CODES;
  if (result.timedOut) return M.TIMED_OUT;
  if (result.cancelled) return M.CANCELLED;
  if (result.status === null && result.signal === null) return M.SPAWN_UNAVAILABLE;
  if (result.cleanup.residualDescendants > 0) return M.CLEANUP_FAILED;
  if (result.outputTruncated) return M.OUTPUT_OVERFLOW;
  if (result.status !== 0 || result.signal !== null) return M.COMMAND_FAILED;
  return null;
}

function toRssMeasurement(measured, platform) {
  if (platform === 'win32') {
    return Object.freeze({
      status: 'unavailable',
      reasonCode: RSS_REASON_CODES.UNSUPPORTED_PLATFORM,
    });
  }
  if (
    typeof measured.maxRssBytes === 'number' &&
    Number.isFinite(measured.maxRssBytes) &&
    measured.maxRssBytes > 0
  ) {
    return Object.freeze({ status: 'available', peakBytes: measured.maxRssBytes });
  }
  return Object.freeze({
    status: 'unavailable',
    reasonCode: measured.rssUnavailableReason ?? RSS_REASON_CODES.CHILD_TOO_SHORT,
  });
}

/** Adapt a raw `runMeasuredCommand` result into the closed `MeasuredProcessResult`. */
function toMeasuredProcessResult(measured, platform) {
  const signal = measured.signal ?? null;
  const spawnFailed = signal === null && measured.error !== undefined;
  let status = null;
  if (signal === null && !spawnFailed && typeof measured.status === 'number') {
    status = measured.status;
  }
  return Object.freeze({
    status,
    signal,
    timedOut: measured.timedOut === true,
    cancelled: measured.cancelled === true,
    outputTruncated: measured.stdoutTruncated === true,
    durationMs: typeof measured.durationMs === 'number' ? measured.durationMs : 0,
    rss: toRssMeasurement(measured, platform),
    stdoutTail: measured.stdoutTail ?? '',
    stderrTail: measured.stderrTail ?? '',
    stdoutCapture: measured.stdoutCapture ?? '',
    cleanup: Object.freeze({ residualDescendants: measured.residualDescendants ?? 0 }),
  });
}

/** Escape a single argv token for the util-linux `script -c` string form. */
function singleQuote(token) {
  return `'${String(token).replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap an argv array so the command runs attached to a pseudo-terminal via the
 * `script` utility (the same tool the host `pty` capability probes for). BSD/macOS
 * `script` takes the command as trailing argv (no shell); util-linux `script`
 * runs it through `-c`. `argv` here is trusted (journey-authored, from resolved
 * descriptors), never attacker input, and spawn stays `shell: false` either way.
 */
function buildPtyArgv(argv, platform) {
  if (platform === 'darwin') return ['script', '-q', '/dev/null', ...argv];
  return [
    'script',
    '-q',
    '-e',
    '-c',
    argv.map((token) => singleQuote(token)).join(' '),
    '/dev/null',
  ];
}

/**
 * Run one measured child from a `MeasuredProcessRunSpec`. NEVER accepts a shell
 * command string: `spec.argv` is an array and `argv[0]` is the resolved
 * executable. `ctx` carries the port's deterministic base env, the active
 * profile bounds (used as defaults), the platform, an optional runner-level
 * abort signal, and injectable child seams for tests.
 *
 * @param {MeasuredProcessRunSpec} spec
 * @returns {Promise<MeasuredProcessResult>}
 */
export async function runMeasuredProcess(spec, ctx = {}) {
  if (spec === null || typeof spec !== 'object') {
    throw new TypeError('runMeasuredProcess requires a spec object');
  }
  const argv = spec.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('runMeasuredProcess requires a non-empty argv array');
  }
  if (typeof argv[0] !== 'string' || argv[0].length === 0) {
    throw new TypeError('runMeasuredProcess argv[0] must be the resolved executable path');
  }
  for (const token of argv) {
    if (typeof token !== 'string') throw new TypeError('every argv token must be a string');
  }
  if (typeof spec.cwd !== 'string' || spec.cwd.length === 0) {
    throw new TypeError('runMeasuredProcess requires a cwd');
  }

  const bounds = ctx.bounds ?? {};
  const platform = ctx.platform ?? process.platform;
  const timeoutMs = spec.timeoutMs ?? bounds.journeyTimeoutMs ?? DEFAULT_JOURNEY_TIMEOUT_MS;
  const stdoutBytes = spec.stdoutBytes ?? bounds.maxStdoutBytes ?? DEFAULT_STDOUT_BYTES;
  const stderrBytes = spec.stderrBytes ?? bounds.maxStderrBytes ?? DEFAULT_STDERR_BYTES;
  const diagnosticTailBytes = bounds.maxDiagnosticTailBytes ?? DEFAULT_DIAGNOSTIC_TAIL_BYTES;
  const sampleIntervalMs =
    spec.rssSampleIntervalMs ?? bounds.rssSampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const env = { ...ctx.baseEnv, ...spec.env };

  const commandArgv = spec.pty === true ? buildPtyArgv([...argv], platform) : [...argv];
  const abortSignal = combineSignals(spec.signal, ctx.runSignal);

  const measured = await runMeasuredCommand({
    command: commandArgv,
    cwd: spec.cwd,
    env,
    timeoutMs,
    sampleIntervalMs,
    stdoutTailBytes: Math.min(stdoutBytes, diagnosticTailBytes),
    stderrTailBytes: Math.min(stderrBytes, diagnosticTailBytes),
    stdoutCaptureBytes: stdoutBytes,
    stdin: spec.stdin,
    abortSignal,
    trackResidualDescendants: true,
    platform: ctx.platform,
    spawnChild: ctx.spawnChild,
    readProcessTable: ctx.readProcessTable,
    captureProcessDescendants: ctx.captureProcessDescendants,
    killProcess: ctx.killProcess,
    killProcessTree: ctx.killProcessTree,
    parentSignalCoordinator: ctx.parentSignalCoordinator,
    rssSampleTimeoutMs: ctx.rssSampleTimeoutMs,
  });

  return toMeasuredProcessResult(measured, platform);
}

/** Combine an optional per-run signal with an optional runner-level signal. */
function combineSignals(specSignal, runSignal) {
  const signals = [specSignal, runSignal].filter((s) => s !== undefined && s !== null);
  if (signals.length === 0) return;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * Build an injectable `MeasuredProcessPort`. `run(spec)` returns a
 * `MeasuredProcessResult`. The port owns the deterministic base env, the profile
 * bounds (defaults for omitted spec bounds), the platform, and an optional
 * runner-level abort signal that cancels every in-flight child.
 *
 * @returns {MeasuredProcessPort}
 */
export function createMeasuredProcessPort(options = {}) {
  const ctx = {
    baseEnv: options.baseEnv ?? {},
    bounds: options.bounds ?? {},
    platform: options.platform,
    runSignal: options.runSignal,
    ...options.deps,
  };
  // Accumulate the peak resident-set size across every child this port drives.
  // The runner creates one port per journey, so `rssMeasurement()` reports that
  // journey's peak — the max of each run's tagged RSS. It is `available` only
  // once at least one child yields a real sample; a bare peak of 0 never
  // masquerades as a measurement (the tagged-RSS invariant).
  let peakBytes = 0;
  let sawAvailable = false;
  let lastUnavailableReason = RSS_REASON_CODES.NOT_SAMPLED;
  return Object.freeze({
    async run(spec) {
      const result = await runMeasuredProcess(spec, ctx);
      const rss = result.rss;
      if (rss?.status === 'available') {
        sawAvailable = true;
        if (rss.peakBytes > peakBytes) peakBytes = rss.peakBytes;
      } else if (rss?.status === 'unavailable') {
        lastUnavailableReason = rss.reasonCode;
      }
      return result;
    },
    rssMeasurement() {
      if (sawAvailable) return Object.freeze({ status: 'available', peakBytes });
      return Object.freeze({ status: 'unavailable', reasonCode: lastUnavailableReason });
    },
  });
}
