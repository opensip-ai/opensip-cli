/**
 * `refresh_graph` — the single state-changing op (ADR-0084, Task 4.4).
 *
 * Rebuilds the call-graph catalog through the graph engine's programmatic build
 * (`runGraph`, wired by the host into `graphPort.refresh()`), persists it to the
 * shared datastore, and atomically swaps the in-memory generation. Concurrent
 * calls are serialized to ONE rebuild inside the port. v1 uses the exact
 * single-program build (no cloud egress, no live render).
 *
 * COST WARNING (also in the tool description): a rebuild parses the whole
 * project — agents must NOT loop it per query. Call it once when the catalog is
 * missing/stale (other tools report `freshness.fresh === false`), then read.
 *
 * Observability: emits `mcp.refresh.run[.ok|.error]` to the stderr logger and
 * (fire-and-forget, no-op when telemetry is disabled) records rebuild latency on
 * the `opensip-cli` meter with bounded labels `{ command, op, outcome }` — never
 * a path/id/symbol.
 */

import { getMeter, logger } from '@opensip-cli/core';

import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const LOG_MODULE = 'mcp:refresh';

/** Record rebuild latency on the shared meter (no-op until an OTel SDK is registered). */
function recordRefreshLatency(durationMs: number, outcome: 'ok' | 'error'): void {
  try {
    getMeter('opensip-cli')
      .createHistogram('opensip_cli.mcp.refresh.duration_ms')
      .record(durationMs, { command: 'mcp', op: 'refresh', outcome });
  } catch {
    // Telemetry is best-effort; a meter failure must never fail a refresh.
  }
}

export function registerRefreshGraph(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'refresh_graph',
    {
      title: 'Rebuild the call graph',
      description:
        'Rebuild the OpenSIP call-graph catalog from the current working tree (the only ' +
        'state-changing tool). EXPENSIVE — it parses the whole project; do NOT loop it per ' +
        'query. Call it once when other tools report a stale or missing catalog ' +
        '(freshness.fresh === false), then read. Returns { builtAt, durationMs, freshness }.',
    },
    async () => {
      const startedAt = Date.now();
      try {
        const outcome = await deps.graph.refresh();
        const durationMs = Date.now() - startedAt;
        if (!outcome.ok) {
          logger.error({
            evt: 'mcp.refresh.run.error',
            module: LOG_MODULE,
            code: outcome.error.code,
            durationMs,
          });
          recordRefreshLatency(durationMs, 'error');
          return errorResult(outcome.error);
        }
        const freshness = deps.graph.freshness();
        logger.info({ evt: 'mcp.refresh.run.ok', module: LOG_MODULE, durationMs });
        recordRefreshLatency(durationMs, 'ok');
        return jsonResult({ builtAt: outcome.value.data.builtAt, durationMs, freshness });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        logger.error({
          evt: 'mcp.refresh.run.error',
          module: LOG_MODULE,
          error: error instanceof Error ? error.message : String(error),
          durationMs,
        });
        recordRefreshLatency(durationMs, 'error');
        // A genuine build failure is an infra boundary: re-throw so the SDK emits
        // a JSON-RPC error frame (the server's dispatch logs the decision point).
        throw error;
      }
    },
  );
}
