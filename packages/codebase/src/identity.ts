import { createHash } from 'node:crypto';

import { createToolError } from '@opensip-cli/core';

import { codebaseErrorCatalog } from './errors/codebase-error-catalog.js';
import { byCodePoint } from './freeze.js';

import type { ToolError } from '@opensip-cli/core';

type CanonicalFrame =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'value'; readonly value: unknown; readonly arrayElement: boolean }
  | { readonly type: 'leave'; readonly value: object };

function appendFrames(stack: CanonicalFrame[], frames: readonly CanonicalFrame[]): void {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame !== undefined) stack.push(frame);
  }
}

/**
 * The one definition every unencodable-document condition carries (ruling D9). The
 * specific branch travels in the allowlisted `metadata.condition` key, not in the code.
 */
const UNENCODABLE = codebaseErrorCatalog.require('CODEBASE.CONFIG.IDENTITY_UNENCODABLE');

/** Build the coded refusal for one unencodable-document condition. */
function unencodable(condition: 'bigint-scalar' | 'circular-reference', detail: string): ToolError {
  return createToolError(UNENCODABLE, `project config identity cannot encode ${detail}`, {
    metadata: { condition },
  });
}

/**
 * Append one JSON-compatible scalar to the canonical digest stream.
 *
 * @throws {ToolError} `CODEBASE.CONFIG.IDENTITY_UNENCODABLE` when the supplied
 * scalar is a bigint, which JSON cannot encode.
 */
function appendScalar(
  hash: ReturnType<typeof createHash>,
  item: unknown,
  arrayElement: boolean,
): boolean {
  if (item === null) {
    hash.update('null');
    return true;
  }
  switch (typeof item) {
    case 'string':
    case 'boolean': {
      hash.update(JSON.stringify(item));
      return true;
    }
    case 'number': {
      hash.update(Number.isFinite(item) ? JSON.stringify(item) : 'null');
      return true;
    }
    case 'bigint': {
      throw unencodable('bigint-scalar', 'bigint values');
    }
    case 'undefined':
    case 'function':
    case 'symbol': {
      if (arrayElement) hash.update('null');
      return true;
    }
    default: {
      return false;
    }
  }
}

function appendArrayEntries(frames: CanonicalFrame[], entries: readonly unknown[]): void {
  entries.forEach((entry, index) => {
    if (index > 0) frames.push({ type: 'text', value: ',' });
    frames.push({ type: 'value', value: entry, arrayElement: true });
  });
}

function appendObjectEntries(frames: CanonicalFrame[], value: object): void {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => {
      const entry = record[key];
      return entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol';
    })
    .sort(byCodePoint);
  keys.forEach((key, index) => {
    if (index > 0) frames.push({ type: 'text', value: ',' });
    frames.push(
      { type: 'text', value: JSON.stringify(key) },
      { type: 'text', value: ':' },
      { type: 'value', value: record[key], arrayElement: false },
    );
  });
}

function objectFrames(value: object): readonly CanonicalFrame[] {
  const array = Array.isArray(value);
  const frames: CanonicalFrame[] = [{ type: 'text', value: array ? '[' : '{' }];
  if (array) appendArrayEntries(frames, value);
  else appendObjectEntries(frames, value);
  frames.push({ type: 'text', value: array ? ']' : '}' }, { type: 'leave', value });
  return frames;
}

/**
 * Hash one value with deterministic JSON object-key ordering.
 *
 * @throws {ToolError} `CODEBASE.CONFIG.IDENTITY_UNENCODABLE` when the value
 * contains a bigint or circular object reference.
 */
function canonicalJsonDigest(value: unknown): string {
  const hash = createHash('sha256');
  const active = new WeakSet<object>();
  const stack: CanonicalFrame[] = [{ type: 'value', value, arrayElement: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.type === 'text') {
      hash.update(frame.value, 'utf8');
      continue;
    }
    if (frame.type === 'leave') {
      active.delete(frame.value);
      continue;
    }
    const item = frame.value;
    if (appendScalar(hash, item, frame.arrayElement)) continue;
    const objectItem = item as object;
    if (active.has(objectItem)) {
      throw unencodable('circular-reference', 'circular values');
    }
    active.add(objectItem);
    appendFrames(stack, objectFrames(objectItem));
  }
  return hash.digest('hex');
}

/**
 * Stable bounded identity of one already-captured, host-validated config document.
 *
 * @throws {ToolError} `CODEBASE.CONFIG.IDENTITY_UNENCODABLE` when the document
 * contains a bigint or circular object reference.
 */
export function projectConfigIdentity(
  document: Readonly<Record<string, unknown>> | undefined,
): string {
  // The caller supplies the already size-bounded, validated config document.
  // Hash the full bounded projection: hashing a byte prefix would let two valid
  // configurations that differ near the end share an evidence identity.
  return `sha256:${canonicalJsonDigest(document ?? {})}`;
}
