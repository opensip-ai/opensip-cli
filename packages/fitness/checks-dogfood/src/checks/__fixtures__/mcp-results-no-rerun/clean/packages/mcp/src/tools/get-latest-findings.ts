// CLEAN: a result tool that replays a persisted session through the injected
// ResultsReadPort — it imports NO run-command entry point (ADR-0084 replay-only).
import { jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';

export function registerGetLatestFindings(deps: McpToolDeps): unknown {
  return async (tool: string) => {
    const outcome = await deps.results.latestFindings({ tool });
    return jsonResult(outcome);
  };
}
