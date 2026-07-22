/**
 * @fileoverview Bounded, loop-until-drained `fs.writeSync` wrapper shared by
 * the platform-acceptance atomic writers (`agent-report-writer.mjs`,
 * `evidence-writer.mjs`). A single `fs.writeSync` call is not guaranteed to
 * write the entire buffer (short writes are a documented POSIX possibility),
 * so this loops until every byte is confirmed written, and fails loudly on
 * any invalid byte count instead of silently under-writing the artifact.
 *
 * Takes an injectable `fs` facade (never imports `node:fs` itself) so both
 * callers can pass their own `deps`-overridable `writeSync` for testing.
 */

export function writeAllSync(fs, descriptor, serialized) {
  const buffer = Buffer.from(serialized, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const written = fs.writeSync(descriptor, buffer, offset, remaining);
    if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) {
      throw new Error('writeSync returned an invalid byte count');
    }
    offset += written;
  }
}
