import { describe, expect, it } from 'vitest';

import { SystemError, normalizeFailure } from '@opensip-cli/core';

import { mcpErrorCatalog } from '../mcp-error-catalog.js';

describe('mcpErrorCatalog (Plan 00 Phase 5.6)', () => {
  it('codes protocol failures without relying on message parsing', () => {
    const error = new SystemError('malformed JSON-RPC', {
      code: 'MCP.STDIO.PROTOCOL',
      definition: mcpErrorCatalog.require('MCP.STDIO.PROTOCOL'),
      metadata: { reason: 'parse-error' },
    });
    const envelope = normalizeFailure(error);
    expect(envelope.code).toBe('MCP.STDIO.PROTOCOL');
    expect(envelope.definition.kind).toBe('compatibility');
    expect(JSON.stringify(envelope)).not.toMatch(/stack/i);
  });

  it('codes shutdown/cancel for cooperative close', () => {
    const def = mcpErrorCatalog.require('MCP.STDIO.SHUTDOWN');
    expect(def.kind).toBe('cancelled');
    expect(def.exitClass).toBe('cancelled');
  });
});
