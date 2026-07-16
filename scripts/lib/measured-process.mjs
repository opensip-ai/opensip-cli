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
 *   - POSIX cleanup reports zero only when no retained descendant identity is
 *     present in the final sampled process table and every observation succeeded.
 *     This is cleanup assistance for trusted release behavior, not OS containment:
 *     a process can deliberately create a new session and reparent between samples.
 *     Windows cannot claim this capability until Job Object containment exists.
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
const DECIMAL_INTEGER = /^\d+$/;

export async function readProcessTable(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return [];
  const execute = options.execFileAsync ?? execFileAsync;
  const timeoutMs = options.timeoutMs ?? PROCESS_TABLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('process table timeout must be a positive safe integer');
  }
  // Qualification must not trust a repository- or package-manager-prepended
  // PATH for process evidence. Use the fixed native location on the two hosts
  // this harness currently measures.
  const psCommand = platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps';
  const { stdout } = await execute(
    psCommand,
    ['-eo', 'pid=,ppid=,pgid=,sess=,lstart=,rss=,ucomm='],
    {
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
    },
  );
  return parseProcessTable(stdout);
}

export function parseProcessTable(stdout) {
  if (typeof stdout !== 'string') throw new TypeError('process table output must be a string');
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new TypeError('process table output was empty');
  return lines.map((line, index) => {
    // Both Darwin and procps `lstart` occupy five whitespace-delimited tokens.
    // `ucomm` is last; retain the remainder defensively across ps implementations.
    const fields = line.split(/\s+/);
    if (fields.length < 11) {
      throw new TypeError(`process table line ${index + 1} is malformed`);
    }
    const [pidRaw, ppidRaw, processGroupIdRaw, sessionTokenRaw, ...tail] = fields;
    const startedAtRaw = tail.slice(0, 5).join(' ');
    const rssRaw = tail[5];
    const commandRaw = tail.slice(6).join(' ');
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const processGroupId = Number(processGroupIdRaw);
    const sessionToken = sessionTokenRaw.trim();
    const startedAt = startedAtRaw.trim();
    const rssKiB = Number(rssRaw);
    const command = commandRaw.trim();
    if (
      !Number.isSafeInteger(pid) ||
      !DECIMAL_INTEGER.test(pidRaw) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      !DECIMAL_INTEGER.test(ppidRaw) ||
      ppid < 0 ||
      !Number.isSafeInteger(processGroupId) ||
      !DECIMAL_INTEGER.test(processGroupIdRaw) ||
      processGroupId <= 0 ||
      sessionToken.length === 0 ||
      startedAt.length === 0 ||
      !Number.isSafeInteger(rssKiB) ||
      !DECIMAL_INTEGER.test(rssRaw) ||
      rssKiB < 0 ||
      !Number.isSafeInteger(rssKiB * 1024) ||
      command.length === 0
    ) {
      throw new TypeError(`process table line ${index + 1} is out of range`);
    }
    return {
      pid,
      ppid,
      processGroupId,
      sessionToken,
      startedAt,
      command,
      rssBytes: rssKiB * 1024,
    };
  });
}

function validateProcessRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('process table sample must be an array');
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== 'object' ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0 ||
      !Number.isSafeInteger(row.ppid) ||
      row.ppid < 0 ||
      !Number.isSafeInteger(row.processGroupId) ||
      row.processGroupId <= 0 ||
      typeof row.sessionToken !== 'string' ||
      row.sessionToken.length === 0 ||
      typeof row.startedAt !== 'string' ||
      row.startedAt.length === 0 ||
      typeof row.command !== 'string' ||
      row.command.length === 0 ||
      !Number.isSafeInteger(row.rssBytes) ||
      row.rssBytes < 0
    ) {
      throw new TypeError('process table sample contains a malformed row');
    }
  }
  return rows;
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

/** Project a captured process table into the descendants of one live root. */
export function processDescendantsFromTable(rows, rootPid) {
  requirePositivePid(rootPid);
  return collectDescendants(rows, rootPid);
}

function sameProcessIdentity(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pid === right.pid &&
    left.processGroupId === right.processGroupId &&
    left.sessionToken === right.sessionToken &&
    left.startedAt === right.startedAt
  );
}

function processIdentityKey(identity) {
  return JSON.stringify([
    identity.pid,
    identity.processGroupId,
    identity.sessionToken,
    identity.startedAt,
  ]);
}

/**
 * Signal retained identities only while a fresh process-table row still matches
 * their PID, process-group id, native `sess` token, and start token. `ucomm` is
 * retained as bounded metadata but is not identity: a legitimate exec or process
 * title update can change it while the kernel process remains the same.
 * Group signals are issued only for groups with a currently matching retained
 * member. The native start token has one-second resolution, so even the complete
 * tuple reduces rather than eliminates theoretical PID-reuse collisions.
 */
export function signalCapturedProcesses(processIdentities, signal = 'SIGTERM', options = {}) {
  const killProcess = options.killProcess ?? process.kill;
  const rows = validateProcessRows(options.currentRows ?? []);
  const currentByPid = new Map(rows.map((row) => [row.pid, row]));
  const alive = [...processIdentities].filter((identity) =>
    sameProcessIdentity(identity, currentByPid.get(identity?.pid)),
  );
  const signalledGroups = new Set();
  let delivered = false;
  if (options.useProcessGroups !== false) {
    for (const identity of alive.toReversed()) {
      const groupId = identity.processGroupId;
      if (signalledGroups.has(groupId)) continue;
      try {
        killProcess(-groupId, signal);
        signalledGroups.add(groupId);
        delivered = true;
        continue;
      } catch {
        // A fresh exact-identity signal below remains the bounded fallback.
      }
    }
  }
  for (const identity of alive.toReversed()) {
    if (signalledGroups.has(identity.processGroupId)) continue;
    try {
      killProcess(identity.pid, signal);
      delivered = true;
    } catch {
      // The identity may have exited after the fresh inventory.
    }
  }
  return delivered;
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
  let rows;
  try {
    rows = await readProcessTable({
      execFileAsync: options.execFileAsync,
      platform,
      timeoutMs: options.timeoutMs,
    });
  } catch {
    return false;
  }
  const descendants = processDescendantsFromTable(rows, rootPid);
  signalCapturedProcesses(descendants, signal, {
    currentRows: rows,
    killProcess,
  });
  const root = rows.find((row) => row.pid === rootPid);
  if (root !== undefined) {
    signalCapturedProcesses([root], signal, { currentRows: rows, killProcess });
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
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const row = stack.pop();
    if (row === undefined || seen.has(row.pid)) continue;
    seen.add(row.pid);
    out.push(row);
    stack.push(...(childrenByParent.get(row.pid) ?? []));
  }
  return out;
}

// ===========================================================================
// Section 2 — parent-signal coordination + per-child terminator
// (formerly scripts/perf/child-process-lifecycle.mjs)
// ===========================================================================

const PARENT_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);
// The MCP shutdown path performs bounded TERM -> KILL -> stdio -> final process
// inventory settlement. Keep the coordinator deadline above that composed bound.
const DEFAULT_PARENT_SIGNAL_CLEANUP_TIMEOUT_MS = 4000;

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

/**
 * Build a retained-descendant terminator for one spawned child process.
 *
 * POSIX identities are learned from bounded process-table samples. A clean result
 * means zero retained `(pid, pgid, session, lstart)` tuples matched the final
 * sample and every observation succeeded; it does not prove OS containment
 * against an escape between samples. Because `lstart` has one-second resolution,
 * a same-second PID reuse with every other tuple fact identical remains a
 * documented collision limit.
 */
export function createChildProcessTerminator(input) {
  const killProcessTreeImpl = input.killProcessTree ?? killProcessTree;
  const killProcess = input.killProcess ?? process.kill;
  const platform = input.platform ?? process.platform;
  const readProcessTableImpl = input.readProcessTable ?? readProcessTable;
  const retainedDescendants = new Map();
  const directChildren = new Map();
  let captureInFlight;
  let disposed = false;
  let observationFailed = platform === 'win32';
  let observedTable = false;
  let rootIdentity;
  let rootClosed = false;

  const markObservationFailure = () => {
    observationFailed = true;
  };

  const retain = (identities, rootPid) => {
    for (const identity of identities) {
      if (identity.pid !== rootPid) {
        retainedDescendants.set(processIdentityKey(identity), identity);
      }
    }
  };

  const observeProcessTable = (rawRows) => {
    if (disposed || platform === 'win32') return [];
    const rows = validateProcessRows(rawRows);
    observedTable = true;
    const rootPid = input.child.pid;
    if (rootPid === undefined) return rows;
    const root = rows.find((row) => row.pid === rootPid);
    if (root !== undefined) {
      if (rootIdentity === undefined) rootIdentity = root;
      else if (!sameProcessIdentity(rootIdentity, root)) {
        // After the child has closed, a mismatching row at the same PID is a
        // reused identity, not evidence that process-table observation failed.
        // Never traverse or signal through that unrelated replacement. While
        // the root is still expected to be live, however, an identity change is
        // ambiguous (for example a too-early pre-exec sample), so fail closed.
        if (!rootClosed) observationFailed = true;
        return rows;
      }
      if (!rootClosed) {
        directChildren.clear();
        for (const row of rows) {
          if (row.ppid === rootPid && row.pid !== rootPid) {
            directChildren.set(processIdentityKey(row), row);
          }
        }
      }
      retain(processDescendantsFromTable(rows, rootPid), rootPid);
    }
    return rows;
  };

  const capture = () => {
    if (disposed) return Promise.resolve();
    const rootPid = input.child.pid;
    if (rootPid === undefined || platform === 'win32') {
      markObservationFailure();
      return Promise.resolve();
    }
    if (captureInFlight !== undefined) return captureInFlight;
    captureInFlight = sampleRssWithinDeadline(
      () => readProcessTableImpl({ platform }),
      input.rssSampleTimeoutMs ?? RSS_SAMPLE_TIMEOUT_MS,
    )
      .then((rows) => {
        if (disposed) return;
        if (rows === undefined) {
          markObservationFailure();
          return;
        }
        try {
          return observeProcessTable(rows);
        } catch {
          markObservationFailure();
          return;
        }
      })
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
    if (treeTerminated) return true;
    try {
      return input.child.kill?.(signal) !== false;
    } catch {
      // taskkill and root-handle termination are both best-effort.
      return false;
    }
  };

  const signalRetainedAndRoot = (rows, signal, includeRoot) => {
    const identities = [...retainedDescendants.values()];
    if (includeRoot && rootIdentity !== undefined && input.useProcessGroup !== false) {
      identities.push(rootIdentity);
    }
    let delivered = signalCapturedProcesses(identities, signal, {
      currentRows: rows,
      killProcess,
      useProcessGroups: input.useProcessGroup !== false,
    });
    if (
      includeRoot &&
      input.useProcessGroup === false &&
      rootIdentity !== undefined &&
      sameProcessIdentity(
        rootIdentity,
        rows.find((row) => row.pid === rootIdentity.pid),
      )
    ) {
      try {
        delivered = input.child.kill?.(signal) !== false || delivered;
      } catch {
        // The freshly matched root may still exit before the handle signal.
      }
    }
    return delivered;
  };

  return Object.freeze({
    capture,
    markObservationFailure,
    reliable() {
      return observedTable && !observationFailed;
    },
    /** Snapshot retained immutable identities for diagnostics/tests. */
    retainedIdentities() {
      return [...retainedDescendants.values()];
    },
    markRootClosed() {
      rootClosed = true;
    },
    observeProcessTable(rows) {
      try {
        return observeProcessTable(rows);
      } catch (error) {
        markObservationFailure();
        throw error;
      }
    },
    async signal(signal) {
      if (disposed) return false;
      const rootPid = input.child.pid;
      if (rootPid === undefined) return false;
      if (platform === 'win32') {
        return signalWindows(rootPid, signal);
      }

      const rows = await capture();
      if (disposed || rows === undefined) return false;
      return signalRetainedAndRoot(rows, signal, !rootClosed);
    },
    async signalHostedChild(signal) {
      if (disposed || platform === 'win32') return false;
      const rows = await capture();
      if (disposed || rows === undefined) return false;
      // BSD `script` is the measured root; its direct child is the hosted CLI
      // and may itself own workers. Signal the CLI process group exactly once,
      // excluding the wrapper while including those workers.
      for (const identity of directChildren.values()) {
        const delivered = signalCapturedProcesses([identity], signal, {
          currentRows: rows,
          killProcess,
          useProcessGroups:
            rootIdentity === undefined || identity.processGroupId !== rootIdentity.processGroupId,
        });
        if (delivered) return true;
      }
      return false;
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
      const rows = await capture();
      if (disposed || rows === undefined) return false;
      return signalRetainedAndRoot(rows, signal, false);
    },
    async verifyResiduals(options = {}) {
      const includeRoot = options.includeRoot === true;
      const rootPid = input.child.pid;
      const rows = await capture();
      if (rows === undefined) {
        return Math.max(1, retainedDescendants.size + (includeRoot ? 1 : 0));
      }
      const currentByPid = new Map(rows.map((row) => [row.pid, row]));
      const alivePids = new Set();
      for (const identity of retainedDescendants.values()) {
        if (sameProcessIdentity(identity, currentByPid.get(identity.pid))) {
          alivePids.add(identity.pid);
        }
      }
      if (includeRoot && Number.isSafeInteger(rootPid) && rootPid > 0) {
        const currentRoot = currentByPid.get(rootPid);
        if (
          currentRoot !== undefined &&
          (rootIdentity === undefined || sameProcessIdentity(rootIdentity, currentRoot))
        ) {
          alivePids.add(rootPid);
        }
      }
      const count = alivePids.size;
      return observationFailed ? Math.max(1, count) : count;
    },
    dispose() {
      disposed = true;
      retainedDescendants.clear();
      directChildren.clear();
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
const RESIDUAL_SETTLEMENT_MS = 1000;
const RESIDUAL_SETTLEMENT_POLL_MS = 25;
const RSS_SAMPLE_TIMEOUT_MS = 1000;

async function verifyResidualsWithinDeadline(terminator, options, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('residual settlement timeout must be a non-negative safe integer');
  }
  let residuals = await terminator.verifyResiduals(options);
  const deadline = performance.now() + timeoutMs;
  while (residuals > 0 && performance.now() < deadline) {
    const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(RESIDUAL_SETTLEMENT_POLL_MS, remainingMs));
    });
    residuals = await terminator.verifyResiduals(options);
  }
  return residuals;
}

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
  const stderr = new TailBuffer(
    input.stderrTailBytes,
    input.stderrLimitBytes ?? input.stderrTailBytes,
  );
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
  let nativeSignalHandle;
  let terminationHandle;
  let forceKillSettlementHandle;
  let sampleHandle;
  let sampleInFlight;
  let samplingDisabled = false;
  let commandCompletedAt;
  let commandDurationMs;
  // RSS-availability tracking (never coerce an absent sample to zero).
  let rssTableUnavailable = false;
  let rssSamplerFault = false;
  let deliveredSignal;
  let rootCloseObserved = false;

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
    readProcessTable: sampleProcessTable,
    rssSampleTimeoutMs: sampleTimeoutMs,
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
          terminator.markObservationFailure();
          return;
        }
        const validatedRows = validateProcessRows(rows);
        terminator.observeProcessTable(validatedRows);
        const rss = sumProcessTreeRss(validatedRows, child.pid);
        if (rss > 0) maxRssBytes = Math.max(maxRssBytes ?? 0, rss);
      })
      .catch(() => {
        samplingDisabled = true;
        rssSamplerFault = true;
        terminator.markObservationFailure();
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
      clearTimeout(nativeSignalHandle);
      clearTimeout(terminationHandle);
      clearTimeout(forceKillSettlementHandle);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('close', onClose);
      input.abortSignal?.removeEventListener('abort', onAbort);
      parentReservation.complete();
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      noteCommandCompletion();
      cleanup();
      resolveTerminationComplete();
      resolve(result);
    };
    const settleCloseResult = () => settle(closeResult);
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
    const beginTermination = (reason, initialSignal = 'SIGTERM') => {
      if (terminationReason !== undefined) return terminationComplete;
      terminationReason = reason;
      clearTimeout(timeoutHandle);
      timedOut = reason === 'timeout';
      cancelled = reason === 'abort';
      terminationHandle = setTimeout(forceKill, input.terminationGraceMs ?? TERMINATION_GRACE_MS);
      Promise.resolve()
        .then(() => {
          if (reason === 'native-signal' && input.nativeSignal?.descendantOnly === true) {
            return terminator.signalHostedChild(initialSignal);
          }
          return terminator.signal(initialSignal);
        })
        .then((delivered) => {
          if (reason === 'native-signal' && delivered) deliveredSignal = initialSignal;
        })
        .catch(() => false);
      return terminationComplete;
    };
    function onError(error) {
      clearTimeout(timeoutHandle);
      if (sampleHandle !== undefined) clearInterval(sampleHandle);
      terminator.markRootClosed();
      noteCommandCompletion();
      closeResult = { code: undefined, signal: undefined, error };
      forceKill().finally(settleCloseResult);
    }
    function onClose(code, signal) {
      rootCloseObserved = true;
      clearTimeout(timeoutHandle);
      if (sampleHandle !== undefined) clearInterval(sampleHandle);
      terminator.markRootClosed();
      noteCommandCompletion();
      closeResult = { code, signal, error: undefined };
      // A PTY wrapper can close as soon as it receives the forwarded native
      // signal while its child is still running the same signal handler. Honour
      // the normal termination grace before escalating that retained process
      // group; otherwise SIGINT can be converted into an immediate SIGKILL of
      // the actual CLI before it flushes/cleans up. Normal (unsignalled) exits
      // still signal retained, observed grandchildren immediately.
      if (terminationReason === 'native-signal') {
        clearTimeout(terminationHandle);
        terminationHandle = setTimeout(
          () => forceKill(true).finally(settleCloseResult),
          input.terminationGraceMs ?? TERMINATION_GRACE_MS,
        );
        return;
      }
      forceKill(true).finally(settleCloseResult);
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
    if (input.nativeSignal !== undefined) {
      nativeSignalHandle = setTimeout(
        () => beginTermination('native-signal', input.nativeSignal.signal),
        input.nativeSignal.afterMs,
      );
    }
  });

  // Command duration ends with the child/stdio settlement. The final best-effort
  // RSS sample below must not inflate startup or install wall-time measurements.
  if (sampleHandle !== undefined) clearInterval(sampleHandle);
  await sample();

  let residualDescendants = 0;
  if (input.trackResidualDescendants) {
    residualDescendants = await verifyResidualsWithinDeadline(
      terminator,
      { includeRoot: !rootCloseObserved },
      input.residualSettlementMs ?? RESIDUAL_SETTLEMENT_MS,
    );
  }
  terminator.dispose();

  let rssUnavailableReason;
  if (rssSamplerFault) rssUnavailableReason = RSS_REASON_CODES.SAMPLER_FAULT;
  else if (rssTableUnavailable) rssUnavailableReason = RSS_REASON_CODES.PROCESS_TABLE_UNAVAILABLE;
  else if (maxRssBytes === undefined) rssUnavailableReason = RSS_REASON_CODES.CHILD_TOO_SHORT;

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
    deliveredSignal,
    durationMs: commandDurationMs,
    maxRssBytes,
    rssUnavailableReason,
    residualDescendants,
    stdoutTail: stdout.toString(),
    stderrTail: stderr.toString(),
    stdoutCapture: stdoutCapture?.toString(),
    stdoutTruncated: stdoutCapture?.truncated(),
    stderrTruncated: stderr.truncated(),
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
  #overflowLimit;
  #chunks = [];
  #bytes = 0;
  #seenBytes = 0;
  #truncated = false;

  constructor(limit, overflowLimit = limit) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('tail buffer limit must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(overflowLimit) || overflowLimit < limit) {
      throw new RangeError('tail buffer overflow limit must be a safe integer at least the tail');
    }
    this.#limit = limit;
    this.#overflowLimit = overflowLimit;
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const combined = Buffer.concat([...this.#chunks, buffer]);
    this.#seenBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#seenBytes + buffer.byteLength);
    if (this.#seenBytes > this.#overflowLimit) this.#truncated = true;
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

  truncated() {
    return this.#truncated;
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
  if (measured.rssUnavailableReason !== undefined) {
    return Object.freeze({
      status: 'unavailable',
      reasonCode: measured.rssUnavailableReason,
    });
  }
  if (
    typeof measured.maxRssBytes === 'number' &&
    Number.isFinite(measured.maxRssBytes) &&
    measured.maxRssBytes > 0
  ) {
    return Object.freeze({
      status: 'available',
      peakBytes: measured.maxRssBytes,
    });
  }
  return Object.freeze({
    status: 'unavailable',
    reasonCode: RSS_REASON_CODES.CHILD_TOO_SHORT,
  });
}

function normalizePtyOutput(value, platform, pty) {
  const output = value ?? '';
  // BSD `script` echoes the non-interactive stdin EOF as "^D\b\b" before the
  // child output. A real interactive terminal does not display this wrapper
  // artifact, so remove only that exact prefix from acceptance captures.
  if (pty && platform === 'darwin' && output.startsWith('^D\b\b')) return output.slice(4);
  return output;
}

/** Adapt a raw `runMeasuredCommand` result into the closed `MeasuredProcessResult`. */
function toMeasuredProcessResult(measured, platform, pty) {
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
    deliveredSignal: measured.deliveredSignal ?? null,
    outputTruncated: measured.stdoutTruncated === true || measured.stderrTruncated === true,
    durationMs: typeof measured.durationMs === 'number' ? measured.durationMs : 0,
    rss: toRssMeasurement(measured, platform),
    stdoutTail: normalizePtyOutput(measured.stdoutTail, platform, pty),
    stderrTail: measured.stderrTail ?? '',
    stdoutCapture: normalizePtyOutput(measured.stdoutCapture, platform, pty),
    cleanup: Object.freeze({
      residualDescendants:
        Number.isSafeInteger(measured.residualDescendants) && measured.residualDescendants >= 0
          ? measured.residualDescendants
          : 1,
    }),
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
  if (platform === 'darwin') return ['/usr/bin/script', '-q', '/dev/null', ...argv];
  return [
    '/usr/bin/script',
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
  let nativeSignal;
  if (spec.nativeSignal !== undefined) {
    if (platform === 'win32') {
      throw new TypeError('runMeasuredProcess nativeSignal is POSIX-only');
    }
    if (
      spec.nativeSignal === null ||
      typeof spec.nativeSignal !== 'object' ||
      (spec.nativeSignal.signal !== 'SIGINT' && spec.nativeSignal.signal !== 'SIGTERM') ||
      !Number.isSafeInteger(spec.nativeSignal.afterMs) ||
      spec.nativeSignal.afterMs <= 0 ||
      spec.nativeSignal.afterMs >= timeoutMs
    ) {
      throw new TypeError(
        'runMeasuredProcess nativeSignal requires SIGINT/SIGTERM and 0 < afterMs < timeoutMs',
      );
    }
    nativeSignal = {
      signal: spec.nativeSignal.signal,
      afterMs: spec.nativeSignal.afterMs,
      // The PTY wrapper is not the CLI. Forward the exact native signal to the
      // hosted CLI descendant once, then retain the whole group for bounded
      // escalation/cleanup if the child does not terminate.
      descendantOnly: spec.pty === true,
    };
  }

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
    stderrLimitBytes: stderrBytes,
    stdoutCaptureBytes: stdoutBytes,
    stdin: spec.stdin,
    abortSignal,
    nativeSignal,
    trackResidualDescendants: true,
    platform: ctx.platform,
    spawnChild: ctx.spawnChild,
    readProcessTable: ctx.readProcessTable,
    captureProcessDescendants: ctx.captureProcessDescendants,
    killProcess: ctx.killProcess,
    killProcessTree: ctx.killProcessTree,
    parentSignalCoordinator: ctx.parentSignalCoordinator,
    rssSampleTimeoutMs: ctx.rssSampleTimeoutMs,
    residualSettlementMs: ctx.residualSettlementMs,
  });

  return toMeasuredProcessResult(measured, platform, spec.pty === true);
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
      return Object.freeze({
        status: 'unavailable',
        reasonCode: lastUnavailableReason,
      });
    },
  });
}
