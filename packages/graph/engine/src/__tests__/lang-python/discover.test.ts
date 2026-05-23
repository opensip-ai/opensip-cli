/**
 * Branch-coverage tests for lang-python/discover.ts.
 *
 * Mirrors the Rust discover tests: exercises the configPath resolution
 * branches (override, pyproject.toml, setup.py, none) and the file-
 * collection logic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverFiles } from '../../lang-python/discover.js';

describe('lang-python discover.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-python-discover-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined configPathAbs when no pyproject.toml or setup.py exists', () => {
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeUndefined();
    expect(out.files).toEqual([]);
  });

  it('uses pyproject.toml when present (preferred over setup.py)', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "p"\n', 'utf8');
    writeFileSync(join(dir, 'setup.py'), 'from setuptools import setup\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('pyproject.toml');
  });

  it('falls back to setup.py when pyproject.toml absent', () => {
    writeFileSync(join(dir, 'setup.py'), 'from setuptools import setup\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('setup.py');
  });

  it('honors a configPathOverride that exists', () => {
    const override = join(dir, 'custom.toml');
    writeFileSync(override, '[project]\n', 'utf8');
    const out = discoverFiles({ cwd: dir, configPathOverride: 'custom.toml' });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('custom.toml');
  });

  it('returns the override path verbatim when the override does not exist', () => {
    const out = discoverFiles({ cwd: dir, configPathOverride: 'nonexistent.toml' });
    expect(out.configPathAbs).toBeDefined();
    expect(out.configPathAbs).toContain('nonexistent.toml');
  });

  it('collects .py files (sorted, dedup) and excludes common build dirs', () => {
    writeFileSync(join(dir, 'a.py'), 'def x(): pass\n', 'utf8');
    writeFileSync(join(dir, 'b.py'), 'def y(): pass\n', 'utf8');
    mkdirSync(join(dir, '.venv'), { recursive: true });
    writeFileSync(join(dir, '.venv/excluded.py'), 'pass\n', 'utf8');
    mkdirSync(join(dir, '__pycache__'), { recursive: true });
    writeFileSync(join(dir, '__pycache__/cached.py'), 'pass\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.files.length).toBe(2);
    expect(out.files.every((f) => !f.includes('/.venv/') && !f.includes('/__pycache__/'))).toBe(true);
    expect([...out.files]).toEqual([...out.files].sort());
  });
});
