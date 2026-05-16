/**
 * FunctionNode id format helpers.
 *
 * Hybrid id: `fn:${contentHash}@${filePath}#${simpleName}`. The content hash
 * is the join key for duplicate-body detection; filePath and simpleName
 * tie-break two functions whose bodies happen to collide in different files.
 *
 * Helpers here are pure string ops — no fs / parsing — so they're cheap to
 * call in tight loops.
 */

import { createHash } from 'node:crypto';

const ID_PREFIX = 'fn:';

/** Build a FunctionNode id from its three components. */
export function makeFunctionId(opts: {
  contentHash: string;
  filePath: string;
  simpleName: string;
}): string {
  return `${ID_PREFIX}${opts.contentHash}@${opts.filePath}#${opts.simpleName}`;
}

/**
 * Parse a FunctionNode id back into its three components. Returns null
 * if the input doesn't match the expected shape — callers should treat
 * a null result as a corrupted catalog entry.
 */
export function parseFunctionId(
  id: string,
): { contentHash: string; filePath: string; simpleName: string } | null {
  if (!id.startsWith(ID_PREFIX)) return null;
  const body = id.slice(ID_PREFIX.length);
  const at = body.indexOf('@');
  if (at === -1) return null;
  const contentHash = body.slice(0, at);
  const rest = body.slice(at + 1);
  // simpleName comes after the LAST '#' so paths containing '#' still parse
  // (filePath shouldn't contain '#', but defensive parsing is cheap).
  const hash = rest.lastIndexOf('#');
  if (hash === -1) return null;
  const filePath = rest.slice(0, hash);
  const simpleName = rest.slice(hash + 1);
  if (!contentHash || !filePath || !simpleName) return null;
  return { contentHash, filePath, simpleName };
}

/**
 * Hash a function body for the content-hash join key.
 *
 * The body is whitespace-collapsed — runs of whitespace become a single space,
 * leading/trailing whitespace is trimmed — so two functions that differ only
 * in formatting produce the same hash. Comments are NOT stripped here; if the
 * caller wants comment-insensitive hashing, strip comments first.
 */
export function hashFunctionBody(body: string): string {
  const collapsed = body.replaceAll(/\s+/g, ' ').trim();
  return createHash('sha256').update(collapsed).digest('hex').slice(0, 16);
}

/** Hash a file's full contents (used for file-level cache invalidation). */
export function hashFileContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
