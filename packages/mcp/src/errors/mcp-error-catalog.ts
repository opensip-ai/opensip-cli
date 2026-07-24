/**
 * MCP tool error definitions (Plan 00 Phase 5.6 stdio transport).
 */

import { defineErrorCatalog } from '@opensip-cli/core';

export const mcpErrorCatalog = defineErrorCatalog(
  {
    id: 'mcp',
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
      operatorAction: 'Fix the JSON-RPC request shape and reconnect the MCP client.',
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
  { allowLegacyCodes: true },
);
