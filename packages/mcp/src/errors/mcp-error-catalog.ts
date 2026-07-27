/**
 * MCP tool error definitions (Plan 00 Phase 5.6 stdio transport).
 */

import { defineErrorCatalog } from '@opensip-cli/core';

/** Must match packages/mcp/src/tool.ts MCP_STABLE_ID. */
const MCP_OWNER_ID = 'f313c020-5b48-4e17-a579-e303907b6392';

export const mcpErrorCatalog = defineErrorCatalog(
  {
    id: MCP_OWNER_ID,
    displayName: 'mcp',
    packageName: '@opensip-cli/mcp',
  },
  {
    'MCP.STDIO.PROTOCOL': {
      code: 'MCP.STDIO.PROTOCOL',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'compatibility',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Verify the JSON-RPC request against the advertised MCP tool schema; if it is valid, capture the run id and report the handler failure.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['reason'],
    },
    'MCP.STDIO.TRANSPORT_FAILED': {
      code: 'MCP.STDIO.TRANSPORT_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Check the parent process stdio pipes and local process limits, then reconnect the MCP client.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['reason'],
    },
    'MCP.STDIO.SHUTDOWN': {
      code: 'MCP.STDIO.SHUTDOWN',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'cancelled',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'cancelled',
      operatorAction: 'MCP server shut down. Restart opensip mcp if more queries are needed.',
      stability: 'public',
      lifecycle: 'active',
    },
  },
);
