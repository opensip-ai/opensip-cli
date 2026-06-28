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
import { runGraph } from '@opensip-cli/graph/internal';

import { workingTreeContextFromCatalog } from './freshness.js';
import { McpStdioServer } from './server.js';
import { SessionResultsReadPort } from './session-results-read-port.js';
import { SqliteGraphReadPort } from './sqlite-graph-read-port.js';
import { registerMcpTools } from './tools/register.js';

import type { RunScope, ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';
import type { Catalog } from '@opensip-cli/graph';

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
    //
    // Freshness (Task 4.4): the provider derives the working-tree
    // `ValidationContext` from the served catalog's OWN recorded inputs
    // (`workingTreeContextFromCatalog`) — the file set (recovered from the
    // persisted `filesFingerprint`, in order) plus the catalog's language +
    // cacheKey. `classifyCatalog` then re-stats those files, so a mutated/deleted
    // tracked file flips `fresh` to false. (Newly-added files / a tsconfig change
    // are catalog-additive and resolved by the explicit `refresh_graph` op — see
    // the helper's doc for the precise approximation.)
    //
    // Rebuild (Task 4.4): `refresh_graph` runs the graph engine's programmatic
    // build (`runGraph`) over the project root, threading the same datastore so
    // the rebuilt catalog persists where the port reads it. v1 is the exact
    // single-program build (no cloud egress, no live render).
    const projectRoot = scope.projectContext?.projectRoot ?? process.cwd();
    /**
     * The `refresh_graph` rebuild thunk: runs the graph engine's programmatic
     * build over the project root and returns the fresh catalog.
     *
     * @throws {Error} when the build discovers no source files (no catalog
     *   produced) — surfaced to the refresh tool as an infra-boundary failure.
     */
    async function rebuild(): Promise<Catalog> {
      const outcome = await runGraph({ cwd: projectRoot, datastore: store });
      if (outcome.catalog === null) {
        throw new Error('graph rebuild produced no catalog (no source files discovered).');
      }
      return outcome.catalog;
    }
    const graph = new SqliteGraphReadPort({
      store,
      freshnessContext: workingTreeContextFromCatalog,
      rebuild,
    });
    const results = new SessionResultsReadPort({ store, tools: scope.tools });

    const server = new McpStdioServer({
      scope,
      graph,
      results,
      version: readPackageVersion(import.meta.url),
    });

    // Mount the tool catalog through the server's scope-wrapping register seam.
    // `validToolIds` lets the result tools reject an unknown `tool` argument. It
    // must be the per-tool LAYOUT KEY (`fit`/`sim`/`graph`/`yagni`) — the key
    // sessions are stored under and the value `sessions show --tool <k>` accepts —
    // NOT `identity.name` (`fitness`/`simulation`), or `get_latest_findings({ tool:
    // 'fit' })`, the headline result-first path, would be rejected as unknown.
    const validToolIds = new Set(
      scope.tools.list().map((t) => t.identity.layoutKey ?? t.identity.name),
    );
    // `void`: registerMcpTools is synchronous (returns void); the leading `void`
    // marks the discard explicitly so the detached-promises heuristic (which can't
    // see cross-file sync callables) doesn't read this floating call as a promise.
    void registerMcpTools(server, { graph, results, validToolIds });

    // Block for the serve lifetime; resolves on stdin EOF (or graceful SIGINT).
    await server.serve();
    cli.setExitCode(0);
  },
});
