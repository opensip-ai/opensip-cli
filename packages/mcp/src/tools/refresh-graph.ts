/**
 * `refresh_graph` — the single state-changing graph op.
 *
 * Syncs any externally persisted generation first; rebuilds only when missing/
 * stale or `forceRebuild` is true. Concurrent calls join one single-flight op.
 */

import { getMeter, logger } from '@opensip-cli/core';
import { z } from 'zod';

import { unexpectedRefreshError } from '../mcp-error.js';

import { strictInput } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const LOG_MODULE = 'mcp:refresh';

function recordRefreshLatency(durationMs: number, action: string, outcome: 'ok' | 'error'): void {
  try {
    getMeter('opensip-cli')
      .createHistogram('opensip_cli.mcp.refresh.duration_ms')
      .record(durationMs, {
        command: 'mcp',
        op: 'refresh_graph',
        action,
        outcome,
      });
  } catch {
    // Telemetry is best-effort.
  }
}

export function registerRefreshGraph(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'refresh_graph',
    {
      title: 'Rebuild the call graph',
      description:
        'Ensure the MCP server is serving a fresh graph catalog. Auto-loads a newer catalog ' +
        'already persisted by `opensip graph` without rebuilding. Rebuilds only when the ' +
        'catalog is missing/stale, or when forceRebuild is true. EXPENSIVE when it rebuilds — ' +
        'do NOT loop it per query. Returns action (no-op|reloaded|rebuilt), generation, and freshness.',
      inputSchema: strictInput({
        forceRebuild: z.boolean().optional(),
      }),
    },
    async ({ forceRebuild }) => {
      const startedAt = Date.now();
      try {
        const outcome = await deps.graph.refresh({
          forceRebuild: forceRebuild === true,
        });
        const durationMs = Date.now() - startedAt;
        if (!outcome.ok) {
          logger.error({
            evt: 'mcp.graph.refresh.failed',
            module: LOG_MODULE,
            outcome: 'failed',
            durationMs,
            failedPhase: outcome.error.details?.failedPhase,
            priorGenerationAvailable: outcome.error.details?.priorGenerationAvailable,
          });
          recordRefreshLatency(durationMs, 'failed', 'error');
          return errorResult(outcome.error);
        }
        const action = outcome.value.data.action;
        logger.info({
          evt: 'mcp.graph.refresh.completed',
          module: LOG_MODULE,
          action,
          durationMs,
          outcome: 'ok',
          priorGenerationAvailable: outcome.value.data.priorGenerationAvailable,
        });
        recordRefreshLatency(durationMs, action, 'ok');
        return jsonResult(outcome.value);
      } catch {
        const durationMs = Date.now() - startedAt;
        const failure = unexpectedRefreshError(durationMs);
        logger.error({
          evt: 'mcp.graph.refresh.failed',
          module: LOG_MODULE,
          outcome: 'failed',
          failedPhase: 'handler',
          durationMs,
        });
        recordRefreshLatency(durationMs, 'failed', 'error');
        return errorResult(failure);
      }
    },
  );
}
