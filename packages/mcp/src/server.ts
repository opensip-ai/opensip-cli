/**
 * The stdio MCP server (ADR-0084).
 *
 * `opensip mcp` is the first long-lived, BLOCKING command in opensip-cli. Two
 * properties make its construction unusual and are the whole point of this file:
 *
 *   1. **Scope captured, never ambient.** The MCP SDK dispatches tool handlers
 *      off an internal EventEmitter, so `currentScope()` (AsyncLocalStorage) does
 *      NOT propagate into them — a handler that read `currentScope()` would find
 *      `undefined` and silently degrade (no datastore, no logger runId). The fix
 *      is to capture the `RunScope` at construction and re-enter it per call via
 *      `runWithScope(capturedScope, …)` (see {@link McpStdioServer.register}). The
 *      ports are likewise PRE-BUILT and injected; handlers never reach for scope.
 *
 *   2. **stdout is JSON-RPC only.** The stdio transport owns stdout for the
 *      protocol frames. Every diagnostic must go to stderr. The `@opensip-cli/core`
 *      structured logger never writes stdout (it writes the per-project log file
 *      and — in debug mode — stderr), so we route its sink to stderr for the serve
 *      lifetime via the `configureLogger` seam and emit only at decision points
 *      (`mcp.server.start|stop`, `mcp.tool.dispatch[.ok|.error]`). No `console.*`
 *      / `process.stdout.write` for diagnostics anywhere in the serve path.
 *
 * No tools are registered here yet — Phase 4 mounts the catalog onto this server
 * through the {@link McpStdioServer.register} seam (which guarantees the
 * scope-wrap for every handler). The server resolves its lifetime promise on
 * stdin EOF (or a SIGINT-driven graceful close); it never calls `process.exit`,
 * leaving the final exit code to the host command handler.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configureLogger, logger, runWithScope } from '@opensip-cli/core';

import type { GraphReadPort } from './graph-read-port.js';
import type { ResultsReadPort } from './results-read-port.js';
import type { RunScope } from '@opensip-cli/core';

/** Server identity advertised in the MCP `initialize` handshake. */
const SERVER_NAME = 'opensip-cli-mcp';
/** `module` field stamped on every structured logger event from this file. */
const LOG_MODULE = 'mcp:server';

// Derive the SDK's tool-registration shapes from its own generic `registerTool`
// so this file needs no SDK-internal subpath type imports (the SDK's public
// surface is the `./server/mcp.js` value import).
type SdkRegisterTool = McpServer['registerTool'];
/** The MCP tool-call result the SDK serialises into a JSON-RPC reply. */
export type CallToolResult = Awaited<ReturnType<Parameters<SdkRegisterTool>[2]>>;

/** Construction deps — captured ONCE; handlers never read ambient scope. */
export interface McpStdioServerDeps {
  /**
   * The `RunScope` the host entered for this invocation. Captured here and
   * re-entered (`runWithScope`) around every tool handler — the load-bearing
   * fix for the SDK's EventEmitter dispatch dropping AsyncLocalStorage.
   */
  readonly scope: RunScope;
  /** Pre-built graph read port (Phase 2). */
  readonly graph: GraphReadPort;
  /** Pre-built results/history read port (Phase 2). */
  readonly results: ResultsReadPort;
  /** Server version advertised in the handshake (the `@opensip-cli/mcp` version). */
  readonly version: string;
}

/**
 * A long-lived stdio MCP server bound to one captured {@link RunScope}.
 *
 * Construct with pre-built ports + the captured scope, register tools through
 * {@link register} (Phase 4), then `await serve()` — the promise resolves when
 * the transport closes (stdin EOF / graceful SIGINT).
 */
export class McpStdioServer {
  private readonly mcp: McpServer;
  private readonly transport: StdioServerTransport;
  private readonly scope: RunScope;
  private readonly version: string;
  /** The graph read port handlers close over (Phase 4 reads it). */
  readonly graph: GraphReadPort;
  /** The results read port handlers close over (Phase 4 reads it). */
  readonly results: ResultsReadPort;

  constructor(deps: McpStdioServerDeps) {
    this.scope = deps.scope;
    this.graph = deps.graph;
    this.results = deps.results;
    this.version = deps.version;
    this.mcp = new McpServer({ name: SERVER_NAME, version: deps.version });
    // Default stdin/stdout; the transport owns stdout for JSON-RPC frames.
    this.transport = new StdioServerTransport();
  }

  /**
   * Register a tool, wrapping its handler so EVERY dispatch re-enters the
   * captured scope (`runWithScope`) and is bracketed by `mcp.tool.dispatch`
   * decision-point logging. The public signature is exactly the SDK's
   * `registerTool` (full generic fidelity for the Phase-4 call sites); the thin
   * forwarder casts internally because it is scope-/schema-agnostic.
   */
  register: SdkRegisterTool = (name, config, cb) => {
    const handler = cb as (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
    const wrapped = (...args: unknown[]): Promise<CallToolResult> =>
      this.dispatch(name, () => handler(...args));
    // Forward the scope-wrapping handler back through the SDK's generic seam.
    // The forwarder is schema-agnostic, so the broad→narrow assignment is widened
    // through `unknown` (the public `register` signature stays the SDK's exact
    // generic for the Phase-4 call sites).
    return this.mcp.registerTool(name, config, wrapped as unknown as typeof cb);
  };

  /** Run one wrapped handler inside the captured scope, with decision logging. */
  private dispatch(
    name: string,
    run: () => CallToolResult | Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    return runWithScope(this.scope, async () => {
      logger.info({ evt: 'mcp.tool.dispatch', module: LOG_MODULE, tool: name });
      try {
        const result = await run();
        logger.info({ evt: 'mcp.tool.dispatch.ok', module: LOG_MODULE, tool: name });
        return result;
      } catch (error) {
        // The SDK converts a thrown handler into a JSON-RPC error frame; we log
        // the decision point (stderr sink) and re-throw at this infra boundary.
        logger.error({
          evt: 'mcp.tool.dispatch.error',
          module: LOG_MODULE,
          tool: name,
          error: errorMessage(error),
        });
        throw error;
      }
    });
  }

  /**
   * Serve until the stdio transport closes. Resolves on stdin EOF (or a
   * SIGINT-driven graceful close). Never calls `process.exit` — the host command
   * handler resolves cleanly and owns the final exit code (ADR-0084).
   */
  async serve(): Promise<void> {
    // Route the structured logger sink to stderr for the serve lifetime: stdout
    // is reserved for JSON-RPC frames. The logger never writes stdout; its only
    // non-file destination is stderr, gated behind debug — so we enable it here
    // (the documented `configureLogger` sink seam) and keep stdout pristine.
    configureLogger({ silent: false, debugMode: true });
    logger.info({
      evt: 'mcp.server.start',
      module: LOG_MODULE,
      server: SERVER_NAME,
      version: this.version,
    });

    const closed = new Promise<void>((resolve) => {
      // The underlying protocol invokes `onclose` when the transport closes
      // (via an explicit `close()`); resolving here ends `serve()`.
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's `Server`/`Protocol` exposes a plain `onclose` callback property, NOT a DOM EventTarget; there is no `addEventListener` to prefer.
      this.mcp.server.onclose = resolve;
    });

    // `StdioServerTransport` only listens for stdin `data`/`error` — it does NOT
    // close on EOF. So we own the graceful-shutdown triggers and translate each
    // into a single `close()` (which drives the protocol `onclose` above):
    //   - stdin EOF (`end`/`close`): the client hung up the transport.
    //   - SIGINT: Ctrl-C. No `process.exit` here — the command handler resolves
    //     cleanly and the host sets the final exit code (ADR-0084 §shutdown).
    const shutdown = (): void => {
      void this.mcp.close();
    };
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    process.once('SIGINT', shutdown);

    try {
      // `connect` starts the transport and begins reading stdin; it throws only
      // at the genuine stdio infra boundary (the transport failing to start).
      await this.mcp.connect(this.transport);
      await closed;
    } finally {
      process.stdin.removeListener('end', shutdown);
      process.stdin.removeListener('close', shutdown);
      process.removeListener('SIGINT', shutdown);
      logger.info({ evt: 'mcp.server.stop', module: LOG_MODULE, server: SERVER_NAME });
    }
  }
}

/** Bounded, secret-free message extraction for the stderr error log. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
