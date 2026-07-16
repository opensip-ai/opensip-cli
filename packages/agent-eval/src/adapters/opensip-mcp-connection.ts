import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

// @fitness-ignore-next-line missing-type-exports -- MCP SDK declares "./client" in its external package exports; the workspace-only check cannot discover external package manifests.
import { Client } from '@modelcontextprotocol/sdk/client';
// @fitness-ignore-next-line missing-type-exports -- MCP SDK publishes shared/stdio.js through its declared "./*" export; the workspace-only check cannot discover external package manifests.
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

import {
  processTreeIsAlive,
  processTreeTrackingReliable,
  retainPosixProcessTree,
  sampleProcessTree,
  signalProcessTree,
  stopProcessTreeTracking,
} from '../runner/process-tree.js';

import type { JsonObject } from '../model/task.js';
import type { PosixProcessTree, ProcessSnapshot } from '../runner/process-tree.js';
// @fitness-ignore-next-line missing-type-exports -- MCP SDK publishes shared/transport.js through its declared "./*" export; the workspace-only check cannot discover external package manifests.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Stream } from 'node:stream';

const CLIENT_NAME = 'opensip-agent-eval';
const CLIENT_VERSION = '1.0.0';

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * A session-wide raw protocol ceiling. Per-response limits remain enforced by
 * the decoder, while this hard cap prevents the SDK from materializing an
 * unbounded line or an unbounded stream of notifications first.
 */
export const DEFAULT_MAX_MCP_TOOL_CALLS = 16;
export const MAX_MCP_TOOL_CALLS = 128;
const MCP_SETUP_RESPONSE_COUNT = 3;
const MCP_JSON_ESCAPE_EXPANSION = 6;
const MCP_RAW_FRAME_OVERHEAD_BYTES = 64 * 1024;
const MAX_MCP_SESSION_STDOUT_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_MCP_STDOUT_BYTES =
  (DEFAULT_MAX_RESPONSE_BYTES * MCP_JSON_ESCAPE_EXPANSION + MCP_RAW_FRAME_OVERHEAD_BYTES) *
  (DEFAULT_MAX_MCP_TOOL_CALLS + MCP_SETUP_RESPONSE_COUNT);

const CLOSE_GRACE_MS = 1000;
const CLOSE_KILL_MS = 1000;

interface McpToolCall {
  readonly arguments: JsonObject;
  readonly name: string;
}

export interface McpServerVersion {
  readonly name: string;
  readonly version: string;
}

/** Narrow SDK connection seam used by focused protocol-mapping tests. */
export interface McpConnection {
  readonly stderr: Stream | null;
  callTool(input: McpToolCall, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
  connect(timeoutMs: number): Promise<void>;
  listTools(timeoutMs: number): Promise<unknown>;
  serverVersion(): McpServerVersion | undefined;
}

export interface McpConnectionOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly maxFrameBytes?: number;
  readonly maxStdoutBytes?: number;
}

export type McpConnectionFactory = (options: McpConnectionOptions) => McpConnection;

export class BoundedByteRing {
  private retained = Buffer.alloc(0);
  private seenBytes = 0;
  private wasTruncated = false;

  public constructor(private readonly maximumBytes: number) {}

  public append(chunk: unknown): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.seenBytes = Math.min(Number.MAX_SAFE_INTEGER, this.seenBytes + buffer.byteLength);
    const combined = Buffer.concat([this.retained, buffer]);
    if (combined.byteLength <= this.maximumBytes) {
      this.retained = combined;
      return;
    }
    this.retained = combined.subarray(combined.byteLength - this.maximumBytes);
    this.wasTruncated = true;
  }

  public summary(): { readonly bytes: number; readonly truncated: boolean } {
    return { bytes: this.seenBytes, truncated: this.wasTruncated };
  }
}

/**
 * Resolve an optional positive integer within a hard maximum.
 *
 * @throws {RangeError} When the supplied or fallback value is outside the accepted range.
 */
export function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${name} must be a positive integer at most ${maximum}.`);
  }
  return resolved;
}

/**
 * Derive a session-wide raw transport budget from the per-response ceiling and
 * the closed request budget. Three setup responses cover initialize, catalog,
 * and listTools; every permitted tool call then receives one full response
 * allowance plus bounded JSON-RPC framing overhead.
 */
export function cumulativeMcpStdoutByteLimit(
  maxResponseBytes: number,
  maxToolCalls: number,
): number {
  const maxFrameBytes = mcpRawFrameByteLimit(maxResponseBytes);
  if (
    !Number.isSafeInteger(maxToolCalls) ||
    maxToolCalls <= 0 ||
    maxToolCalls > MAX_MCP_TOOL_CALLS
  ) {
    throw new RangeError(`maxToolCalls must be a positive integer at most ${MAX_MCP_TOOL_CALLS}.`);
  }
  const responseCount = maxToolCalls + MCP_SETUP_RESPONSE_COUNT;
  const maximum = maxFrameBytes * responseCount;
  if (!Number.isSafeInteger(maximum) || maximum > MAX_MCP_SESSION_STDOUT_BYTES) {
    throw new RangeError(
      `maxResponseBytes and maxToolCalls require more than the ${String(MAX_MCP_SESSION_STDOUT_BYTES)} byte MCP session ceiling.`,
    );
  }
  return maximum;
}

/**
 * Raw single-frame allowance corresponding to one decoded response ceiling.
 * A decoded byte can occupy six JSON bytes (`\\u00XX`) in the worst case; the
 * fixed allowance covers the bounded JSON-RPC envelope around that content.
 */
export function mcpRawFrameByteLimit(maxResponseBytes: number): number {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new RangeError('maxResponseBytes must be a positive safe integer');
  }
  const maximum = maxResponseBytes * MCP_JSON_ESCAPE_EXPANSION + MCP_RAW_FRAME_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(maximum)) {
    throw new RangeError('maxResponseBytes cannot produce a safe raw MCP frame ceiling.');
  }
  return maximum;
}

type SpawnChild = typeof spawn;

export interface BoundedStdioTransportOptions extends McpConnectionOptions {
  readonly maxStdoutBytes: number;
  readonly platform?: NodeJS.Platform;
  /** Test-only process inventory seam. */
  readonly processSnapshot?: ProcessSnapshot;
  readonly spawnChild?: SpawnChild;
}

export interface BoundedStdioTerminalStatus {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

type TransportMessage = Parameters<Transport['send']>[0];

interface BoundedStdioTransport extends Transport {
  protocolError(): Error | undefined;
  stdoutSummary(): { readonly bytes: number; readonly truncated: boolean };
  terminalStatus(): BoundedStdioTerminalStatus | undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * SDK-public stdio transport whose raw stdout is bounded before buffering,
 * UTF-8 conversion, JSON parsing, or SDK schema validation.
 */
export class BoundedStdioClientTransport implements BoundedStdioTransport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: Transport['onmessage'];

  private child: ChildProcessWithoutNullStreams | undefined;
  private clientCloseRequested = false;
  private closeObserved = false;
  private closePromise: Promise<void> | undefined;
  private closedNotified = false;
  private fatalError: Error | undefined;
  private lineBytes = 0;
  private lineChunks: Buffer[] = [];
  private readonly maxFrameBytes: number;
  private processTree: PosixProcessTree | undefined;
  private readonly stderrStream = new PassThrough();
  private stdoutBytes = 0;
  private terminal: BoundedStdioTerminalStatus | undefined;
  private readonly terminalPromise: Promise<void>;
  private readonly closeObservedPromise: Promise<void>;
  private resolveTerminal!: () => void;
  private resolveCloseObserved!: () => void;

  public constructor(private readonly options: BoundedStdioTransportOptions) {
    if (!Number.isSafeInteger(options.maxStdoutBytes) || options.maxStdoutBytes <= 0) {
      throw new RangeError('maxStdoutBytes must be a positive safe integer');
    }
    this.maxFrameBytes = options.maxFrameBytes ?? options.maxStdoutBytes;
    if (
      !Number.isSafeInteger(this.maxFrameBytes) ||
      this.maxFrameBytes <= 0 ||
      this.maxFrameBytes > options.maxStdoutBytes
    ) {
      throw new RangeError('maxFrameBytes must be positive and at most maxStdoutBytes');
    }
    this.terminalPromise = new Promise((resolveTerminal) => {
      this.resolveTerminal = resolveTerminal;
    });
    this.closeObservedPromise = new Promise((resolveCloseObserved) => {
      this.resolveCloseObserved = resolveCloseObserved;
    });
  }

  public get stderr(): Stream {
    return this.stderrStream;
  }

  public get pid(): number | undefined {
    return this.child?.pid;
  }

  public protocolError(): Error | undefined {
    return this.fatalError;
  }

  public stdoutSummary(): {
    readonly bytes: number;
    readonly truncated: boolean;
  } {
    return Object.freeze({
      bytes: this.stdoutBytes,
      truncated: this.stdoutBytes > this.options.maxStdoutBytes,
    });
  }

  public terminalStatus(): BoundedStdioTerminalStatus | undefined {
    return this.terminal === undefined ? undefined : Object.freeze({ ...this.terminal });
  }

  public async start(): Promise<void> {
    if (this.child !== undefined || this.terminal !== undefined) {
      throw new Error('BoundedStdioClientTransport has already been started.');
    }
    const platform = this.options.platform ?? process.platform;
    if (platform === 'win32') {
      throw new Error(
        'Agent-eval requires POSIX process-group cleanup; Windows Job Object containment is unavailable.',
      );
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawnChild ?? spawn)(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        detached: true,
        env: { ...this.options.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.child = child;
    if (child.pid !== undefined) {
      this.processTree = retainPosixProcessTree(child, platform, {
        ...(this.options.processSnapshot === undefined
          ? {}
          : { snapshotProcesses: this.options.processSnapshot }),
      });
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.processTree !== undefined) sampleProcessTree(this.processTree);
      this.consumeStdout(chunk);
    });
    child.stderr.on('data', () => {
      if (this.processTree !== undefined) sampleProcessTree(this.processTree);
    });
    child.stderr.pipe(this.stderrStream, { end: false });
    child.stdin.on('error', (error) => this.reportError(error));
    child.stdout.on('error', (error) => this.failProtocol(error));
    child.once('exit', (exitCode, signal) => this.observeExit(exitCode, signal));
    child.once('close', (exitCode, signal) => this.observeClose(exitCode, signal));

    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn);
        this.reportError(error);
        rejectStart(error);
      };
      const onSpawn = (): void => {
        child.off('error', onError);
        this.processTree ??= retainPosixProcessTree(child, platform);
        child.on('error', (error) => this.failProtocol(error));
        resolveStart();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  public send(message: TransportMessage): Promise<void> {
    return new Promise((resolveSend, rejectSend) => {
      const child = this.child;
      if (child === undefined || child.stdin.destroyed || this.fatalError !== undefined) {
        rejectSend(new Error('MCP transport is not connected.'));
        return;
      }
      let serialized: string;
      try {
        serialized = serializeMessage(message);
      } catch (error) {
        rejectSend(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const onError = (error: Error): void => {
        child.stdin.off('drain', onDrain);
        rejectSend(error);
      };
      const onDrain = (): void => {
        child.stdin.off('error', onError);
        resolveSend();
      };
      child.stdin.once('error', onError);
      if (child.stdin.write(serialized)) {
        child.stdin.off('error', onError);
        resolveSend();
      } else {
        child.stdin.once('drain', onDrain);
      }
    });
  }

  public close(): Promise<void> {
    this.clientCloseRequested = true;
    this.closePromise ??= this.closeImpl();
    return this.closePromise;
  }

  private beginInternalClose(): Promise<void> {
    this.closePromise ??= this.closeImpl();
    return this.closePromise;
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stdoutBytes + chunk.byteLength);
    if (this.fatalError !== undefined && !this.isUnexpectedTerminalError()) return;
    if (this.stdoutBytes > this.options.maxStdoutBytes) {
      this.clearPendingLine();
      this.failProtocol(new Error('MCP stdout exceeded its raw byte ceiling.'));
      return;
    }

    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        this.retainFrameTail(chunk.subarray(offset));
        return;
      }
      const segment = chunk.subarray(offset, newline);
      if (!this.deliverFrame(segment)) return;
      offset = newline + 1;
    }
  }

  private frameHasCapacity(additionalBytes: number): boolean {
    if (this.lineBytes + additionalBytes <= this.maxFrameBytes) return true;
    this.clearPendingLine();
    this.failProtocol(new Error('MCP stdout frame exceeded its raw byte ceiling.'));
    return false;
  }

  private retainFrameTail(tail: Buffer): void {
    if (!this.frameHasCapacity(tail.byteLength)) return;
    this.lineChunks.push(tail);
    this.lineBytes += tail.byteLength;
  }

  private deliverFrame(segment: Buffer): boolean {
    if (!this.frameHasCapacity(segment.byteLength)) return false;
    let line = segment;
    if (this.lineChunks.length > 0) {
      this.lineChunks.push(segment);
      line = Buffer.concat(this.lineChunks, this.lineBytes + segment.byteLength);
    }
    this.clearPendingLine();
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    try {
      this.onmessage?.(deserializeMessage(line.toString('utf8')));
      return true;
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private clearPendingLine(): void {
    this.lineBytes = 0;
    this.lineChunks = [];
  }

  private failProtocol(error: Error): void {
    if (this.fatalError !== undefined && !this.isUnexpectedTerminalError()) return;
    this.fatalError = error;
    this.signalProcessTree('SIGTERM');
    void this.beginInternalClose().catch(() => false);
    this.reportError(error);
  }

  private reportError(error: Error): void {
    this.onerror?.(error);
  }

  private observeExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.terminal === undefined) {
      this.terminal = Object.freeze({ exitCode, signal });
      this.resolveTerminal();
    }
    if (this.processTree !== undefined) sampleProcessTree(this.processTree);
    if (!this.clientCloseRequested && this.fatalError === undefined) {
      const terminalDescription =
        exitCode === null ? `signal ${String(signal)}` : `exit ${String(exitCode)}`;
      this.fatalError = new Error(`MCP server exited unexpectedly (${terminalDescription}).`);
    }
    if (this.treeIsAlive() || !this.trackingReliable()) this.signalProcessTree('SIGTERM');
    void this.beginInternalClose().catch((error: unknown) => {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private observeClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.terminal === undefined) {
      this.terminal = Object.freeze({ exitCode, signal });
      this.resolveTerminal();
    }
    this.closeObserved = true;
    this.child = undefined;
    this.resolveCloseObserved();
    this.stderrStream.end();
    const hadUnexpectedTerminal = this.isUnexpectedTerminalError();
    if (this.lineBytes > 0) {
      this.clearPendingLine();
      const frameError = new Error('MCP stdout ended with an unterminated protocol frame.');
      if (hadUnexpectedTerminal) {
        this.fatalError = frameError;
        this.reportError(frameError);
      } else {
        this.failProtocol(frameError);
      }
    } else if (hadUnexpectedTerminal && this.fatalError !== undefined) {
      this.reportError(this.fatalError);
    }
    void this.beginInternalClose().catch((error: unknown) => {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onclose?.();
  }

  private signalProcessTree(signal: NodeJS.Signals): void {
    if (this.processTree === undefined) return;
    signalProcessTree(this.processTree, signal);
  }

  private treeIsAlive(): boolean {
    return this.processTree !== undefined && processTreeIsAlive(this.processTree);
  }

  private trackingReliable(): boolean {
    return this.processTree === undefined || processTreeTrackingReliable(this.processTree);
  }

  private isUnexpectedTerminalError(): boolean {
    return this.fatalError?.message.startsWith('MCP server exited unexpectedly') === true;
  }

  private replaceGenericTerminalError(error: Error): void {
    if (this.fatalError === undefined || this.isUnexpectedTerminalError()) {
      this.fatalError = error;
      this.reportError(error);
    }
  }

  private async waitForTreeExit(milliseconds: number): Promise<boolean> {
    const deadline = Date.now() + milliseconds;
    while (this.treeIsAlive() && Date.now() < deadline) await delay(25);
    return !this.treeIsAlive();
  }

  private async waitForTerminal(milliseconds: number): Promise<boolean> {
    if (this.terminal !== undefined) return true;
    return Promise.race([
      this.terminalPromise.then(() => true),
      delay(milliseconds).then(() => false),
    ]);
  }

  private async waitForCloseObserved(milliseconds: number): Promise<boolean> {
    if (this.closeObserved) return true;
    return Promise.race([
      this.closeObservedPromise.then(() => true),
      delay(milliseconds).then(() => false),
    ]);
  }

  private requestInitialClose(child: ChildProcessWithoutNullStreams | undefined): void {
    if (child !== undefined && this.fatalError === undefined) {
      try {
        child.stdin.end();
      } catch {
        // Escalation remains authoritative.
      }
      return;
    }
    if (this.fatalError !== undefined) this.signalProcessTree('SIGTERM');
  }

  private async escalateClose(): Promise<void> {
    if (this.terminal === undefined && !(await this.waitForTerminal(CLOSE_GRACE_MS))) {
      this.signalProcessTree('SIGTERM');
    }
    if (this.treeIsAlive()) {
      this.signalProcessTree('SIGTERM');
      await this.waitForTreeExit(CLOSE_GRACE_MS);
    }
    if (this.treeIsAlive()) {
      this.signalProcessTree('SIGKILL');
      await this.waitForTreeExit(CLOSE_KILL_MS);
    }
    if (this.treeIsAlive()) {
      this.replaceGenericTerminalError(
        new Error('MCP observed process tree did not terminate after bounded close escalation.'),
      );
    }
    if (this.terminal === undefined && !(await this.waitForTerminal(CLOSE_KILL_MS))) {
      this.replaceGenericTerminalError(
        new Error('MCP root process did not terminate after bounded close escalation.'),
      );
    }
  }

  private async assessCloseIntegrity(): Promise<void> {
    if (!this.trackingReliable()) {
      this.replaceGenericTerminalError(
        new Error(
          'MCP descendant tracking became unavailable; cleanup of unobserved descendants cannot be verified.',
        ),
      );
    }
    if (!(await this.waitForCloseObserved(CLOSE_GRACE_MS))) {
      this.replaceGenericTerminalError(
        new Error(
          'MCP root exited but inherited stdio did not close; an unobserved detached descendant may remain.',
        ),
      );
    }
  }

  private finalizeClose(child: ChildProcessWithoutNullStreams | undefined): void {
    if (!this.closeObserved) {
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      this.child = undefined;
      this.stderrStream.end();
    }
    if (this.processTree !== undefined) stopProcessTreeTracking(this.processTree);
    this.clearPendingLine();
    this.notifyClosed();
  }

  private async closeImpl(): Promise<void> {
    const child = this.child;
    if (child === undefined && this.processTree === undefined) {
      this.notifyClosed();
      if (this.fatalError !== undefined) throw this.fatalError;
      return;
    }
    try {
      this.requestInitialClose(child);
      await this.escalateClose();
      await this.assessCloseIntegrity();
      if (this.fatalError !== undefined) throw this.fatalError;
    } finally {
      this.finalizeClose(child);
    }
  }
}

export function defaultConnectionFactory(options: McpConnectionOptions): McpConnection {
  const transport = new BoundedStdioClientTransport({
    ...options,
    maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_MCP_STDOUT_BYTES,
  });
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  return {
    callTool: (input, timeoutMs) =>
      client.callTool({ arguments: input.arguments, name: input.name }, undefined, {
        timeout: timeoutMs,
      }),
    close: async () => {
      let clientError: unknown;
      try {
        await client.close();
      } catch (error) {
        clientError = error;
      }
      let transportError: unknown;
      try {
        await transport.close();
      } catch (error) {
        transportError = error;
      }
      if (transportError !== undefined) throw errorFromUnknown(transportError);
      const protocolError = transport.protocolError();
      if (protocolError !== undefined) throw protocolError;
      if (clientError !== undefined) throw errorFromUnknown(clientError);
    },
    connect: (timeoutMs) => client.connect(transport, { timeout: timeoutMs }),
    listTools: (timeoutMs) => client.listTools(undefined, { timeout: timeoutMs }),
    serverVersion: () => client.getServerVersion(),
    stderr: transport.stderr,
  };
}
