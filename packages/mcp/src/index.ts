/**
 * @opensip-cli/mcp public barrel.
 *
 * Re-exports the Tool descriptor the host loads by name through the bundled
 * plugin path. The MCP server internals (ports, command, tools) are not public
 * API — they are consumed only within this package and its test suites.
 */
export { mcpTool, mcpTool as tool, MCP_IDENTITY, MCP_STABLE_ID } from './tool.js';
