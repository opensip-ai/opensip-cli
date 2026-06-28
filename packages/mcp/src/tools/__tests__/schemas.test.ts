/**
 * Per-tool Zod boundary schemas (Task 6.1 §Hardening).
 *
 * Every MCP tool argument is validated by these field schemas BEFORE the handler
 * runs, so hostile input is rejected at the trust boundary and never reaches a
 * port: a malformed `symbolId`, a `..`-traversal / absolute `file`, an over-long
 * `query`, and out-of-range `depth`/`limit`.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEPTH,
  MAX_DEPTH,
  MAX_LIMIT,
  MAX_QUERY_LEN,
  depth,
  filePath,
  limit,
  query,
  symbolId,
} from '../schemas.js';

describe('symbolId schema', () => {
  it('accepts the canonical "<filePath>:<line>:<column>" shape', () => {
    expect(symbolId().safeParse('packages/core/src/a.ts:12:4').success).toBe(true);
  });

  it('rejects a bare name (no line:col)', () => {
    expect(symbolId().safeParse('saveBaseline').success).toBe(false);
  });

  it('rejects a malformed id whose trailing groups are not integers', () => {
    expect(symbolId().safeParse('a.ts:12:x').success).toBe(false);
    expect(symbolId().safeParse('a.ts:line:col').success).toBe(false);
  });
});

describe('filePath schema', () => {
  it('accepts a project-relative path', () => {
    expect(filePath().safeParse('packages/core/src/a.ts').success).toBe(true);
  });

  it('rejects an absolute POSIX path', () => {
    expect(filePath().safeParse('/etc/passwd').success).toBe(false);
  });

  it('rejects a Windows drive-absolute path', () => {
    expect(filePath().safeParse('C:\\windows\\system32').success).toBe(false);
  });

  it('rejects a ".." traversal escaping the project root', () => {
    expect(filePath().safeParse('../../etc/passwd').success).toBe(false);
    expect(filePath().safeParse('src/../../secret').success).toBe(false);
  });
});

describe('query schema', () => {
  it('accepts a normal search term', () => {
    expect(query().safeParse('saveBaseline').success).toBe(true);
  });

  it('rejects an over-long (potential ReDoS-payload) query', () => {
    expect(query().safeParse('x'.repeat(MAX_QUERY_LEN + 1)).success).toBe(false);
  });

  it('rejects an empty query', () => {
    expect(query().safeParse('').success).toBe(false);
  });
});

describe('depth schema', () => {
  it('defaults to DEFAULT_DEPTH when omitted', () => {
    const parsed = depth().safeParse(undefined);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBe(DEFAULT_DEPTH);
  });

  it('rejects a depth above the maximum (not silently clamped through here)', () => {
    expect(depth().safeParse(MAX_DEPTH + 1).success).toBe(false);
  });

  it('rejects a zero / negative depth', () => {
    expect(depth().safeParse(0).success).toBe(false);
  });
});

describe('limit schema', () => {
  it('rejects a limit above MAX_LIMIT', () => {
    expect(limit().safeParse(MAX_LIMIT + 1).success).toBe(false);
  });

  it('accepts the maximum limit', () => {
    expect(limit().safeParse(MAX_LIMIT).success).toBe(true);
  });

  it('is optional', () => {
    expect(limit().safeParse(undefined).success).toBe(true);
  });
});
