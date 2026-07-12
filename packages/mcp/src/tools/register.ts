/**
 * Mount the MCP tool catalog onto the server (ADR-0084, Phase 4).
 *
 * One place that wires every graph + result tool through the server's
 * scope-wrapping {@link McpStdioServer.register} seam. The host calls this once
 * (in `command.ts`) after building the ports; each tool reads ONLY its injected
 * port (never `currentScope()`, never a run-command entry point).
 */

import { registerGetRuntimeWiring } from './get-runtime-wiring.js';
import { registerGraphTools } from './register-graph-tools.js';
import { registerResultTools } from './register-result-tools.js';
import { registerRepairApplyVerify } from './repair-apply-verify.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

/**
 * Default protocol surface epoch. Increment when the registered default tool
 * set changes (Phase 3 added search_declarations + references_to → epoch 3;
 * Phase 4 added get_runtime_wiring and Phase 6 added get_agent_catalog → epoch 4).
 * Actual registration names remain authoritative via server.describeSurface().
 */
export const MCP_SURFACE_EPOCH = 4;

/**
 * Register the default protocol inventory (21 tools with Phase 3 declaration
 * tools). `refresh_graph` is the sole graph mutation; explicit mutation mode
 * adds only `repair_apply_verify` (22 tools).
 */
export function registerMcpTools(server: McpStdioServer, deps: McpToolDeps): void {
  // ── Graph tools (over GraphReadPort) ──────────────────────────────
  registerGraphTools(server, deps);

  // ── Live wiring (not static graph) ────────────────────────────────
  registerGetRuntimeWiring(server, deps);

  registerResultTools(server, deps);
  if (deps.mutationsEnabled === true && deps.repairWrite !== undefined) {
    registerRepairApplyVerify(server, deps);
  }
}
