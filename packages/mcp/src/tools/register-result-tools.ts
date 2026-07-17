import { registerCompareToBaseline } from './compare-to-baseline.js';
import { registerGetAgentCatalog } from './get-agent-catalog.js';
import { registerGetLatestFindings } from './get-latest-findings.js';
import { registerListExecutionRuns } from './list-execution-runs.js';
import { registerListRuns } from './list-runs.js';
import { registerReviewChange } from './review-change.js';
import { registerShowExecutionRun } from './show-execution-run.js';
import { registerShowRun } from './show-run.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

/** Register persisted execution-ledger and Tool Session replay reads. */
export function registerResultTools(server: McpStdioServer, deps: McpToolDeps): void {
  registerGetAgentCatalog(server, deps);
  registerListExecutionRuns(server, deps);
  registerShowExecutionRun(server, deps);
  registerListRuns(server, deps);
  registerShowRun(server, deps);
  registerGetLatestFindings(server, deps);
  registerReviewChange(server, deps);
  registerCompareToBaseline(server, deps);
}
