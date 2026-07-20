import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_REPAIR_FILE_BYTES,
  readSafeTextFile,
  resolveRepairTargetPath,
  sha256Text,
} from '../path-safety.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-repair-path-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('repair path safety', () => {
  it('rejects invalid, escaping, and missing repair targets', () => {
    expect(resolveRepairTargetPath(root, '')).toMatchObject({
      ok: false,
      error: { code: 'invalid-target' },
    });
    expect(resolveRepairTargetPath(root, 'bad\0path')).toMatchObject({
      ok: false,
      error: { code: 'invalid-target' },
    });
    expect(resolveRepairTargetPath(root, '../outside.ts')).toMatchObject({
      ok: false,
      error: { code: 'unsafe-path' },
    });
    expect(readSafeTextFile(root, 'missing.ts')).toMatchObject({
      ok: false,
      error: { code: 'file-not-found' },
    });
  });

  it('reads safe text files, normalizes absolute paths, and returns hashes', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    const filePath = join(root, 'src/example.ts');
    writeFileSync(filePath, 'hello\n', 'utf8');

    const resolved = resolveRepairTargetPath(root, realpathSync(filePath));
    expect(resolved).toMatchObject({
      ok: true,
      value: { relativePath: 'src/example.ts' },
    });

    const read = readSafeTextFile(root, 'src/example.ts');
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.content).toBe('hello\n');
      expect(read.value.hash).toBe(sha256Text('hello\n'));
    }
  });

  it('accepts in-root filenames that begin with two dots', () => {
    const filePath = join(root, '..generated.ts');
    writeFileSync(filePath, 'generated\n', 'utf8');

    expect(resolveRepairTargetPath(root, '..generated.ts')).toMatchObject({
      ok: true,
      value: { relativePath: '..generated.ts' },
    });
    expect(readSafeTextFile(root, '..generated.ts')).toMatchObject({
      ok: true,
      value: { content: 'generated\n' },
    });
  });

  it('rejects directory and oversized file targets', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(readSafeTextFile(root, 'src')).toMatchObject({
      ok: false,
      error: { code: 'invalid-target' },
    });

    writeFileSync(join(root, 'large.txt'), 'x'.repeat(MAX_REPAIR_FILE_BYTES + 1), 'utf8');
    expect(readSafeTextFile(root, 'large.txt')).toMatchObject({
      ok: false,
      error: { code: 'file-too-large' },
    });
  });
});
