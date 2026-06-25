/**
 * read-source — the single size-guarded source-file reader for graph language
 * adapters.
 *
 * Adapter parse steps read project SOURCE files into memory before handing them
 * to a parser. Reading a whole file is unavoidable, but an *unbounded* read lets
 * one pathological file (a multi-hundred-MB generated/minified bundle) spike
 * graph memory. This wrapper caps a single source file at
 * {@link MAX_SOURCE_FILE_BYTES} (10 MB — the same ceiling the fitness engine's
 * `FileAccessor` enforces, so the two tools share one source-size policy), using
 * a `statSync` pre-check so an oversized file is rejected WITHOUT being loaded.
 *
 * On oversize it THROWS. Adapter parse loops already wrap each per-file read in a
 * try/catch that records a `ParseError` and continues, so an oversized file is
 * skipped with a recorded diagnostic — never fatal, consistent with how a
 * read/parse failure on any single file is already handled.
 */
import { readFileSync, statSync } from 'node:fs';

/**
 * Maximum bytes a single source file may occupy when read for parsing (10 MB).
 * Mirrors the fitness engine's `FileAccessor` `FILE_TOO_LARGE` ceiling.
 */
export const MAX_SOURCE_FILE_BYTES = 10_000_000;

/**
 * Read a source file as UTF-8 with a per-file size guard. Throws if the file
 * exceeds `maxBytes` (default {@link MAX_SOURCE_FILE_BYTES}) — by `statSync`
 * size (checked before the read, so an oversized file is never loaded) or by
 * post-read length (closing the stat→read TOCTOU window). A missing/unreadable
 * file surfaces the underlying `statSync` error, exactly as the prior direct
 * `readFileSync` surfaced its own.
 *
 * @throws {Error} When the file exceeds `maxBytes` (by `statSync` size or
 *   post-read length), or when the underlying `statSync`/`readFileSync` fails
 *   (e.g. a missing or unreadable file). Adapter parse loops catch this per file
 *   and record a `ParseError`, so the throw is non-fatal.
 */
export function readSourceFileGuarded(
  path: string,
  maxBytes: number = MAX_SOURCE_FILE_BYTES,
): string {
  const { size } = statSync(path);
  if (size > maxBytes) {
    throw new Error(`source file exceeds ${maxBytes}-byte size guard (${size} bytes): ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  if (text.length > maxBytes) {
    throw new Error(
      `source file exceeds ${maxBytes}-byte size guard after read (${text.length} bytes): ${path}`,
    );
  }
  return text;
}
