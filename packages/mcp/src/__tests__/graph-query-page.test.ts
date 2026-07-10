import { describe, expect, it } from 'vitest';

import {
  MAX_GROUP_KEYS,
  MAX_JSON_RESULT_BYTES,
  assertJsonPayloadSize,
  bindCursor,
  decodeCursor,
  digestNormalizedQuery,
  encodeCursor,
  groupRows,
  pageRows,
  type GraphQueryCursor,
} from '../graph-query-page.js';
import { jsonResult } from '../tools/tool-result.js';

const PROJECT = 'abc123projectkey00000000';
const GEN = 'g1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const QUERY = digestNormalizedQuery({ op: 'search', q: 'x' });

function cursorFor(afterKey: string, overrides: Partial<GraphQueryCursor> = {}): string {
  return encodeCursor({
    v: 1,
    projectKey: PROJECT,
    generationKey: GEN,
    queryDigest: QUERY,
    afterKey,
    ...overrides,
  });
}

describe('digestNormalizedQuery', () => {
  it('is stable across key insertion order', () => {
    expect(digestNormalizedQuery({ b: 1, a: 2 })).toBe(digestNormalizedQuery({ a: 2, b: 1 }));
  });
});

describe('decodeCursor / bindCursor', () => {
  it('round-trips a valid cursor', () => {
    const raw = cursorFor('sym:1');
    const decoded = decodeCursor(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const bound = bindCursor(decoded.value, {
      projectKey: PROJECT,
      generationKey: GEN,
      queryDigest: QUERY,
    });
    expect(bound.ok).toBe(true);
  });

  it('rejects non-base64url and malformed JSON', () => {
    expect(decodeCursor('+++').ok).toBe(false);
    expect(decodeCursor('not-json-but-urlsafe').ok).toBe(false);
  });

  it('maps wrong project / generation / query to distinct codes', () => {
    const raw = cursorFor('k');
    const decoded = decodeCursor(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const wrongProject = bindCursor(decoded.value, {
      projectKey: 'other-project-key-xxxxxx',
      generationKey: GEN,
      queryDigest: QUERY,
    });
    expect(wrongProject.ok).toBe(false);
    expect(!wrongProject.ok && wrongProject.error.code).toBe('cursor-project-mismatch');

    const stale = bindCursor(decoded.value, {
      projectKey: PROJECT,
      generationKey: 'g1:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      queryDigest: QUERY,
    });
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.error.code).toBe('cursor-stale');

    const queryMismatch = bindCursor(decoded.value, {
      projectKey: PROJECT,
      generationKey: GEN,
      queryDigest: digestNormalizedQuery({ op: 'other' }),
    });
    expect(queryMismatch.ok).toBe(false);
    expect(!queryMismatch.ok && queryMismatch.error.code).toBe('cursor-query-mismatch');
  });

  it('rejects generation keys that are not g1:', () => {
    const bad = encodeCursor({
      v: 1,
      projectKey: PROJECT,
      generationKey: 'not-a-g1-key',
      queryDigest: QUERY,
      afterKey: 'x',
    });
    const decoded = decodeCursor(bad);
    expect(decoded.ok).toBe(false);
    expect(!decoded.ok && decoded.error.code).toBe('cursor-invalid');
  });
});

describe('pageRows', () => {
  const rows = [
    { id: 'a', k: 'a' },
    { id: 'b', k: 'b' },
    { id: 'c', k: 'c' },
    { id: 'd', k: 'd' },
  ];

  it('returns the first page and a nextCursor when more exist', () => {
    const page = pageRows(
      rows,
      {
        projectKey: PROJECT,
        generationKey: GEN,
        queryDigest: QUERY,
        limit: 2,
      },
      (r) => r.k,
    );
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.value.hasMore).toBe(true);
    expect(page.value.nextCursor).toBeDefined();
  });

  it('continues from afterKey without reordering', () => {
    const first = pageRows(
      rows,
      {
        projectKey: PROJECT,
        generationKey: GEN,
        queryDigest: QUERY,
        limit: 2,
      },
      (r) => r.k,
    );
    expect(first.ok && first.value.nextCursor).toBeTruthy();
    if (!first.ok || first.value.nextCursor === undefined) return;
    const second = pageRows(
      rows,
      {
        projectKey: PROJECT,
        generationKey: GEN,
        queryDigest: QUERY,
        limit: 2,
        cursor: first.value.nextCursor,
      },
      (r) => r.k,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.rows.map((r) => r.id)).toEqual(['c', 'd']);
    expect(second.value.hasMore).toBe(false);
    expect(second.value.nextCursor).toBeUndefined();
  });
});

describe('groupRows', () => {
  it('returns nothing for groupBy none', () => {
    expect(groupRows([{ p: 'a' }], 'none', () => 'x').groups).toBeUndefined();
  });

  it('caps group keys at MAX_GROUP_KEYS', () => {
    const rows = Array.from({ length: MAX_GROUP_KEYS + 10 }, (_, i) => ({
      p: `pkg-${String(i).padStart(4, '0')}`,
    }));
    const grouped = groupRows(rows, 'package', (r) => r.p);
    expect(grouped.groups?.length).toBe(MAX_GROUP_KEYS);
    expect(grouped.groupTruncated).toBe(true);
  });
});

describe('assertJsonPayloadSize / jsonResult', () => {
  it('accepts a small payload', () => {
    const result = assertJsonPayloadSize({ ok: true });
    expect(result.ok).toBe(true);
  });

  it('returns response-too-large above 4 MiB without partial content', () => {
    // Build a payload whose pretty JSON exceeds the ceiling.
    const big = { data: 'x'.repeat(MAX_JSON_RESULT_BYTES) };
    const result = assertJsonPayloadSize(big);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('response-too-large');

    const tool = jsonResult(big);
    expect(tool.isError).toBe(true);
    const text = tool.content[0]?.type === 'text' ? tool.content[0].text : '';
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('response-too-large');
  });

  it('accepts a payload immediately under the ceiling', () => {
    // Leave room for pretty-print overhead (`{\n  "d": "..."\n}`).
    const under = { d: 'y'.repeat(MAX_JSON_RESULT_BYTES - 32) };
    const text = JSON.stringify(under, null, 2);
    if (Buffer.byteLength(text, 'utf8') <= MAX_JSON_RESULT_BYTES) {
      expect(assertJsonPayloadSize(under).ok).toBe(true);
    } else {
      // If overhead pushes over, the size guard still returns a typed error.
      expect(assertJsonPayloadSize(under).ok).toBe(false);
    }
  });
});
