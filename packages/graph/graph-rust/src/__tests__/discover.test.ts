/**
 * Branch-coverage tests for lang-rust/discover.ts.
 *
 * Exercises the configPath resolution branches (override, Cargo.lock,
 * Cargo.toml, none) and the file-collection logic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverFiles } from '../discover.js';

describe('lang-rust discover.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-discover-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined configPathAbs when no Cargo.toml or Cargo.lock exists', () => {
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeUndefined();
    expect(out.files).toEqual([]);
  });

  it('uses Cargo.lock when present (preferred over Cargo.toml)', () => {
    writeFileSync(join(dir, 'Cargo.lock'), '# lock\n', 'utf8');
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('Cargo.lock');
  });

  it('falls back to Cargo.toml when Cargo.lock absent', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('Cargo.toml');
  });

  it('honors a configPathOverride that exists', () => {
    const override = join(dir, 'custom.toml');
    writeFileSync(override, '[package]\n', 'utf8');
    const out = discoverFiles({ cwd: dir, configPathOverride: 'custom.toml' });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('custom.toml');
  });

  it('returns the override path verbatim when the override does not exist', () => {
    const out = discoverFiles({ cwd: dir, configPathOverride: 'nonexistent.toml' });
    // Existing behavior: when override is supplied but file is missing,
    // the absolute path is still returned (cacheKey emits "missing:..").
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('nonexistent.toml');
  });

  it('collects .rs files (sorted, dedup) and excludes target/', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/lib.rs'), 'fn x() {}\n', 'utf8');
    writeFileSync(join(dir, 'src/main.rs'), 'fn main() {}\n', 'utf8');
    mkdirSync(join(dir, 'target'), { recursive: true });
    writeFileSync(join(dir, 'target/cached.rs'), 'fn excluded() {}\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.files.length).toBe(2);
    expect(out.files.every((f) => !f.includes('/target/'))).toBe(true);
    // Sorted
    expect([...out.files]).toEqual([...out.files].sort());
  });
});
