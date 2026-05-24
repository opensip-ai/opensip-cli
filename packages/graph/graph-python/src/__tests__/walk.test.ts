/**
 * Branch-coverage tests for lang-python/walk.ts.
 *
 * Drives the full Python adapter (discover + parse + walk) over
 * fixtures that include `#` comments and string literals. These
 * exercise the comment-stripping helpers used by the body-hash
 * normalizer.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pythonGraphAdapter } from '../index.js';

describe('lang-python walk.ts — comment-stripping branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-python-walk-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks a Python file with hash comments without error', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `# hello\ndef with_hash_comment():\n    # inner\n    return 1\n`,
      'utf8',
    );
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    });
    const walk = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    expect(Object.keys(walk.occurrences)).toContain('with_hash_comment');
  });

  it('preserves string literals containing # characters', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def with_string():\n    s = "not # a comment"\n    return s\n`,
      'utf8',
    );
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    });
    const walk = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    expect(Object.keys(walk.occurrences)).toContain('with_string');
  });

  it('handles triple-quoted docstrings', () => {
    writeFileSync(
      join(dir, 'main.py'),
      `def with_docstring():\n    """A docstring\n    multi-line.\n    """\n    return 1\n`,
      'utf8',
    );
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    });
    const walk = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    expect(Object.keys(walk.occurrences)).toContain('with_docstring');
  });
});
