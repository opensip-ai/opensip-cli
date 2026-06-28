/**
 * `@opensip-cli/mcp` Tool descriptor (ADR-0084).
 *
 * A bundled, first-party tool that serves the OpenSIP call graph + stored run
 * results to MCP-capable coding agents over stdio. The single `mcp` command is
 * declarative and mounted by the host (added in plan Phase 3); this descriptor
 * also declares the `mcp-graph-adapter` capability domain so the bundled `graph-*`
 * adapter packs load under `opensip mcp` and route through MCP's own registrar.
 *
 * This module does NOT import from `@opensip-cli/cli` — a tool engine (layer 4)
 * never depends on the composition root.
 */
import { defineTool, readPackageVersion } from '@opensip-cli/core';

import { mcpCommandSpec } from './command.js';
import { registerMcpGraphAdapter } from './register-mcp-graph-adapters.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';

export const MCP_IDENTITY: ToolIdentity = {
  name: 'mcp',
};

/** Stable UUID identity (ADR-0048); mirrors `opensipTools.stableId` in package.json. */
export const MCP_STABLE_ID = 'f313c020-5b48-4e17-a579-e303907b6392';

export const mcpTool: Tool = defineTool({
  identity: MCP_IDENTITY,
  metadata: {
    id: MCP_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'MCP server for the OpenSIP call graph and stored results',
  },
  commandSpecs: [mcpCommandSpec],
  extensionPoints: {
    capabilityRegistrars: { 'mcp-graph-adapter': registerMcpGraphAdapter },
  },
});
