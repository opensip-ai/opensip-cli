// VIOLATION: an MCP result tool that imports a run-command entry point and
// re-runs the underlying tool inline — bypassing the ResultsReadPort replay
// contract (ADR-0084). A result tool must replay persisted sessions, never re-run.
import { runFit } from '@opensip-cli/fitness';
import { runGraph } from '@opensip-cli/graph/internal';

import { jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';

export function registerGetLatestFindings(deps: McpToolDeps): unknown {
  return async (tool: string, cwd: string) => {
    // Re-running OpenSIP from a result tool — the forbidden coupling.
    const fit = await runFit({ cwd });
    const graph = await runGraph({ cwd });
    return jsonResult({ tool, deps, fit, graph });
  };
}
