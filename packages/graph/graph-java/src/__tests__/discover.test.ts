/**
 * Branch-coverage tests for graph-java/discover.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverFiles } from '../discover.js';

describe('graph-java discover.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-java-discover-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined configPathAbs when no build file exists', () => {
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toBeUndefined();
    expect(out.files).toEqual([]);
  });

  it('uses gradle.lockfile when present (highest precedence)', () => {
    writeFileSync(join(dir, 'gradle.lockfile'), '# locked\n', 'utf8');
    writeFileSync(join(dir, 'pom.xml'), '<project/>\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toContain('gradle.lockfile');
  });

  it('falls back to pom.xml when no gradle lockfile', () => {
    writeFileSync(join(dir, 'pom.xml'), '<project/>\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toContain('pom.xml');
  });

  it('falls back to build.gradle.kts when no Maven file', () => {
    writeFileSync(join(dir, 'build.gradle.kts'), '// gradle\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toContain('build.gradle.kts');
  });

  it('falls back to build.gradle (Groovy DSL) last', () => {
    writeFileSync(join(dir, 'build.gradle'), '// groovy\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.configPathAbs).toContain('build.gradle');
  });

  it('honors a configPathOverride that exists', () => {
    const override = join(dir, 'custom.xml');
    writeFileSync(override, '<project/>\n', 'utf8');
    const out = discoverFiles({ cwd: dir, configPathOverride: 'custom.xml' });
    expect(out.configPathAbs).toContain('custom.xml');
  });

  it('returns the override path verbatim when the override does not exist', () => {
    const out = discoverFiles({ cwd: dir, configPathOverride: 'nonexistent.xml' });
    expect(out.configPathAbs).toContain('nonexistent.xml');
  });

  it('collects .java files (sorted, dedup) and excludes target/ and build/', () => {
    mkdirSync(join(dir, 'src/main/java'), { recursive: true });
    writeFileSync(join(dir, 'src/main/java/A.java'), 'class A {}\n', 'utf8');
    writeFileSync(join(dir, 'src/main/java/B.java'), 'class B {}\n', 'utf8');
    mkdirSync(join(dir, 'target/classes'), { recursive: true });
    writeFileSync(join(dir, 'target/classes/Stale.java'), 'class Stale {}\n', 'utf8');
    mkdirSync(join(dir, 'build/generated'), { recursive: true });
    writeFileSync(join(dir, 'build/generated/Gen.java'), 'class Gen {}\n', 'utf8');
    const out = discoverFiles({ cwd: dir });
    expect(out.files.length).toBe(2);
    expect(out.files.every((f) => !f.includes('/target/'))).toBe(true);
    expect(out.files.every((f) => !f.includes('/build/'))).toBe(true);
    expect([...out.files]).toEqual([...out.files].sort());
  });
});
