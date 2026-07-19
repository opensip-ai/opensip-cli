/**
 * @fileoverview Display entries for opensip-cli-internal architecture dogfood checks.
 *
 * Moved out of `@opensip-cli/checks-typescript` when these opensip-internal
 * architecture checks were relocated to the private dogfood pack (they key on
 * opensip's own package internals, not the public Tool-authoring contract).
 */

import type { CheckDisplayEntry } from './types.js';

/** Architecture dogfood check display entries (TS_AST only). */
export const ARCHITECTURE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'external-adapter-progress-private-bridge': ['🔒', 'External Adapter Progress Private Bridge'],
  'external-tool-adapter-contract': ['🧩', 'External Tool Adapter Contract'],
  'command-handler-host-owned-output': ['🚪', 'Command Handler Host-Owned Output'],
  'first-party-command-static-handler': ['📎', 'First-Party Command Static Handler'],
  'host-tool-runtime-import-boundary': ['🧱', 'Host Tool Runtime Import Boundary'],
  'live-view-through-cli-live': ['🖥️', 'Live View Through cli-live'],
  'mcp-results-no-rerun': ['♻️', 'MCP Results Replay (No Re-Run)'],
  'no-full-replacement-vi-mock': ['🧪', 'No Full-Replacement vi.mock'],
  'string-prefilter-superset': ['🔎', 'String Pre-Filter Superset'],
  'no-bootstrap-tool-import': ['🔌', 'No Bootstrap Tool Import'],
  'architecture-no-run-done-result': ['🎯', 'No Per-Tool Run Done-Result'],
  'single-opts-assembly-seam': ['🧩', 'Single Opts Assembly Seam'],
  'subprocess-correlation-required': ['🔗', 'Subprocess Correlation Required'],
});
