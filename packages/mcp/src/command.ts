/**
 * The `opensip mcp` command (ADR-0084).
 *
 * A long-lived, BLOCKING stdio JSON-RPC server. `output: 'raw-stream'` +
 * `rawStreamReason: 'mcp-stdio'` because the protocol genuinely owns stdout: an
 * MCP client speaks JSON-RPC frames over this command's stdin/stdout for the
 * whole serve lifetime, so the host must render NOTHING and the handler owns its
 * entire output surface. This is the documented raw-stream escape hatch — NOT a
 * bypass of the `SignalEnvelope`/`CommandResult` currency: there is no run
 * verdict to render, only a transport. Every diagnostic goes to stderr (the
 * server routes the structured logger sink there for the serve lifetime); stdout
 * carries only JSON-RPC. See ADR-0084 and `server.ts`.
 *
 * The handler captures the entered `RunScope` (never `currentScope()`), opens the
 * per-run datastore through the documented `cli.scope.datastore()` seam, builds
 * the two read ports from it, and hands the captured scope + ports to the server
 * — which re-enters the scope around every tool dispatch (the EventEmitter ALS
 * fix). It resolves to a clean exit (0) when the transport closes on stdin EOF.
 */
import { definePrimaryCommand, readPackageVersion } from '@opensip-cli/core';

import { McpStdioServer } from './server.js';
import { SessionResultsReadPort } from './session-results-read-port.js';
import { SqliteGraphReadPort } from './sqlite-graph-read-port.js';

import type { RunScope, ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

export const mcpCommandSpec = definePrimaryCommand<unknown, ToolCliContext>({
  description: 'Serve the OpenSIP call graph + stored results to MCP agents over stdio',
  commonFlags: ['cwd'],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'mcp-stdio',
  handler: async (_opts, cli) => {
    // The host enters a concrete `RunScope` for the project-scoped command and
    // hands it to tools as the narrowed `ToolScope` view; the MCP server needs
    // the full `RunScope` — for `runWithScope` re-entry AND the `tools` registry
    // the results port replays through — so we narrow back to the runtime type.
    // We capture it here (NOT `currentScope()`) because the SDK's EventEmitter
    // dispatch would lose the ambient scope inside tool handlers.
    const scope = cli.scope as RunScope;

    // Documented per-run datastore seam (no raw `DataStore.db`, no `SessionRepo`).
    const store = cli.scope.datastore() as DataStore | undefined;
    if (store === undefined) {
      await cli.reportFailure({
        message: 'opensip mcp requires a project datastore, but none is available.',
        suggestion:
          'Run `opensip mcp` from inside an opensip-cli project (where `opensip init` has been run).',
        code: 'MCP.DATASTORE_UNAVAILABLE',
        exitCode: 2,
        log: { evt: 'mcp.server.datastore_unavailable', level: 'error' },
      });
      return;
    }

    // Pre-build both read ports from the captured datastore (Phase 2 impls).
    // Freshness verification is wired in Phase 4 alongside the graph
    // adapter-discovery / `refresh` rebuild: a CORRECT working-tree
    // `ValidationContext` needs the engine's exact cache-key stamping + canonical
    // file-set reduction (the same internals `runGraph` brings in). Computing a
    // partial key now would mis-report every catalog as stale — strictly worse
    // than the port's graceful fallback, which reports a loaded catalog as
    // unverified-fresh (matching `opensip graph lookup`) and a missing catalog as
    // `fresh: false` with no silent auto-build. So no `freshnessContext` is wired
    // here; Phase 4 supplies the real provider + the `rebuild` thunk together.
    const graph = new SqliteGraphReadPort({ store });
    const results = new SessionResultsReadPort({ store, tools: scope.tools });

    const server = new McpStdioServer({
      scope,
      graph,
      results,
      version: readPackageVersion(import.meta.url),
    });

    // Block for the serve lifetime; resolves on stdin EOF (or graceful SIGINT).
    await server.serve();
    cli.setExitCode(0);
  },
});
