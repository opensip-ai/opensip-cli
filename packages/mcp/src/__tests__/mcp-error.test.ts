import { describe, expect, it } from 'vitest';

import {
  fromGraphReadError,
  sanitizeMcpErrorMessage,
  unexpectedRefreshError,
} from '../mcp-error.js';

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
    ['GRAPH.READ.REBUILD_FAILED', 'rebuild', 'Graph rebuild failed due to an infrastructure error'],
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
    expect(mapped).toEqual({
      code: 'graph-read-failed',
      message: 'Graph read failed.',
    });
    expect(JSON.stringify(mapped)).not.toMatch(/secret|private|sqlite/i);
  });
});

describe('unexpectedRefreshError', () => {
  it('returns one fixed bounded error', () => {
    expect(unexpectedRefreshError()).toEqual({
      code: 'graph-refresh-failed',
      message: 'Graph refresh failed due to an infrastructure error.',
      details: { failedPhase: 'handler', outcome: 'failed' },
    });
  });
});

describe('sanitizeMcpErrorMessage', () => {
  it.each([
    ['POSIX', 'failed at /Users/alice/private/project/db.sqlite'],
    ['Windows', 'failed at C:\\Users\\alice\\private\\db.sqlite'],
    ['UNC', 'failed at \\\\server\\share\\private\\db.sqlite'],
  ])('redacts %s absolute paths', (_label, message) => {
    const sanitized = sanitizeMcpErrorMessage(message);
    expect(sanitized).toContain('<path>');
    expect(sanitized).not.toMatch(/alice|private|server|share|sqlite/iu);
  });

  it.each([
    ["ENOENT: no such file, open '/opt/private/data.json'", '/opt/private/data.json'],
    ['failed with path="/private/project/config.yml"', '/private/project/config.yml'],
    ["failed with path='C:\\Users\\alice\\private.txt'", 'C:\\Users\\alice\\private.txt'],
  ])('redacts quoted absolute paths in %j', (message, secret) => {
    const sanitized = sanitizeMcpErrorMessage(message);
    expect(sanitized).toContain('<path>');
    expect(sanitized).not.toContain(secret);
  });

  it('redacts the configured project root and strips stack/control text', () => {
    const sanitized = sanitizeMcpErrorMessage(
      new Error(
        'token\u0000\u0085 at /workspace/private/file.ts\n    at run (/workspace/private/run.ts:1:2)',
      ),
      { projectRoot: '/workspace/private' },
    );
    expect(sanitized).toBe('token at <project>');
    expect(sanitized).not.toMatch(/[\p{Cc}\u0080-\u009F]/u);
    expect(sanitized).not.toContain('at run');
  });

  it('is bounded, safe for benign text, and idempotent', () => {
    expect(sanitizeMcpErrorMessage('ordinary failure')).toBe('ordinary failure');
    const bounded = sanitizeMcpErrorMessage('x'.repeat(2000));
    expect([...bounded]).toHaveLength(512);
    const once = sanitizeMcpErrorMessage('failed in /tmp/private/file.ts');
    expect(sanitizeMcpErrorMessage(once)).toBe(once);

    const hostileFallback = sanitizeMcpErrorMessage('', {
      fallback: '\u0000fallback at /private/fallback.txt',
    });
    expect(hostileFallback).toBe('fallback at <path>');
    expect(sanitizeMcpErrorMessage(hostileFallback)).toBe(hostileFallback);
  });

  it('contains a throwable whose string conversion throws', () => {
    const hostile = {
      toString() {
        throw new Error('private conversion failure');
      },
    };
    expect(sanitizeMcpErrorMessage(hostile)).toBe('Infrastructure error.');
  });
});
