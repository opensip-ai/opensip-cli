import { registerCompareToBaseline } from './compare-to-baseline.js';
import { registerGetAgentCatalog } from './get-agent-catalog.js';
import { registerGetLatestFindings } from './get-latest-findings.js';
import { registerListRuns } from './list-runs.js';
import { registerReviewChange } from './review-change.js';
import { registerShowRun } from './show-run.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

/** Register result/history tools (over ResultsReadPort — replay only). */
export function registerResultTools(server: McpStdioServer, deps: McpToolDeps): void {
  registerGetAgentCatalog(server, deps);
  registerListRuns(server, deps);
  registerShowRun(server, deps);
  registerGetLatestFindings(server, deps);
  registerReviewChange(server, deps);
  registerCompareToBaseline(server, deps);
}
