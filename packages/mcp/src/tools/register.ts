/**
 * Mount the MCP tool catalog onto the server (ADR-0084, Phase 4).
 *
 * One place that wires every graph + result tool through the server's
 * scope-wrapping {@link McpStdioServer.register} seam. The host calls this once
 * (in `command.ts`) after building the ports; each tool reads ONLY its injected
 * port (never `currentScope()`, never a run-command entry point).
 */

import { registerGetRuntimeWiring } from './get-runtime-wiring.js';
import { registerCodebaseTools } from './register-codebase-tools.js';
import { registerContextTools } from './register-context-tools.js';
import { registerGraphTools } from './register-graph-tools.js';
import { registerResultTools } from './register-result-tools.js';
import { registerRepairApplyVerify } from './repair-apply-verify.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

/**
 * Default protocol surface epoch. Increment when the registered default tool
 * set changes. Historical increments are intentionally not repeated here;
 * the exported value and the registered names are the protocol authority.
 * Actual registration names remain authoritative via server.describeSurface().
 */
export const MCP_SURFACE_EPOCH = 8;

/**
 * Register the default protocol inventory. `refresh_graph` is the sole graph
 * mutation; explicit mutation mode adds only `repair_apply_verify`.
 */
export function registerMcpTools(server: McpStdioServer, deps: McpToolDeps): void {
  // ── Graph tools (over GraphReadPort) ──────────────────────────────
  registerGraphTools(server, deps);

  // ── Captured project inventory ────────────────────────────────────
  registerCodebaseTools(server, deps);

  // ── Live wiring (not static graph) ────────────────────────────────
  registerGetRuntimeWiring(server, deps);

  // ── Recorded agent task context ───────────────────────────────────
  registerContextTools(server, deps);

  registerResultTools(server, deps);
  if (deps.mutationsEnabled === true && deps.repairWrite !== undefined) {
    registerRepairApplyVerify(server, deps);
  }
}
