/**
 * @fileoverview Unit tests for `detectPhantomRuntimes`.
 *
 * The "conservative" filter is the critical assertion: only flag
 * directories where `opensip-tools/` contains EXCLUSIVELY `.runtime/`.
 * Any legitimate user content disqualifies the directory — false
 * positives would lead users to delete real work.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectPhantomRuntimes } from '../phantom-detect.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-phantom-detect-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function createPhantomAt(parent: string): string {
  const phantomDir = join(parent, 'opensip-tools', '.runtime', 'logs');
  mkdirSync(phantomDir, { recursive: true });
  writeFileSync(join(phantomDir, 'old.jsonl'), '{}\n', 'utf8');
  return join(parent, 'opensip-tools');
}

describe('detectPhantomRuntimes', () => {
  it('returns empty when cwd === root (no ancestors to scan)', () => {
    expect(detectPhantomRuntimes(testDir, testDir)).toEqual([]);
  });

  it('returns empty when cwd is not below root', () => {
    const other = mkdtempSync(join(tmpdir(), 'opensip-phantom-unrelated-'));
    try {
      expect(detectPhantomRuntimes(other, testDir)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('flags a phantom .runtime/ between cwd and root', () => {
    const sub = join(testDir, 'sub');
    mkdirSync(sub);
    const phantomPath = createPhantomAt(sub);
    const cwd = join(sub, 'deep');
    mkdirSync(cwd);
    const phantoms = detectPhantomRuntimes(cwd, testDir);
    expect(phantoms).toContain(phantomPath);
  });

  it('does NOT flag when opensip-tools/ contains user content (fit/checks)', () => {
    const sub = join(testDir, 'sub');
    mkdirSync(join(sub, 'opensip-tools', 'fit', 'checks'), { recursive: true });
    mkdirSync(join(sub, 'opensip-tools', '.runtime'), { recursive: true });
    writeFileSync(join(sub, 'opensip-tools', 'fit', 'checks', 'custom.mjs'), '\n', 'utf8');
    expect(detectPhantomRuntimes(sub, testDir)).toEqual([]);
  });

  it('flags when opensip-tools/ has .runtime/ + dotfiles only', () => {
    const sub = join(testDir, 'sub');
    mkdirSync(sub);
    createPhantomAt(sub);
    writeFileSync(join(sub, 'opensip-tools', '.gitignore'), '.runtime/\n', 'utf8');
    const phantoms = detectPhantomRuntimes(sub, testDir);
    expect(phantoms).toHaveLength(1);
    expect(phantoms[0]).toBe(join(sub, 'opensip-tools'));
  });

  it('flags multiple phantoms in a chain', () => {
    const a = join(testDir, 'a');
    const b = join(a, 'b');
    mkdirSync(b, { recursive: true });
    createPhantomAt(a);
    createPhantomAt(b);
    const phantoms = detectPhantomRuntimes(b, testDir);
    expect(phantoms).toHaveLength(2);
    expect(phantoms).toContain(join(a, 'opensip-tools'));
    expect(phantoms).toContain(join(b, 'opensip-tools'));
  });

  it('does not infinite-loop when reaching filesystem root unexpectedly', () => {
    // cwd is below root by string, but the walker is bounded by `stop`.
    const sub = join(testDir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const phantoms = detectPhantomRuntimes(sub, testDir);
    expect(phantoms).toEqual([]);
  });
});
