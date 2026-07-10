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
 * Register the exact 19-tool default protocol inventory. `refresh_graph` is the
 * sole graph mutation; explicit mutation mode adds only `repair_apply_verify`.
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
