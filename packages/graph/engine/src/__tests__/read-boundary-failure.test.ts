import { createToolError, RunScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { graphErrorCatalog } from '../errors/graph-error-catalog.js';
import { failGraphRead } from '../read/read-boundary-failure.js';

function testLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('graph read failure boundary', () => {
  it('keeps caught data out of the Result while retaining operator evidence', () => {
    const logger = testLogger();
    const privateDetail = '/private/repo/.runtime/datastore.sqlite?token=secret';
    const result = runWithScopeSync(new RunScope({ logger }), () =>
      failGraphRead(new Error(privateDetail), {
        boundary: 'infrastructure',
        condition: 'catalog-identity',
        module: 'graph:read:catalog',
        reason: 'catalog-identity',
        operation: 'catalog-identity',
        message: 'Failed to read graph catalog identity',
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'catalog-identity',
        operation: 'catalog-identity',
        message: 'Failed to read graph catalog identity',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|sqlite|secret|cause|stack/iu);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'graph.read.failed',
        code: 'GRAPH.READ.INFRASTRUCTURE_FAILED',
        boundaryCode: 'GRAPH.READ.INFRASTRUCTURE_FAILED',
        condition: 'catalog-identity',
        failure: expect.objectContaining({ code: 'GRAPH.READ.INFRASTRUCTURE_FAILED' }) as object,
      }),
    );
  });

  it('does not downgrade a definition-backed cause', () => {
    const logger = testLogger();
    const existing = graphErrorCatalog.require('GRAPH.CATALOG.UNREADABLE');
    runWithScopeSync(new RunScope({ logger }), () =>
      failGraphRead(createToolError(existing, 'Catalog integrity failed.'), {
        boundary: 'infrastructure',
        condition: 'catalog-generation',
        module: 'graph:read:catalog',
        reason: 'catalog-generation',
        operation: 'catalog-generation',
        message: 'Failed to load graph catalog generation',
      }),
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'GRAPH.CATALOG.UNREADABLE',
        boundaryCode: 'GRAPH.READ.INFRASTRUCTURE_FAILED',
        failure: expect.objectContaining({ code: 'GRAPH.CATALOG.UNREADABLE' }) as object,
      }),
    );
  });
});
