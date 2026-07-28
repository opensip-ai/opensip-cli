/**
 * @fileoverview The injected MCP client port for platform-acceptance mcp
 * journeys.
 *
 * `createDefaultMcpConnector(...)` returns an `McpClientPort` (see
 * `journey-catalog.d.mts`). `connect({ cwd })` launches the installed MCP server
 * as a child — `node <jsEntrypoint> mcp --cwd <cwd>` — through an SDK Client
 * attached to this module's bounded stdio Transport, performs the initialize
 * handshake, and returns a ready `McpClientHandle`. A journey supplies only a run-owned project
 * `cwd` (and optional literal env overrides); it never spawns the server itself
 * and never parses stderr as protocol data (stderr is a bounded summary only).
 *
 * The SDK Client and public message codecs are resolved LAZILY from the
 * `@opensip-cli/agent-eval` package (the declared owner of the dependency). The
 * custom Transport owns exact raw stdout/stderr accounting, terminal state,
 * sampled process cleanup, and RSS observation without SDK-private fields. Its
 * cleanup result covers observed descendants under the POSIX process-group plus
 * sampled process-table model; it is not OS containment. The client pattern
 * mirrors `packages/agent-eval/src/adapters/opensip-mcp-connection.ts`.
 *
 * @typedef {import('./journey-catalog.d.mts').McpClientPort} McpClientPort
 * @typedef {import('./journey-catalog.d.mts').McpClientHandle} McpClientHandle
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
  createChildProcessTerminator,
  parentSignalCoordinator,
  readProcessTable,
  reserveParentSignalCleanup,
  sumProcessTreeRss,
  verifyResidualsWithinDeadline,
} from '../lib/measured-process.mjs';

const CLIENT_NAME = 'opensip-platform-acceptance';
const CLIENT_VERSION = '1.0.0';
const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const MAX_CLOSE_TIMEOUT_MS = 5000;
const CLOSE_GRACE_MS = 750;
const CLOSE_KILL_MS = 500;
const PROCESS_OBSERVATION_TIMEOUT_MS = 250;

async function within(promise, timeoutMs, label) {
  let handle;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        handle = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(handle);
  }
}

/** A bounded byte ring for stderr accounting (never parsed as protocol data). */
class BoundedByteRing {
  #max;
  #retained = Buffer.alloc(0);
  #seen = 0;
  #truncated = false;

  constructor(maximumBytes) {
    this.#max =
      Number.isSafeInteger(maximumBytes) && maximumBytes > 0
        ? maximumBytes
        : DEFAULT_MAX_STDERR_BYTES;
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.#seen = Math.min(Number.MAX_SAFE_INTEGER, this.#seen + buffer.byteLength);
    const combined = Buffer.concat([this.#retained, buffer]);
    if (combined.byteLength <= this.#max) {
      this.#retained = combined;
      return;
    }
    this.#retained = combined.subarray(combined.byteLength - this.#max);
    this.#truncated = true;
  }

  summary() {
    return { bytes: this.#seen, truncated: this.#truncated };
  }
}

/** Lazily resolve the SDK Client + public stdio codecs from agent-eval. */
async function loadSdk(repoRoot) {
  const anchor = join(repoRoot, 'packages', 'agent-eval', 'package.json');
  const require = createRequire(anchor);
  const clientPath = require.resolve('@modelcontextprotocol/sdk/client');
  const stdioPath = require.resolve('@modelcontextprotocol/sdk/shared/stdio.js');
  const [clientModule, stdioModule] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  const Client = clientModule.Client ?? clientModule.default?.Client;
  const deserializeMessage =
    stdioModule.deserializeMessage ?? stdioModule.default?.deserializeMessage;
  const serializeMessage = stdioModule.serializeMessage ?? stdioModule.default?.serializeMessage;
  if (
    typeof Client !== 'function' ||
    typeof deserializeMessage !== 'function' ||
    typeof serializeMessage !== 'function'
  ) {
    throw new TypeError('MCP SDK did not export Client / public stdio codecs');
  }
  return { Client, deserializeMessage, serializeMessage };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A small public-Transport implementation with exact raw stdout accounting.
 * Unlike the SDK StdioClientTransport it never exposes or reaches into a private
 * `_process`: pid, terminal status, output bounds, RSS observations, and cleanup
 * residue are explicit acceptance-harness seams.
 */
export class BoundedStdioClientTransport {
  onclose;
  onerror;
  onmessage;

  #options;
  #child;
  #lineBuffer = Buffer.alloc(0);
  #stdoutBytes = 0;
  #stdoutTruncated = false;
  #stderrRing;
  #terminal = null;
  #terminalPromise;
  #resolveTerminal;
  #closeObserved = false;
  #closeObservedPromise;
  #resolveCloseObserved;
  #closePromise;
  #terminator;
  #reservation;
  #residualDescendants = 0;
  #closedNotified = false;
  #protocolError = null;

  constructor(options) {
    this.#options = options;
    this.#stderrRing = new BoundedByteRing(options.maxStderrBytes);
    this.#terminalPromise = new Promise((resolve) => {
      this.#resolveTerminal = resolve;
    });
    this.#closeObservedPromise = new Promise((resolve) => {
      this.#resolveCloseObserved = resolve;
    });
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  stdoutSummary() {
    return Object.freeze({
      bytes: this.#stdoutBytes,
      truncated: this.#stdoutTruncated,
    });
  }

  stderrSummary() {
    return Object.freeze(this.#stderrRing.summary());
  }

  terminalStatus() {
    return this.#terminal === null ? null : Object.freeze({ ...this.#terminal });
  }

  residualDescendants() {
    return this.#residualDescendants;
  }

  protocolFaulted() {
    return this.#protocolError !== null;
  }

  observeProcessTable(rows) {
    this.#terminator?.observeProcessTable(rows);
  }

  markProcessObservationFailure() {
    this.#terminator?.markObservationFailure();
  }

  async start() {
    if (this.#child !== undefined) throw new Error('bounded MCP transport is already started');
    this.#reservation = reserveParentSignalCleanup(
      this.#options.parentSignalCoordinator ?? parentSignalCoordinator,
    );
    if (this.#reservation.interrupted()) {
      this.#reservation.complete();
      throw new Error('MCP transport interrupted before spawn');
    }
    const useProcessGroup = (this.#options.platform ?? process.platform) !== 'win32';
    try {
      this.#child = (this.#options.spawnChild ?? spawn)(
        this.#options.command,
        this.#options.args ?? [],
        {
          cwd: this.#options.cwd,
          detached: useProcessGroup,
          env: this.#options.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (error) {
      this.#reservation.complete();
      throw error;
    }
    this.#terminator = createChildProcessTerminator({
      captureProcessDescendants: this.#options.captureProcessDescendants,
      child: this.#child,
      killProcess: this.#options.killProcess,
      killProcessTree: this.#options.killProcessTree,
      platform: this.#options.platform,
      readProcessTable: this.#options.readProcessTable,
      rssSampleTimeoutMs: PROCESS_OBSERVATION_TIMEOUT_MS,
      useProcessGroup,
    });
    this.#reservation.activate((signal) => this.#beginClose(signal));
    this.#child.stdout?.on('data', (chunk) => this.#onStdout(chunk));
    this.#child.stderr?.on('data', (chunk) => this.#stderrRing.append(chunk));
    this.#child.stdin?.on('error', (error) => this.onerror?.(error));
    this.#child.stdout?.on('error', (error) => this.#protocolFault(error));
    this.#child.once('exit', (code, signal) => this.#onExit(code, signal));
    this.#child.once('close', (code, signal) => this.#onClose(code, signal));

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.#child?.off('spawn', onSpawn);
        this.onerror?.(error);
        reject(error);
      };
      const onSpawn = () => {
        this.#child?.off('error', onError);
        // Subsequent child errors are out-of-band transport failures.
        this.#child?.on('error', (error) => this.onerror?.(error));
        resolve();
      };
      this.#child.once('error', onError);
      this.#child.once('spawn', onSpawn);
    });
  }

  #onStdout(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#stdoutBytes + buffer.byteLength);
    if (this.#stdoutTruncated) return;
    if (this.#stdoutBytes > this.#options.maxStdoutBytes) {
      this.#stdoutTruncated = true;
      this.#lineBuffer = Buffer.alloc(0);
      this.#protocolFault(new Error('MCP stdout exceeded its byte bound'));
      return;
    }
    this.#lineBuffer = Buffer.concat([this.#lineBuffer, buffer]);
    while (true) {
      const newline = this.#lineBuffer.indexOf(0x0a);
      if (newline < 0) return;
      let line = this.#lineBuffer.subarray(0, newline);
      this.#lineBuffer = this.#lineBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      try {
        this.onmessage?.(this.#options.deserializeMessage(line.toString('utf8')));
      } catch (error) {
        this.#protocolFault(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  #protocolFault(error) {
    if (this.#protocolError !== null) return;
    this.#protocolError = error;
    this.onerror?.(error);
    this.close().catch(() => false);
  }

  #onExit(code, signal) {
    if (this.#terminal !== null) return;
    this.#terminal = Object.freeze({
      exitCode: Number.isSafeInteger(code) && code >= 0 ? code : null,
      signal: typeof signal === 'string' && signal.length > 0 ? signal : null,
    });
    this.#terminator?.markRootClosed();
    this.#resolveTerminal(this.#terminal);
    if (this.#closePromise === undefined) this.#beginClose().catch(() => false);
  }

  #onClose(code, signal) {
    this.#onExit(code, signal);
    this.#closeObserved = true;
    this.#resolveCloseObserved();
    if (!this.#stdoutTruncated && this.#lineBuffer.byteLength > 0) {
      this.#lineBuffer = Buffer.alloc(0);
      this.#protocolFault(new Error('MCP stdout ended with an unterminated protocol message'));
    }
    if (!this.#closedNotified) {
      this.#closedNotified = true;
      this.onclose?.();
    }
  }

  async #waitForTerminal(timeoutMs) {
    if (this.#terminal !== null) return true;
    return Promise.race([
      this.#terminalPromise.then(() => true),
      delay(timeoutMs).then(() => false),
    ]);
  }

  async #waitForCloseObserved(timeoutMs) {
    if (this.#closeObserved) return true;
    return Promise.race([
      this.#closeObservedPromise.then(() => true),
      delay(timeoutMs).then(() => false),
    ]);
  }

  async #terminate(signal = 'SIGTERM') {
    return this.#terminator?.signal(signal);
  }

  async #closeImpl(initialSignal) {
    if (this.#child === undefined) {
      if (!this.#closedNotified) {
        this.#closedNotified = true;
        this.onclose?.();
      }
      return;
    }
    const graceMs = this.#options.closeGraceMs ?? CLOSE_GRACE_MS;
    const killMs = this.#options.closeKillMs ?? CLOSE_KILL_MS;
    try {
      if (initialSignal === undefined) {
        await this.#terminator?.capture();
        try {
          this.#child.stdin?.end();
        } catch {
          // Bounded escalation below remains available.
        }
      } else {
        await this.#terminate(initialSignal);
      }
      if (!(await this.#waitForTerminal(graceMs))) {
        await this.#terminate('SIGTERM');
      }
      if (!(await this.#waitForTerminal(killMs))) {
        await this.#terminate('SIGKILL');
        await this.#waitForTerminal(killMs);
      }
      if (this.#terminal !== null) {
        await this.#terminator?.signalAfterRootClose('SIGKILL');
      }
      if (!(await this.#waitForCloseObserved(killMs))) {
        // A root can exit while a detached descendant keeps inherited stdio
        // open. Tear down our pipe handles so connector shutdown itself remains
        // bounded, and fail cleanup closed because sampled observation cannot
        // establish a clean result.
        this.#terminator?.markObservationFailure();
        this.#child.stdin?.destroy?.();
        this.#child.stdout?.destroy?.();
        this.#child.stderr?.destroy?.();
      }
      // Signal delivery is not process exit. In particular, Linux can retain a
      // just-killed descendant in the process table until its parent/init reaps
      // it. Keep the parent-signal reservation until a sampled absence proves
      // cleanup, bounded by the existing KILL settlement window.
      this.#residualDescendants =
        this.#terminator === undefined
          ? 1
          : await verifyResidualsWithinDeadline(
              this.#terminator,
              { includeRoot: this.#terminal === null },
              killMs,
            );
    } catch {
      this.#terminator?.markObservationFailure();
      try {
        this.#residualDescendants =
          (await this.#terminator?.verifyResiduals({ includeRoot: true })) ?? 1;
      } catch {
        this.#residualDescendants = Math.max(1, this.#residualDescendants);
      }
    } finally {
      if (!this.#closeObserved) {
        this.#child.stdin?.destroy?.();
        this.#child.stdout?.destroy?.();
        this.#child.stderr?.destroy?.();
      }
      this.#reservation?.complete();
      this.#terminator?.dispose();
      if (!this.#closedNotified) {
        this.#closedNotified = true;
        this.onclose?.();
      }
    }
  }

  #beginClose(initialSignal) {
    this.#closePromise ??= this.#closeImpl(initialSignal);
    return this.#closePromise;
  }

  close() {
    return this.#beginClose();
  }

  send(message) {
    return new Promise((resolve, reject) => {
      const stdin = this.#child?.stdin;
      if (stdin === undefined || stdin.destroyed) {
        reject(new Error('MCP transport is not connected'));
        return;
      }
      let serialized;
      try {
        serialized = this.#options.serializeMessage(message);
      } catch (error) {
        reject(error);
        return;
      }
      if (stdin.write(serialized)) resolve();
      else stdin.once('drain', resolve);
    });
  }
}

/**
 * @param {object} options
 * @param {{ script: string }} options.jsEntrypoint the resolved installed JS entrypoint.
 * @param {Record<string,string>} options.baseEnv    the deterministic, credential-free base env.
 * @param {object} options.bounds                    the active profile bounds.
 * @param {string} options.repoRoot                  repo root (anchors SDK resolution).
 * @param {string} [options.platform]
 * @param {(root: string) => Promise<object>} [options.loadSdk] test seam.
 * @param {typeof spawn} [options.spawnChild] test seam.
 * @param {(options?: object) => Promise<ReadonlyArray<object>>} [options.readProcessTable] test seam.
 * @param {string} [options.nodeExecutable]          override the node executable (defaults to the run's node).
 * @returns {McpClientPort}
 */
export function createDefaultMcpConnector(options) {
  const jsEntrypoint = options.jsEntrypoint;
  const baseEnv = options.baseEnv ?? {};
  const bounds = options.bounds ?? {};
  const repoRoot = options.repoRoot;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const loadSdkImpl = options.loadSdk ?? (() => loadSdk(repoRoot));
  const maxStdoutBytes = bounds.maxStdoutBytes ?? 1024 * 1024;
  const maxStderrBytes = bounds.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const defaultTimeout = bounds.journeyTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const sampleIntervalMs = bounds.rssSampleIntervalMs ?? 250;
  const readProcessTableImpl = options.readProcessTable ?? readProcessTable;
  let connectorPeakBytes = 0;
  let connectorSawSample = false;
  let connectorObservationFailed = false;
  let connectorUnavailableReason = 'rss-not-sampled';
  let sessionNumber = 0;
  let completedSteps = [];

  const recordSample = (rows, pid, session) => {
    session.transport?.observeProcessTable(rows);
    const rss = sumProcessTreeRss(rows, pid);
    if (rss <= 0) return;
    connectorSawSample = true;
    connectorPeakBytes = Math.max(connectorPeakBytes, rss);
    session.sawSample = true;
    session.peakBytes = Math.max(session.peakBytes, rss);
  };

  return Object.freeze({
    async connect(spec) {
      if (spec === null || typeof spec !== 'object' || typeof spec.cwd !== 'string') {
        throw new TypeError('mcp connect requires a cwd');
      }
      sessionNumber += 1;
      const label = `mcp-session-${sessionNumber}`;
      const startedAt = performance.now();
      const timeoutMs = spec.timeoutMs ?? defaultTimeout;
      const sessionRss = {
        peakBytes: 0,
        sawSample: false,
        observationFailed: false,
        unavailableReason: 'rss-not-sampled',
        transport: null,
      };
      let transport;
      let client;
      const stepRss = () => {
        if (sessionRss.observationFailed || !sessionRss.sawSample) {
          return {
            status: 'unavailable',
            reasonCode: sessionRss.unavailableReason,
          };
        }
        return { status: 'available', peakBytes: sessionRss.peakBytes };
      };
      const recordStep = (failureReason = null, failureDiagnostic = null) => {
        const stderr = transport?.stderrSummary() ?? {
          bytes: 0,
          truncated: false,
        };
        const stdout = transport?.stdoutSummary() ?? {
          bytes: 0,
          truncated: false,
        };
        let observed = transport?.terminalStatus() ?? null;
        let reasonCode = failureReason;
        if (reasonCode !== null) observed = null;
        else if (stderr.truncated || stdout.truncated) reasonCode = 'output-overflow';
        else if (transport?.protocolFaulted() === true) reasonCode = 'mcp-protocol-failed';
        else if (observed === null) reasonCode = 'mcp-terminal-unobserved';
        else if (observed.exitCode !== 0 || observed.signal !== null) reasonCode = 'command-failed';
        const residualDescendants = transport?.residualDescendants() ?? (observed === null ? 1 : 0);
        completedSteps.push(
          Object.freeze({
            label,
            stage: 'mcp',
            exitCode: observed?.exitCode ?? null,
            signal: observed?.signal ?? null,
            timedOut: false,
            cancelled: false,
            outputTruncated: stderr.truncated || stdout.truncated,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            rss: Object.freeze(stepRss()),
            residualDescendants,
            reasonCode,
            diagnostics: Object.freeze(
              [
                `mcp-stdout-bytes:${stdout.bytes}`,
                `mcp-stderr-bytes:${stderr.bytes}`,
                failureDiagnostic,
              ].filter((entry) => typeof entry === 'string' && entry.length > 0),
            ),
          }),
        );
      };
      let sampleInFlight;
      let sampleHandle;
      const sample = async () => {
        const pid = transport?.pid;
        if (!Number.isSafeInteger(pid) || pid <= 0 || sampleInFlight) return sampleInFlight;
        sampleInFlight = readProcessTableImpl({ platform: options.platform })
          .then((rows) => recordSample(rows, pid, sessionRss))
          .catch(() => {
            connectorObservationFailed = true;
            connectorUnavailableReason = 'rss-process-table-unavailable';
            sessionRss.observationFailed = true;
            sessionRss.unavailableReason = 'rss-process-table-unavailable';
            transport?.markProcessObservationFailure();
          })
          .finally(() => {
            sampleInFlight = undefined;
          });
        return sampleInFlight;
      };
      try {
        const { Client, deserializeMessage, serializeMessage } = await loadSdkImpl(repoRoot);
        transport = new BoundedStdioClientTransport({
          command: nodeExecutable,
          args: [jsEntrypoint.script, 'mcp', '--cwd', spec.cwd],
          captureProcessDescendants: options.captureProcessDescendants,
          cwd: spec.cwd,
          env: { ...baseEnv, ...spec.env },
          deserializeMessage,
          maxStderrBytes,
          maxStdoutBytes,
          killProcess: options.killProcess,
          killProcessTree: options.killProcessTree,
          parentSignalCoordinator: options.parentSignalCoordinator,
          platform: options.platform,
          readProcessTable: readProcessTableImpl,
          serializeMessage,
          spawnChild: options.spawnChild,
        });
        sessionRss.transport = transport;
        client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
        // Start sampling before initialize completes: MCP startup/handshake is a
        // material part of the installed process peak, not warm steady state.
        sampleHandle = setInterval(() => {
          void sample();
        }, sampleIntervalMs);
        sampleHandle.unref?.();
        await client.connect(transport, { timeout: timeoutMs });
        await sample();
      } catch (error) {
        clearInterval(sampleHandle);
        await sample();
        try {
          if (client !== undefined) {
            await within(client.close(), Math.min(timeoutMs, MAX_CLOSE_TIMEOUT_MS), 'MCP close');
          }
        } catch {
          // The original connect failure remains authoritative.
        }
        try {
          if (transport !== undefined) {
            await within(
              transport.close(),
              Math.min(timeoutMs, MAX_CLOSE_TIMEOUT_MS),
              'MCP transport close',
            );
          }
        } catch {
          // The original connect failure remains authoritative.
        }
        recordStep('mcp-connect-failed', error instanceof Error ? error.message : String(error));
        throw error;
      }
      let closed = false;

      return Object.freeze({
        serverVersion() {
          return client.getServerVersion();
        },
        listTools() {
          return client.listTools(undefined, { timeout: timeoutMs });
        },
        callTool(input) {
          return client.callTool({ name: input.name, arguments: input.arguments }, undefined, {
            timeout: timeoutMs,
          });
        },
        stderrSummary() {
          return transport.stderrSummary();
        },
        async close() {
          if (closed) return;
          closed = true;
          clearInterval(sampleHandle);
          await sample();
          let closeError;
          try {
            await within(client.close(), Math.min(timeoutMs, MAX_CLOSE_TIMEOUT_MS), 'MCP close');
          } catch (error) {
            closeError = error;
          }
          try {
            await within(
              transport.close(),
              Math.min(timeoutMs, MAX_CLOSE_TIMEOUT_MS),
              'MCP transport close',
            );
          } catch (error) {
            closeError ??= error;
          }
          recordStep(
            closeError === undefined ? null : 'mcp-close-failed',
            closeError instanceof Error ? closeError.message : String(closeError ?? ''),
          );
          if (closeError !== undefined) throw closeError;
        },
      });
    },
    takeStepEvidence() {
      const taken = Object.freeze([...completedSteps]);
      completedSteps = [];
      return taken;
    },
    rssMeasurement() {
      if (connectorObservationFailed) {
        return Object.freeze({
          status: 'unavailable',
          reasonCode: connectorUnavailableReason,
        });
      }
      if (connectorSawSample) {
        return Object.freeze({
          status: 'available',
          peakBytes: connectorPeakBytes,
        });
      }
      return Object.freeze({
        status: 'unavailable',
        reasonCode: connectorUnavailableReason,
      });
    },
  });
}
