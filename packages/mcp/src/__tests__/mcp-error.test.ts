import { describe, expect, it } from 'vitest';

import { fromGraphReadError, unexpectedRefreshError } from '../mcp-error.js';

import type { GraphReadError } from '@opensip-cli/graph/read';

describe('fromGraphReadError', () => {
  it.each([
    ['GRAPH.READ.CATALOG_IDENTITY', 'catalog-identity', 'Failed to read graph catalog identity'],
    [
      'GRAPH.READ.CATALOG_GENERATION',
      'catalog-generation',
      'Failed to load graph catalog generation',
    ],
    ['GRAPH.READ.REBUILD_EMPTY', 'rebuild', 'Graph rebuild produced an empty catalog'],
    [
      'GRAPH.READ.REBUILD_FAILED',
      'rebuild',
      'Graph rebuild failed due to an infrastructure error',
    ],
  ] as const)('maps %s to its fixed MCP DTO', (code, operation, message) => {
    const source: GraphReadError = {
      code,
      operation,
      message: 'secret token at /private/project/datastore.sqlite',
    };
    expect(fromGraphReadError(source)).toEqual({ code, message });
  });

  it('bounds an unknown graph error code instead of trusting its message', () => {
    const mapped = fromGraphReadError({
      code: 'GRAPH.READ.FUTURE',
      operation: 'analysis',
      message: 'secret token at /private/project/datastore.sqlite',
    });
    expect(mapped).toEqual({ code: 'graph-read-failed', message: 'Graph read failed.' });
    expect(JSON.stringify(mapped)).not.toMatch(/secret|private|sqlite/i);
  });
});

describe('unexpectedRefreshError', () => {
  it('returns one fixed bounded error', () => {
    expect(unexpectedRefreshError()).toEqual({
      code: 'refresh-failed',
      message: 'Graph refresh failed due to an infrastructure error.',
    });
  });
});
