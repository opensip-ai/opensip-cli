/**
 * read-source — per-file source size guard for adapter parse steps.
 *
 * Proves the guard rejects an oversized file (the unbounded-memory hardening)
 * and otherwise behaves like a plain UTF-8 read, so the adapters' existing
 * per-file try/catch records a ParseError + continues on the throw.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_SOURCE_FILE_BYTES, readSourceFileGuarded } from './read-source.js';

describe('readSourceFileGuarded', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function tmpFile(name: string, content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'read-source-'));
    const filePath = join(dir, name);
    writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  it('reads a normal source file as UTF-8', () => {
    const filePath = tmpFile('a.ts', 'export const x = 1;\n');
    expect(readSourceFileGuarded(filePath)).toBe('export const x = 1;\n');
  });

  it('throws (does not load) when the file exceeds the byte guard', () => {
    const filePath = tmpFile('big.ts', 'x'.repeat(64));
    expect(() => readSourceFileGuarded(filePath, 16)).toThrow(/size guard/);
  });

  it('defaults to the shared 10MB ceiling', () => {
    expect(MAX_SOURCE_FILE_BYTES).toBe(10_000_000);
  });

  it('surfaces a stat error for a missing file (so the adapter catch records a ParseError)', () => {
    expect(() => readSourceFileGuarded(join(tmpdir(), 'opensip-missing-source-xyz.ts'))).toThrow();
  });
});
