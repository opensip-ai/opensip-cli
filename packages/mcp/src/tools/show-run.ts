/**
 * `show_run` — replay one stored run (ADR-0084, Task 4.5).
 *
 * Reads `resultsPort.showRun()` ONLY — resolves the ref (a session id or the
 * `latest` sentinel, which requires `tool`), decodes the persisted payload, and
 * applies the same agent filters/raw shape as CLI `sessions show`. Carries
 * session provenance + `recommendedNext`. Never re-runs a tool.
 */

import { z } from 'zod';

import { toolId as toolIdSchema } from './schemas.js';
import { errorResult, jsonResult, unknownToolError } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerShowRun(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'show_run',
    {
      title: 'Show an OpenSIP run',
      description:
        'Replay a stored OpenSIP run by id, or "latest" (with `tool`). Returns the decoded ' +
        'finding envelope plus session provenance and recommendedNext commands — the same ' +
        'filters/raw shape as `opensip sessions show`. Use `filters` (e.g. errors-only, ' +
        'warnings-only, top:N) to narrow. Replays persisted data; never re-runs the tool.',
      inputSchema: {
        ref: z.string().min(1).max(128),
        tool: toolIdSchema().optional(),
        filters: z.array(z.string().min(1).max(64)).max(16).optional(),
        raw: z.boolean().optional(),
      },
    },
    async ({ ref, tool, filters, raw }) => {
      if (tool !== undefined && !deps.validToolIds.has(tool)) {
        return unknownToolError(tool, deps.validToolIds);
      }
      const outcome = await deps.results.showRun({
        ref,
        ...(tool === undefined ? {} : { tool }),
        ...(filters === undefined ? {} : { filters }),
        ...(raw === undefined ? {} : { raw }),
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
