import {
  captureProcessDescendants as defaultCaptureProcessDescendants,
  killProcessTree as defaultKillProcessTree,
  processDescendantsFromTable,
  signalCapturedProcesses,
} from './process-tree-rss.mjs';

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
  const captureProcessDescendants =
    input.captureProcessDescendants ?? defaultCaptureProcessDescendants;
  const killProcessTree = input.killProcessTree ?? defaultKillProcessTree;
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
      .then(() => captureProcessDescendants(rootPid, { platform }))
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
      treeTerminated = (await killProcessTree(rootPid, signal, { platform })) !== false;
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
