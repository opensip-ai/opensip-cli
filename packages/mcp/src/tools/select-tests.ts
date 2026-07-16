/** `select_tests` — evidence-labelled static candidates and safe commands. */

import {
  commandLimit,
  contextFiles,
  depth,
  pageLimit,
  proofLimit,
  strictInput,
  testProofDetail,
  testTier,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpStdioServer } from '../server.js';
import type { McpToolDeps } from './types.js';

export function registerSelectTests(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'select_tests',
    {
      title: 'Select static test evidence',
      description:
        'Select bounded static test candidates and allowlisted verification commands for explicit ' +
        'files. Candidates are not observed coverage and commands are never executed. Inspect ' +
        'trust, uncoveredFiles, graph/inventory identities, freshness, and four-facet coverage.',
      inputSchema: strictInput({
        files: contextFiles(),
        tier: testTier(),
        depth: depth(),
        proofDetail: testProofDetail(),
        limit: pageLimit(),
        commandLimit: commandLimit(),
        proofLimit: proofLimit(),
      }),
    },
    async (
      { files, tier, depth: maxDepth, proofDetail, limit, commandLimit, proofLimit },
      request,
    ) => {
      const inventory = await deps.codebase.inventoryStatus(request?.signal);
      if (!inventory.ok) return errorResult(inventory.error);
      const outcome = await deps.graph.selectTests(
        files,
        inventory.value.snapshot,
        { tier, maxDepth, proofDetail, limit, commandLimit, proofLimit },
        request?.signal,
      );
      return outcome.ok ? jsonResult(outcome.value) : errorResult(outcome.error);
    },
  );
}
