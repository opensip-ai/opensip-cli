/**
 * Project-bound graph query paging, cursor codec, and grouping helpers.
 *
 * Cursor fields:
 * - `projectKey` = core `ephemeralProjectCacheKey(projectRoot)` (not re-hashed here)
 * - `generationKey` = MCP `g1:<sha256>` catalog generation key only
 * - `queryDigest` = digest of the normalized query/filter
 * - `afterKey` = last stable sort key from the previous page
 */

import { createHash } from 'node:crypto';

import { err, ok, type Result } from '@opensip-cli/core';

import { readError, type McpReadError } from './mcp-error.js';

/** Cursor schema version. */
export const CURSOR_VERSION = 1 as const;

/** Max group keys emitted by {@link groupRows}. */
export const MAX_GROUP_KEYS = 500;

/** Final JSON text ceiling enforced by {@link assertJsonPayloadSize}. */
export const MAX_JSON_RESULT_BYTES = 4 * 1024 * 1024;

export interface GraphQueryCursor {
  readonly v: typeof CURSOR_VERSION;
  readonly projectKey: string;
  readonly generationKey: string;
  readonly queryDigest: string;
  readonly afterKey: string;
}

export interface PageInput {
  /** Core ephemeral project cache key (caller-provided; never re-hashed). */
  readonly projectKey: string;
  /** Canonical `g1:` generation key. */
  readonly generationKey: string;
  /** Digest of the normalized query/filter for this operation. */
  readonly queryDigest: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface PageSlice<T> {
  readonly rows: readonly T[];
  readonly nextCursor?: string;
  /** True when more complete pages exist after this one. */
  readonly hasMore: boolean;
}

export interface GroupSummary {
  readonly key: string;
  readonly count: number;
}

/**
 * Digest a normalized query/filter object for cursor binding.
 * Keys are sorted for stability.
 */
export function digestNormalizedQuery(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** Encode a cursor as base64url JSON. */
export function encodeCursor(cursor: GraphQueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode and validate a base64url cursor. Maps malformed/tampered input to
 * `cursor-invalid` without throwing.
 */
export function decodeCursor(raw: string): Result<GraphQueryCursor, McpReadError> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw) || raw.length > 4096) {
      return err(readError('cursor-invalid', 'Cursor is malformed or not base64url.'));
    }
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return err(readError('cursor-invalid', 'Cursor payload is not an object.'));
    }
    const obj = parsed as Record<string, unknown>;
    if (obj['v'] !== CURSOR_VERSION) {
      return err(readError('cursor-invalid', 'Unsupported cursor version.'));
    }
    const projectKey = obj['projectKey'];
    const generationKey = obj['generationKey'];
    const queryDigest = obj['queryDigest'];
    const afterKey = obj['afterKey'];
    if (
      typeof projectKey !== 'string' ||
      typeof generationKey !== 'string' ||
      typeof queryDigest !== 'string' ||
      typeof afterKey !== 'string' ||
      projectKey.length === 0 ||
      projectKey.length > 128 ||
      generationKey.length === 0 ||
      generationKey.length > 128 ||
      queryDigest.length === 0 ||
      queryDigest.length > 128 ||
      afterKey.length === 0 ||
      afterKey.length > 2048
    ) {
      return err(readError('cursor-invalid', 'Cursor fields are missing or oversized.'));
    }
    if (!generationKey.startsWith('g1:')) {
      return err(readError('cursor-invalid', 'Cursor generationKey must be a g1: key.'));
    }
    return ok({
      v: CURSOR_VERSION,
      projectKey,
      generationKey,
      queryDigest,
      afterKey,
    });
  } catch {
    return err(readError('cursor-invalid', 'Cursor could not be decoded.'));
  }
}

/**
 * Bind a decoded cursor to the current project/generation/query.
 * Wrong project → `cursor-project-mismatch`; generation drift → `cursor-stale`;
 * query drift → `cursor-query-mismatch`.
 */
export function bindCursor(
  cursor: GraphQueryCursor,
  binding: Pick<PageInput, 'projectKey' | 'generationKey' | 'queryDigest'>,
): Result<GraphQueryCursor, McpReadError> {
  if (cursor.projectKey !== binding.projectKey) {
    return err(readError('cursor-project-mismatch', 'Cursor belongs to a different project.'));
  }
  if (cursor.generationKey !== binding.generationKey) {
    return err(readError('cursor-stale', 'Cursor generation no longer matches the loaded catalog.'));
  }
  if (cursor.queryDigest !== binding.queryDigest) {
    return err(readError('cursor-query-mismatch', 'Cursor query no longer matches this request.'));
  }
  return ok(cursor);
}

/**
 * Page an already-sorted iterable of rows by stable key.
 * Retains at most `limit + 1` rows; emits `nextCursor` only when another
 * complete page exists. Does not clone/sort an unbounded candidate array —
 * the caller streams in stable order and supplies `stableKey`.
 */
export function pageRows<T>(
  rows: Iterable<T>,
  input: PageInput,
  stableKey: (row: T) => string,
): Result<PageSlice<T>, McpReadError> {
  let afterKey: string | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded.ok) return decoded;
    const bound = bindCursor(decoded.value, input);
    if (!bound.ok) return bound;
    afterKey = bound.value.afterKey;
  }

  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
  const retained: T[] = [];
  let sawMore = false;

  for (const row of rows) {
    const key = stableKey(row);
    if (afterKey !== undefined && key <= afterKey) continue;
    if (retained.length < limit) {
      retained.push(row);
      continue;
    }
    // One extra row proves another page exists; stop without retaining it.
    sawMore = true;
    break;
  }

  if (!sawMore || retained.length === 0) {
    return ok({ rows: retained, hasMore: false });
  }

  const last = retained.at(-1);
  if (last === undefined) {
    return ok({ rows: retained, hasMore: false });
  }
  const nextCursor = encodeCursor({
    v: CURSOR_VERSION,
    projectKey: input.projectKey,
    generationKey: input.generationKey,
    queryDigest: input.queryDigest,
    afterKey: stableKey(last),
  });
  return ok({ rows: retained, nextCursor, hasMore: true });
}

/**
 * Bounded grouping over paged (or filtered) rows. Caps at {@link MAX_GROUP_KEYS}.
 */
export function groupRows<T>(
  rows: readonly T[],
  mode: 'none' | 'package' | 'file',
  keyOf: (row: T, mode: 'package' | 'file') => string,
): { readonly groups?: readonly GroupSummary[]; readonly groupTruncated: boolean } {
  if (mode === 'none') {
    return { groupTruncated: false };
  }
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row, mode);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const truncated = sorted.length > MAX_GROUP_KEYS;
  const slice = sorted.slice(0, MAX_GROUP_KEYS);
  return {
    groups: slice.map(([key, count]) => ({ key, count })),
    groupTruncated: truncated,
  };
}

/**
 * Measure final UTF-8 JSON text size. Returns a small typed error above 4 MiB
 * without emitting a partial frame.
 */
export function assertJsonPayloadSize(payload: unknown): Result<string, McpReadError> {
  try {
    const text = JSON.stringify(payload, null, 2);
    if (text === undefined) {
      return err(readError('response-too-large', 'Payload is not JSON-serializable.'));
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_JSON_RESULT_BYTES) {
      return err(
        readError(
          'response-too-large',
          `Response exceeds ${String(MAX_JSON_RESULT_BYTES)} UTF-8 bytes. Lower limit or narrow filters.`,
          { bytes, maxBytes: MAX_JSON_RESULT_BYTES },
        ),
      );
    }
    return ok(text);
  } catch {
    return err(readError('response-too-large', 'Response could not be serialized to JSON.'));
  }
}
