/**
 * `preserveExcludedPath` branch tests for `createDiscover`.
 *
 * Real per-language adapters (e.g. graph-java's `preserveCanonicalSourcePath`)
 * supply this hook to rescue paths that match an `excludedDirGlobs` pattern
 * by NAME but are legitimate source locations by POSITION — e.g. a Java
 * package literally named `build` nested under `src/main/java/...` should
 * not be treated the same as a top-level Gradle `build/` output directory.
 *
 * These tests pin the same shape with a minimal stand-in predicate so the
 * shared `buildIgnore` wiring (the `IgnoreLike.ignored` / `.childrenIgnored`
 * closures in discover.ts) is exercised directly, independent of any single
 * language adapter's exact preservation rule.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiscover } from '../discover.js';

describe('createDiscover — preserveExcludedPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gac-disc-preserve-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Preserve anything nested under a `keep/` root, even if a path segment
  // elsewhere would otherwise match an excluded glob.
  const preserveUnderKeep = (projectRelativePath: string): boolean =>
    projectRelativePath.startsWith('keep/');

  const discover = createDiscover({
    extension: 'go',
    excludedDirGlobs: ['**/vendor/**'],
    preserveExcludedPath: preserveUnderKeep,
    configCandidates: ['go.mod'],
    languageId: 'go',
  });

  it('discovers a file inside an excluded-glob directory when preserveExcludedPath rescues it', () => {
    // `keep/vendor/lib.go` matches `**/vendor/**` by name, but sits under the
    // preserved `keep/` root — the walker must still descend into it
    // (childrenIgnored) and must still report the file itself (ignored).
    mkdirSync(join(dir, 'keep', 'vendor'), { recursive: true });
    writeFileSync(join(dir, 'keep', 'vendor', 'lib.go'), 'package lib\n', 'utf8');
    writeFileSync(join(dir, 'go.mod'), 'module x\n', 'utf8');

    const out = discover({ diagnosticIntent: 'quiet', cwd: dir });

    expect(out.files.some((f) => f.endsWith('keep/vendor/lib.go'))).toBe(true);
  });

  it('still excludes a same-named directory outside the preserved root', () => {
    // Plain `vendor/lib.go` does NOT start with `keep/`, so
    // preserveExcludedPath returns false and the base `**/vendor/**` glob
    // wins — the whole subtree is pruned, unlike the preserved case above.
    mkdirSync(join(dir, 'vendor'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'lib.go'), 'package lib\n', 'utf8');
    writeFileSync(join(dir, 'main.go'), 'package main\n', 'utf8');

    const out = discover({ diagnosticIntent: 'quiet', cwd: dir });

    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatch(/main\.go$/);
  });

  it('discovers both the preserved and the plain file together in one project', () => {
    // Exercises ignored/childrenIgnored deciding differently for two
    // sibling `vendor` directories in the SAME run, not just isolated cases.
    mkdirSync(join(dir, 'keep', 'vendor'), { recursive: true });
    writeFileSync(join(dir, 'keep', 'vendor', 'rescued.go'), 'package lib\n', 'utf8');
    mkdirSync(join(dir, 'vendor'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'excluded.go'), 'package lib\n', 'utf8');
    writeFileSync(join(dir, 'main.go'), 'package main\n', 'utf8');

    const out = discover({ diagnosticIntent: 'quiet', cwd: dir });

    const suffixes = out.files.map((f) => f.split('/').slice(-2).join('/'));
    expect(suffixes).toContain('vendor/rescued.go');
    expect(out.files.some((f) => f.endsWith('vendor/excluded.go'))).toBe(false);
    expect(out.files.some((f) => f.endsWith('main.go'))).toBe(true);
    expect(out.files).toHaveLength(2);
  });
});
