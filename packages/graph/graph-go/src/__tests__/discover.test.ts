/**
 * Branch-coverage tests for graph-go/discover.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverFiles } from '../discover.js';

describe('graph-go discover.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-go-discover-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined configPathAbs when no go.mod or go.sum exists', () => {
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeUndefined();
    expect(out.files).toEqual([]);
  });

  it('uses go.sum when present (preferred over go.mod)', () => {
    writeFileSync(join(dir, 'go.sum'), '# checksums\n', 'utf8');
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('go.sum');
  });

  it('falls back to go.mod when go.sum absent', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('go.mod');
  });

  it('honors a configPathOverride that exists', () => {
    const override = join(dir, 'custom.mod');
    writeFileSync(override, 'module example.com/x\n', 'utf8');
    const out = discoverFiles({ cwd: dir, configPathOverride: 'custom.mod' });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('custom.mod');
  });

  it('returns the override path verbatim when the override does not exist', () => {
    const out = discoverFiles({ cwd: dir, configPathOverride: 'nonexistent.mod' });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('nonexistent.mod');
  });

  it('collects .go files (sorted, dedup) and excludes vendor/', () => {
    writeFileSync(join(dir, 'a.go'), 'package main\n', 'utf8');
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg/b.go'), 'package pkg\n', 'utf8');
    mkdirSync(join(dir, 'vendor', 'github.com', 'x'), { recursive: true });
    writeFileSync(join(dir, 'vendor/github.com/x/excluded.go'), 'package x\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.files.length).toBe(2);
    expect(out.files.every((f) => !f.includes('/vendor/'))).toBe(true);
    expect([...out.files]).toEqual([...out.files].sort());
  });
});
