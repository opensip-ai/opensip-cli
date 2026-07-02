/**
 * `review_change` — one-call persisted review brief for agents.
 *
 * Reads `resultsPort.reviewChange()` plus graph freshness from the injected
 * graph port. It replays stored suite step sessions only; it never re-runs a
 * tool and never reads raw logs or SQLite directly.
 */

import { z } from 'zod';

import {
  filePath as filePathSchema,
  limit as limitSchema,
  suiteName as suiteNameSchema,
  suiteRunId as suiteRunIdSchema,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerReviewChange(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'review_change',
    {
      title: 'Review a stored OpenSIP suite run',
      description:
        'Use this OpenSIP MCP result tool first for PR review or changed-code review ' +
        'questions when OpenSIP evidence already exists. It rebuilds the v1 ReviewBrief ' +
        'from persisted suite step sessions, includes graph freshness, and never re-runs ' +
        'fit/graph/yagni/sim. Do not grep .runtime/logs, read datastore.sqlite directly, ' +
        'or re-run a CLI tool to answer stored review questions.',
      inputSchema: {
        suiteRunId: suiteRunIdSchema().optional(),
        suite: suiteNameSchema().optional(),
        files: z.array(filePathSchema()).max(100).optional(),
        limit: limitSchema(),
      },
    },
    async ({ suiteRunId, suite, files, limit }) => {
      const outcome = await deps.results.reviewChange({
        ...(suiteRunId === undefined ? {} : { suiteRunId }),
        ...(suite === undefined ? {} : { suite }),
        ...(files === undefined ? {} : { files }),
        ...(limit === undefined ? {} : { limit }),
        graphFreshness: deps.graph.freshness(),
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
