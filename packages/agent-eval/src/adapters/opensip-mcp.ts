import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeStepRecord } from '../model/record.js';
import { buildDeterministicEnv } from '../runner/env.js';
import { safeErrorDetail } from '../runner/error-detail.js';
import { HarnessPrerequisiteError, resolveCliDist } from '../runner/spawn.js';

import {
  BoundedByteRing,
  DEFAULT_MAX_MCP_TOOL_CALLS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_MCP_TOOL_CALLS,
  cumulativeMcpStdoutByteLimit,
  defaultConnectionFactory,
  mcpRawFrameByteLimit,
  positiveBoundedInteger,
  type McpConnection,
  type McpConnectionFactory,
} from './opensip-mcp-connection.js';
import {
  listToolNames,
  parseCatalogResult,
  verifySurface,
  type VerifiedSurface,
} from './opensip-mcp-handshake.js';
import { decodeToolResult, inspectToolEnvelope } from './opensip-mcp-protocol.js';

import type { McpSetupProvenance, StepRecord, ToolInvoker } from '../model/record.js';
import type { ProofClosureAssessment, ResolvedStrategyStep, RunLeg } from '../model/task.js';

export { EXPECTED_MCP_SURFACE_EPOCH, REQUIRED_MCP_TOOL_NAMES } from './opensip-mcp-handshake.js';
export type {
  McpConnection,
  McpConnectionFactory,
  McpConnectionOptions,
} from './opensip-mcp-connection.js';

/** Connection, environment, and resource bounds for one MCP arm session. */
export interface McpArmSessionOptions {
  /** The Node executable that runs the MCP entrypoint; defaults to this process's Node. */
  readonly cliCommand?: string;
  /** Resolves the CLI JS entrypoint; production injects the run's CLI target, tests a stub. */
  readonly cliDistResolver?: () => string;
  /** Node arguments that load the installed target's verified-byte snapshot. */
  readonly cliPreludeArgs?: readonly string[];
  readonly connectionFactory?: McpConnectionFactory;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxResponseBytes?: number;
  readonly maxStderrBytes?: number;
  /** Maximum post-handshake MCP tool calls in this session. */
  readonly maxToolCalls?: number;
  readonly requestTimeoutMs?: number;
  /** Test-only owned-directory cleanup seam. */
  readonly removeOwnedHome?: (path: string) => void;
  /** Verifies the selected installed target before launch and after process close. */
  readonly targetStabilityCheck?: () => void;
  readonly workspaceRoot: string;
}

function stepLeg(step: ResolvedStrategyStep): RunLeg {
  return step.leg ?? 'main';
}

type McpSessionFailureCondition =
  'connect' | 'connection-close' | 'owned-home-remove' | 'target-stability';

interface McpSessionFailure {
  readonly condition: McpSessionFailureCondition;
  readonly error: unknown;
}

function removeOwnedHomeDirectory(path: string): void {
  rmSync(path, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 50,
  });
}

function captureLifecycleFailure(
  condition: McpSessionFailureCondition,
  operation: () => void,
): McpSessionFailure | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return { condition, error };
  }
}

async function captureAsyncLifecycleFailure(
  condition: McpSessionFailureCondition,
  operation: () => Promise<void>,
): Promise<McpSessionFailure | undefined> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return { condition, error };
  }
}

function lifecyclePrerequisiteError(
  context: string,
  primary: McpSessionFailure,
  failures: readonly McpSessionFailure[],
  sensitivePaths: readonly string[],
): HarnessPrerequisiteError {
  const related = failures.filter((failure) => failure !== primary);
  if (primary.error instanceof HarnessPrerequisiteError && related.length === 0) {
    return primary.error;
  }
  const primaryMessage =
    primary.error instanceof HarnessPrerequisiteError
      ? primary.error.message
      : `${context}: ${safeErrorDetail(primary.error, sensitivePaths) || 'unknown failure'}`;
  if (related.length === 0) return new HarnessPrerequisiteError(primaryMessage);
  const relatedDetail = related
    .map(
      (failure) =>
        `${failure.condition}: ${safeErrorDetail(failure.error, sensitivePaths) || 'unknown failure'}`,
    )
    .join('; ');
  return new HarnessPrerequisiteError(`${primaryMessage} Related failures: ${relatedDetail}`);
}

interface McpArmSessionState {
  readonly connection: McpConnection;
  readonly handshakeDurationMs: number;
  readonly maxResponseBytes: number;
  readonly maxToolCalls: number;
  readonly ownedHome: string | undefined;
  readonly requestTimeoutMs: number;
  readonly removeOwnedHome: (path: string) => void;
  readonly sensitivePaths: readonly string[];
  readonly stderr: BoundedByteRing;
  readonly surface: VerifiedSurface;
  readonly targetStabilityCheck: (() => void) | undefined;
}

/** One real, read-only MCP process bound to one project workspace. */
export class McpArmSession {
  private readonly connection: McpConnection;
  private readonly handshakeDurationMs: number;
  private readonly maxResponseBytes: number;
  private remainingToolCalls: number;
  private readonly ownedHome: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly removeOwnedHome: (path: string) => void;
  private readonly sensitivePaths: readonly string[];
  private readonly stderr: BoundedByteRing;
  private readonly surface: VerifiedSurface;
  private readonly targetStabilityCheck: (() => void) | undefined;

  private constructor(state: McpArmSessionState) {
    this.connection = state.connection;
    this.handshakeDurationMs = state.handshakeDurationMs;
    this.maxResponseBytes = state.maxResponseBytes;
    this.remainingToolCalls = state.maxToolCalls;
    this.ownedHome = state.ownedHome;
    this.requestTimeoutMs = state.requestTimeoutMs;
    this.removeOwnedHome = state.removeOwnedHome;
    this.sensitivePaths = state.sensitivePaths;
    this.stderr = state.stderr;
    this.surface = state.surface;
    this.targetStabilityCheck = state.targetStabilityCheck;
  }

  /**
   * Start a read-only MCP process and verify its complete public surface.
   *
   * @throws {RangeError} When a configured resource bound is invalid.
   * @throws {HarnessPrerequisiteError} When the CLI, connection, or handshake is unavailable.
   */
  public static async connect(options: McpArmSessionOptions): Promise<McpArmSession> {
    const requestTimeoutMs = positiveBoundedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      10 * DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    const maxStderrBytes = positiveBoundedInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      1024 * 1024,
      'maxStderrBytes',
    );
    const maxResponseBytes = positiveBoundedInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      64 * 1024 * 1024,
      'maxResponseBytes',
    );
    const maxToolCalls = positiveBoundedInteger(
      options.maxToolCalls,
      DEFAULT_MAX_MCP_TOOL_CALLS,
      MAX_MCP_TOOL_CALLS,
      'maxToolCalls',
    );
    const maxStdoutBytes = cumulativeMcpStdoutByteLimit(maxResponseBytes, maxToolCalls);
    const maxFrameBytes = mcpRawFrameByteLimit(maxResponseBytes);
    const connectionFactory = options.connectionFactory ?? defaultConnectionFactory;
    const cliCommand = options.cliCommand ?? process.execPath;
    const cliDistResolver = options.cliDistResolver ?? resolveCliDist;
    const removeOwnedHome = options.removeOwnedHome ?? removeOwnedHomeDirectory;
    const ownedHome =
      options.env?.HOME === undefined
        ? mkdtempSync(join(tmpdir(), 'opensip-agent-eval-home-'))
        : undefined;
    const stderr = new BoundedByteRing(maxStderrBytes);
    const startedAt = performance.now();
    const sensitivePaths = [options.workspaceRoot, options.env?.HOME, ownedHome].filter(
      (value): value is string => value !== undefined,
    );
    let connection: McpConnection | undefined;
    try {
      options.targetStabilityCheck?.();
      // Resolve immediately after the single boundary check and before
      // constructing the process transport. Do not cache this across setup.
      const cliDist = cliDistResolver();
      connection = connectionFactory({
        args: [...(options.cliPreludeArgs ?? []), cliDist, 'mcp', '--cwd', options.workspaceRoot],
        command: cliCommand,
        cwd: options.workspaceRoot,
        env: buildDeterministicEnv({
          ...options.env,
          ...(ownedHome === undefined ? {} : { HOME: ownedHome }),
        }),
        maxFrameBytes,
        maxStdoutBytes,
      });
      connection.stderr?.on('data', (chunk: unknown) => stderr.append(chunk));
      // @fitness-ignore-next-line async-waterfall-detection -- Surface discovery cannot begin until the stdio MCP transport has connected.
      await connection.connect(requestTimeoutMs);
      const [catalogResult, listedResult] = await Promise.all([
        connection.callTool({ arguments: {}, name: 'get_agent_catalog' }, requestTimeoutMs),
        connection.listTools(requestTimeoutMs),
      ]);
      const catalog = parseCatalogResult(catalogResult, maxResponseBytes);
      const listedNames = listToolNames(listedResult, maxResponseBytes);
      const surface = verifySurface(
        catalog,
        listedNames,
        connection.serverVersion(),
        options.workspaceRoot,
      );
      return new McpArmSession({
        connection,
        handshakeDurationMs: Math.max(0, performance.now() - startedAt),
        maxResponseBytes,
        maxToolCalls,
        ownedHome,
        requestTimeoutMs,
        removeOwnedHome,
        sensitivePaths,
        stderr,
        surface,
        targetStabilityCheck: options.targetStabilityCheck,
      });
    } catch (error) {
      const connectFailure: McpSessionFailure = { condition: 'connect', error };
      const retainedConnection = connection;
      const closeFailure =
        retainedConnection === undefined
          ? undefined
          : await captureAsyncLifecycleFailure('connection-close', () =>
              retainedConnection.close(),
            );
      const homeFailure =
        ownedHome === undefined
          ? undefined
          : captureLifecycleFailure('owned-home-remove', () => removeOwnedHome(ownedHome));
      const stabilityFailure = captureLifecycleFailure('target-stability', () =>
        options.targetStabilityCheck?.(),
      );
      const failures = [
        connectFailure,
        ...(closeFailure === undefined ? [] : [closeFailure]),
        ...(homeFailure === undefined ? [] : [homeFailure]),
        ...(stabilityFailure === undefined ? [] : [stabilityFailure]),
      ];
      // Installed-target mutation remains authoritative, but every preceding
      // connect/rollback failure stays visible as bounded related evidence.
      const primary = stabilityFailure ?? connectFailure;
      throw lifecyclePrerequisiteError(
        'Unable to connect to the OpenSIP MCP server',
        primary,
        failures,
        sensitivePaths,
      );
    }
  }

  public provenance(): McpSetupProvenance {
    return {
      handshakeDurationMs: this.handshakeDurationMs,
      mutationPosture: this.surface.mutationPosture,
      projectRootVerified: true,
      projectScope: this.surface.projectScope,
      stderr: this.stderr.summary(),
      surfaceEpoch: this.surface.surfaceEpoch,
      surfaceVerified: true,
      toolCount: this.surface.toolCount,
      toolNames: this.surface.toolNames,
      version: this.surface.version,
    };
  }

  /**
   * Invoke one resolved MCP step and convert its response into a durable record.
   *
   * @throws {HarnessPrerequisiteError} When the MCP transport becomes unavailable.
   */
  public async callTool(step: ResolvedStrategyStep): Promise<StepRecord> {
    if (this.remainingToolCalls <= 0) {
      throw new HarnessPrerequisiteError(
        'OpenSIP MCP session exceeded its bounded tool-call budget.',
      );
    }
    this.remainingToolCalls -= 1;
    const startedAt = performance.now();
    let result: unknown;
    try {
      result = await this.connection.callTool(
        { arguments: step.arguments, name: step.tool },
        this.requestTimeoutMs,
      );
    } catch (error) {
      throw new HarnessPrerequisiteError(
        `OpenSIP MCP server became unavailable while calling ${step.tool}: ${safeErrorDetail(error, this.sensitivePaths)}`,
      );
    }
    const decoded = decodeToolResult(result, this.maxResponseBytes);
    if (decoded.failure !== undefined || decoded.payload === undefined) {
      return makeStepRecord({
        failure: {
          code: decoded.failure?.code ?? 'malformed-mcp-result',
          kind: decoded.failure?.kind ?? 'protocol',
          message: decoded.failure?.message ?? 'MCP tool returned no decoded payload.',
        },
        leg: stepLeg(step),
        renderedResponse: decoded.rendered,
        step,
        truncated: decoded.truncated,
        wallMs: Math.max(0, performance.now() - startedAt),
      });
    }
    const envelope = inspectToolEnvelope(decoded.payload, step.tool, this.surface.projectRoot);
    if (envelope.failure !== undefined) {
      return makeStepRecord({
        failure: {
          code: envelope.failure.code,
          kind: 'protocol',
          message: envelope.failure.message,
        },
        leg: stepLeg(step),
        renderedResponse: decoded.rendered,
        step,
        wallMs: Math.max(0, performance.now() - startedAt),
      });
    }
    let facts;
    let proofClosure: ProofClosureAssessment | undefined;
    try {
      facts = step.extract(decoded.payload);
      proofClosure = step.assessProofClosure?.(decoded.payload);
    } catch (error) {
      return makeStepRecord({
        failure: {
          code: 'mcp-extractor-failure',
          kind: 'protocol',
          message: safeErrorDetail(error, this.sensitivePaths),
        },
        leg: stepLeg(step),
        renderedResponse: decoded.rendered,
        step,
        wallMs: Math.max(0, performance.now() - startedAt),
      });
    }
    return makeStepRecord({
      ...(envelope.coverage === undefined ? {} : { coverage: envelope.coverage }),
      ...(envelope.freshness === undefined ? {} : { freshness: envelope.freshness }),
      catalogIdentity: envelope.catalogIdentity,
      facts,
      leg: stepLeg(step),
      nextCursor: envelope.nextCursor,
      proofClosure,
      renderedResponse: decoded.rendered,
      step,
      wallMs: Math.max(0, performance.now() - startedAt),
    });
  }

  public invoker(): ToolInvoker {
    return (step) => this.callTool(step);
  }

  public async close(): Promise<void> {
    const connectionFailure = await captureAsyncLifecycleFailure('connection-close', () =>
      this.connection.close(),
    );
    const stabilityFailure = captureLifecycleFailure('target-stability', () =>
      this.targetStabilityCheck?.(),
    );
    const ownedHome = this.ownedHome;
    const homeFailure =
      ownedHome === undefined
        ? undefined
        : captureLifecycleFailure('owned-home-remove', () => this.removeOwnedHome(ownedHome));
    const failures = [
      ...(connectionFailure === undefined ? [] : [connectionFailure]),
      ...(stabilityFailure === undefined ? [] : [stabilityFailure]),
      ...(homeFailure === undefined ? [] : [homeFailure]),
    ];
    const primary = stabilityFailure ?? connectionFailure ?? homeFailure;
    if (primary !== undefined) {
      throw lifecyclePrerequisiteError(
        'Unable to close the OpenSIP MCP session',
        primary,
        failures,
        this.sensitivePaths,
      );
    }
  }
}
