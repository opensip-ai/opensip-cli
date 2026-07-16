/**
 * Project-bound graph query paging, cursor codec, and grouping helpers.
 *
 * Cursor fields:
 * - `projectKey` = core `ephemeralProjectCacheKey(projectRoot)` (not re-hashed here)
 * - `generationKey` = MCP `g1:<sha256>` catalog generation key, or `w1:<sha256>`
 *   runtime-wiring snapshot identity
 * - `queryDigest` = digest of the normalized query/filter
 * - `afterKey` = compact `r1:<sha256>` identity of the previous page's last stable key
 */

import { createHash } from 'node:crypto';

import { err, ok, type Result } from '@opensip-cli/core';
import { compareCodePointStrings, continuationToken } from '@opensip-cli/graph/read';

import { hasControlCharacter } from './control-text.js';
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
  readonly integrity: string;
}

export type GraphQueryCursorInput = Omit<GraphQueryCursor, 'integrity'>;

export interface PageInput {
  /** Core ephemeral project cache key (caller-provided; never re-hashed). */
  readonly projectKey: string;
  /** Canonical `g1:` catalog generation key or `w1:` runtime snapshot identity. */
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

export interface BoundedTopRows<T> {
  readonly rows: readonly T[];
  readonly total: number;
}

const PROJECT_KEY_PATTERN = /^[a-f0-9]{24}$/;
const GENERATION_KEY_PATTERN = /^(?:g1|w1):[a-f0-9]{64}$/;
const QUERY_DIGEST_PATTERN = /^[a-f0-9]{32}$/;
const CURSOR_FIELDS = new Set([
  'v',
  'projectKey',
  'generationKey',
  'queryDigest',
  'afterKey',
  'integrity',
]);
const CURSOR_INVALID = 'cursor-invalid';
const INTEGRITY_PATTERN = /^[a-f0-9]{32}$/;

function isBoundedCursorSortKey(value: string): boolean {
  if (value.length === 0 || value.length > 2048) return false;
  return !hasControlCharacter(value);
}

/**
 * Digest a normalized query/filter object for cursor binding.
 * Keys are sorted for stability.
 */
export function digestNormalizedQuery(value: unknown): string {
  return digestCanonicalIdentity(value).slice(0, 32);
}

/** Full SHA-256 digest for immutable snapshot/generation identities. */
export function digestCanonicalIdentity(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value, canonicalJsonValue) ?? 'null')
    .digest('hex');
}

function canonicalJsonValue(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort(compareCodePointStrings)) sorted[key] = record[key];
  return sorted;
}

/** Encode a cursor as base64url JSON. */
export function encodeCursor(cursor: GraphQueryCursorInput): string {
  return Buffer.from(
    JSON.stringify({ ...cursor, integrity: cursorIntegrity(cursor) }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode and validate a base64url cursor. Maps malformed/tampered input to
 * `cursor-invalid` without throwing.
 */
export function decodeCursor(raw: string): Result<GraphQueryCursor, McpReadError> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw) || raw.length > 4096) {
      return err(readError(CURSOR_INVALID, 'Cursor is malformed or not base64url.'));
    }
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return err(readError(CURSOR_INVALID, 'Cursor payload is not an object.'));
    }
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length !== CURSOR_FIELDS.size || keys.some((key) => !CURSOR_FIELDS.has(key))) {
      return err(readError(CURSOR_INVALID, 'Cursor payload has unknown or missing fields.'));
    }
    if (obj.v !== CURSOR_VERSION) {
      return err(readError(CURSOR_INVALID, 'Unsupported cursor version.'));
    }
    const projectKey = obj.projectKey;
    const generationKey = obj.generationKey;
    const queryDigest = obj.queryDigest;
    const afterKey = obj.afterKey;
    const integrity = obj.integrity;
    if (
      typeof projectKey !== 'string' ||
      typeof generationKey !== 'string' ||
      typeof queryDigest !== 'string' ||
      typeof afterKey !== 'string' ||
      typeof integrity !== 'string' ||
      !PROJECT_KEY_PATTERN.test(projectKey) ||
      !GENERATION_KEY_PATTERN.test(generationKey) ||
      !QUERY_DIGEST_PATTERN.test(queryDigest) ||
      !isBoundedCursorSortKey(afterKey) ||
      !INTEGRITY_PATTERN.test(integrity)
    ) {
      return err(readError(CURSOR_INVALID, 'Cursor fields are missing or oversized.'));
    }
    const cursor: GraphQueryCursor = {
      v: CURSOR_VERSION,
      projectKey,
      generationKey,
      queryDigest,
      afterKey,
      integrity,
    };
    if (cursorIntegrity(cursor) !== integrity) {
      return err(readError(CURSOR_INVALID, 'Cursor integrity check failed.'));
    }
    return ok(cursor);
  } catch {
    return err(readError(CURSOR_INVALID, 'Cursor could not be decoded.'));
  }
}

function cursorIntegrity(cursor: GraphQueryCursorInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'opensip:mcp:graph-cursor',
        cursor.v,
        cursor.projectKey,
        cursor.generationKey,
        cursor.queryDigest,
        cursor.afterKey,
      ]),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);
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
    return err(
      readError('cursor-stale', 'Cursor generation no longer matches the loaded catalog.'),
    );
  }
  if (cursor.queryDigest !== binding.queryDigest) {
    return err(readError('cursor-query-mismatch', 'Cursor query no longer matches this request.'));
  }
  return ok(cursor);
}

function boundPageAfterKey(input: PageInput): Result<string | undefined, McpReadError> {
  if (input.cursor === undefined) return ok(undefined);
  const decoded = decodeCursor(input.cursor);
  if (!decoded.ok) return decoded;
  const bound = bindCursor(decoded.value, input);
  return bound.ok ? ok(bound.value.afterKey) : bound;
}

/** Validate a cursor's project/generation/query binding without consuming rows. */
export function validateCursorBinding(input: PageInput): Result<void, McpReadError> {
  const after = boundPageAfterKey(input);
  return after.ok ? ok(undefined) : after;
}

/**
 * Validate the stable parts of a cursor after its catalog generation was
 * removed, then return the explicit stale-generation verdict.
 */
export function rejectCursorWithoutGeneration(
  cursor: string | undefined,
  binding: Pick<PageInput, 'projectKey' | 'queryDigest'>,
): Result<void, McpReadError> {
  if (cursor === undefined) return ok(undefined);
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) return decoded;
  const bound = bindCursor(decoded.value, {
    ...binding,
    generationKey: decoded.value.generationKey,
  });
  if (!bound.ok) return bound;
  return err(readError('cursor-stale', 'Cursor generation is no longer available.'));
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
  const after = boundPageAfterKey(input);
  if (!after.ok) return after;
  const afterKey = after.value;

  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
  const retained: T[] = [];
  let sawMore = false;
  let anchorFound = afterKey === undefined;

  for (const row of rows) {
    const key = stableKey(row);
    if (!anchorFound) {
      if (continuationToken(key) === afterKey) anchorFound = true;
      continue;
    }
    if (retained.length < limit) {
      retained.push(row);
      continue;
    }
    // One extra row proves another page exists; stop without retaining it.
    sawMore = true;
    break;
  }

  if (!anchorFound) {
    return err(readError('cursor-invalid', 'Cursor continuation anchor is invalid.'));
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
    afterKey: continuationToken(stableKey(last)),
  });
  return ok({ rows: retained, nextCursor, hasMore: true });
}

/** Select the deterministic smallest `cap` comparator-distinct rows. */
export function boundedTopRows<T>(
  rows: Iterable<T>,
  cap: number,
  compare: (left: T, right: T) => number,
): BoundedTopRows<T> {
  const selected: T[] = [];
  const boundedCap = Math.max(1, Math.trunc(cap));
  let total = 0;
  for (const row of rows) {
    let low = 0;
    let high = selected.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const current = selected[middle];
      if (current !== undefined && compare(current, row) < 0) low = middle + 1;
      else high = middle;
    }
    const current = selected[low];
    if (current !== undefined && compare(current, row) === 0) continue;
    total++;
    if (low >= boundedCap) continue;
    selected.splice(low, 0, row);
    if (selected.length > boundedCap) selected.pop();
  }
  return { rows: selected, total };
}

/**
 * Bounded grouping over paged (or filtered) rows. Caps at {@link MAX_GROUP_KEYS}.
 */
export function groupRows<T>(
  rows: readonly T[],
  mode: 'none' | 'package' | 'file',
  keyOf: (row: T, mode: 'package' | 'file') => string,
): { readonly groups?: readonly GroupSummary[]; readonly groupTruncated: boolean } {
  return groupRepeatableRows(() => rows, mode, keyOf);
}

/** Bounded exact grouping over a repeatable filtered row source. */
export function groupRepeatableRows<T>(
  rows: () => Iterable<T>,
  mode: 'none' | 'package' | 'file',
  keyOf: (row: T, mode: 'package' | 'file') => string,
): { readonly groups?: readonly GroupSummary[]; readonly groupTruncated: boolean } {
  if (mode === 'none') {
    return { groupTruncated: false };
  }
  const selected: string[] = [];
  let truncated = false;
  for (const row of rows()) {
    const key = keyOf(row, mode);
    if (selected.includes(key)) continue;
    if (selected.length < MAX_GROUP_KEYS) {
      selected.push(key);
      selected.sort(compareCodePointStrings);
      continue;
    }
    truncated = true;
    const last = selected.at(-1);
    if (last !== undefined && compareCodePointStrings(key, last) < 0) {
      selected[selected.length - 1] = key;
      selected.sort(compareCodePointStrings);
    }
  }
  const counts = new Map(selected.map((key) => [key, 0]));
  for (const row of rows()) {
    const key = keyOf(row, mode);
    const count = counts.get(key);
    if (count !== undefined) counts.set(key, count + 1);
  }
  return {
    groups: selected.map((key) => ({ key, count: counts.get(key) ?? 0 })),
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
