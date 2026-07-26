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
  type GraphQueryCursorInput,
} from '../graph-query-page.js';
import { errorResult, jsonResult } from '../tools/tool-result.js';

const PROJECT = 'abc123abcdef1234abc123ab';
const GEN = 'g1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const QUERY = digestNormalizedQuery({ op: 'search', q: 'x' });

function cursorFor(afterKey: string, overrides: Partial<GraphQueryCursorInput> = {}): string {
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

  it('rejects a cursor whose scalar or composite position was tampered', () => {
    const tamper = (raw: string, afterKey: string): string => {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      parsed.afterKey = afterKey;
      return Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
    };
    expect(decodeCursor(tamper(cursorFor('symbol-a'), 'symbol-b')).ok).toBe(false);
    expect(
      decodeCursor(
        tamper(
          cursorFor(JSON.stringify({ section: 'edges', after: 'a' })),
          JSON.stringify({ section: 'hotspots', after: 'a' }),
        ),
      ).ok,
    ).toBe(false);
  });

  it('maps wrong project / generation / query to distinct codes', () => {
    const raw = cursorFor('k');
    const decoded = decodeCursor(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const wrongProject = bindCursor(decoded.value, {
      projectKey: 'def456abcdef1234abc123ab',
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

  it('rejects non-canonical keys, control-bearing sort keys, and unknown fields', () => {
    expect(
      decodeCursor(
        Buffer.from(
          JSON.stringify({
            v: 1,
            projectKey: PROJECT,
            generationKey: 'g1:not-hex',
            queryDigest: QUERY,
            afterKey: 'x',
          }),
        ).toString('base64url'),
      ).ok,
    ).toBe(false);
    expect(decodeCursor(cursorFor('bad\nkey')).ok).toBe(false);
    expect(
      decodeCursor(
        Buffer.from(
          JSON.stringify({
            v: 1,
            projectKey: PROJECT,
            generationKey: GEN,
            queryDigest: QUERY,
            afterKey: 'x',
            injected: true,
          }),
        ).toString('base64url'),
      ).ok,
    ).toBe(false);
  });

  it('rejects missing fields, wrong formats, unsupported versions, and oversized sort keys', () => {
    const payload = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    expect(
      decodeCursor(
        payload({
          v: 1,
          projectKey: PROJECT,
          generationKey: GEN,
          queryDigest: QUERY,
        }),
      ).ok,
    ).toBe(false);
    expect(
      decodeCursor(
        payload({
          v: 2,
          projectKey: PROJECT,
          generationKey: GEN,
          queryDigest: QUERY,
          afterKey: 'x',
        }),
      ).ok,
    ).toBe(false);
    expect(decodeCursor(cursorFor('x', { projectKey: PROJECT.toUpperCase() })).ok).toBe(false);
    expect(decodeCursor(cursorFor('x', { queryDigest: 'A'.repeat(32) })).ok).toBe(false);
    expect(decodeCursor(cursorFor('x'.repeat(2049))).ok).toBe(false);
    expect(decodeCursor(cursorFor('bad\u007Fkey')).ok).toBe(false);
    expect(decodeCursor(cursorFor('bad\u0085key')).ok).toBe(false);
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

  it('uses Unicode code-point order for continuation comparisons', () => {
    const bmp = '\uE000';
    const supplementary = '\u{10000}';
    const ordered = [
      { id: 'bmp', k: bmp },
      { id: 'supplementary', k: supplementary },
    ];
    const first = pageRows(
      ordered,
      { projectKey: PROJECT, generationKey: GEN, queryDigest: QUERY, limit: 1 },
      (row) => row.k,
    );
    expect(first.ok && first.value.rows[0]?.id).toBe('bmp');
    if (!first.ok || first.value.nextCursor === undefined) return;
    const second = pageRows(
      ordered,
      {
        projectKey: PROJECT,
        generationKey: GEN,
        queryDigest: QUERY,
        limit: 1,
        cursor: first.value.nextCursor,
      },
      (row) => row.k,
    );
    expect(second.ok && second.value.rows[0]?.id).toBe('supplementary');
  });

  it('emits a reusable compact cursor for maximum-size Unicode row keys', () => {
    const hugeKey = `${'\uE000'.repeat(1024)}|${'\u{10000}'.repeat(1024)}|${'x'.repeat(1024)}`;
    const rows = [
      { id: 'first', key: hugeKey },
      { id: 'second', key: `${hugeKey}z` },
    ];
    const first = pageRows(
      rows,
      { projectKey: PROJECT, generationKey: GEN, queryDigest: QUERY, limit: 1 },
      (row) => row.key,
    );
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.nextCursor === undefined) return;
    expect(first.value.nextCursor.length).toBeLessThan(4096);
    expect(decodeCursor(first.value.nextCursor).ok).toBe(true);
    const second = pageRows(
      rows,
      {
        projectKey: PROJECT,
        generationKey: GEN,
        queryDigest: QUERY,
        limit: 1,
        cursor: first.value.nextCursor,
      },
      (row) => row.key,
    );
    expect(second.ok && second.value.rows.map((row) => row.id)).toEqual(['second']);
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

  it('counts the full input and orders group keys by code point', () => {
    const bmp = '\uE000';
    const supplementary = '\u{10000}';
    const grouped = groupRows(
      [{ p: supplementary }, { p: bmp }, { p: bmp }],
      'package',
      (row) => row.p,
    );
    expect(grouped.groups).toEqual([
      { key: bmp, count: 2 },
      { key: supplementary, count: 1 },
    ]);
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

  it('applies the same final byte ceiling to structured error results', () => {
    const tool = errorResult({
      code: 'response-too-large',
      message: 'x'.repeat(MAX_JSON_RESULT_BYTES),
    });
    const text = tool.content[0]?.type === 'text' ? tool.content[0].text : '';
    expect(tool.isError).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(MAX_JSON_RESULT_BYTES);
    expect(text).toContain('response-too-large');
    expect(text).not.toContain('oversized-error');
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
