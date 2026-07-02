/**
 * Mount the MCP tool catalog onto the server (ADR-0084, Phase 4).
 *
 * One place that wires every graph + result tool through the server's
 * scope-wrapping {@link McpStdioServer.register} seam. The host calls this once
 * (in `command.ts`) after building the ports; each tool reads ONLY its injected
 * port (never `currentScope()`, never a run-command entry point).
 */

import { registerBlastRadius } from './blast-radius.js';
import { registerCalleesOf } from './callees-of.js';
import { registerFindDeadCode } from './find-dead-code.js';
import { registerGetArchitecture } from './get-architecture.js';
import { registerGetSymbol } from './get-symbol.js';
import { registerRefreshGraph } from './refresh-graph.js';
import { registerResultTools } from './register-result-tools.js';
import { registerSearchSymbols } from './search-symbols.js';
import { registerTracePath } from './trace-path.js';
import { registerWhoCalls } from './who-calls.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

/** Register all 15 MCP tools (9 graph + 6 result/review) on `server`. */
export function registerMcpTools(server: McpStdioServer, deps: McpToolDeps): void {
  // ── Graph tools (over GraphReadPort) ──────────────────────────────
  registerSearchSymbols(server, deps);
  registerGetSymbol(server, deps);
  registerWhoCalls(server, deps);
  registerCalleesOf(server, deps);
  registerTracePath(server, deps);
  registerBlastRadius(server, deps);
  registerFindDeadCode(server, deps);
  registerGetArchitecture(server, deps);
  registerRefreshGraph(server, deps);

  registerResultTools(server, deps);
}
