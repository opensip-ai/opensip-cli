/**
 * The `opensip mcp` command (ADR-0084).
 *
 * A long-lived, blocking stdio JSON-RPC server. `output: 'raw-stream'` +
 * `rawStreamReason: 'mcp-stdio'` because JSON-RPC owns stdout for the protocol;
 * all diagnostics go to stderr for the serve lifetime. The host renders nothing
 * — the handler owns its entire output surface (the documented raw-stream escape
 * hatch; see ADR-0084).
 *
 * The real server wiring (scope capture + ports + `McpServer`) lands in plan
 * Phase 3; this declares the loadable primary command so the bundled tool
 * registers cleanly.
 */
import { definePrimaryCommand } from '@opensip-cli/core';

import type { ToolCliContext } from '@opensip-cli/core';

export const mcpCommandSpec = definePrimaryCommand<unknown, ToolCliContext>({
  description: 'Serve the OpenSIP call graph + stored results to MCP agents over stdio',
  commonFlags: ['cwd'],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'mcp-stdio',
  handler: () => {
    // Placeholder until Phase 3 wires the stdio server. Diagnostics go to stderr
    // (stdout is reserved for JSON-RPC).
    process.stderr.write('opensip mcp: server implementation pending (plan Phase 3)\n');
  },
});
