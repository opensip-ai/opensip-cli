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
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir, diagnosticIntent: 'quiet' });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
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
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir, diagnosticIntent: 'quiet' });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
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
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir, diagnosticIntent: 'quiet' });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walk = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    expect(Object.keys(walk.occurrences)).toContain('with_docstring');
  });

  it('excludes function docstrings from walked body hashes', () => {
    writeFileSync(
      join(dir, 'a.py'),
      `def work():
    """First description."""
    return 1
`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'b.py'),
      `def work():
    """Different description."""
    return 1
`,
      'utf8',
    );
    const discovery = pythonGraphAdapter.discoverFiles({
      cwd: dir,
      diagnosticIntent: 'quiet',
    });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walk = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const workOccurrences = walk.occurrences.work ?? [];
    expect(workOccurrences).toHaveLength(2);
    expect(workOccurrences[0]?.bodyHash).toBe(workOccurrences[1]?.bodyHash);
  });

  it('excludes ordinary quoted and concatenated function docstrings from body hashes', () => {
    writeFileSync(
      join(dir, 'a.py'),
      `def work():
    'First description.'
    return 1
`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'b.py'),
      `def work():
    "Different " "description."
    return 1
`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'c.py'),
      `def work():
    (
        r"Third "
        u"description."
    )
    return 1
`,
      'utf8',
    );
    const discovery = pythonGraphAdapter.discoverFiles({
      cwd: dir,
      diagnosticIntent: 'quiet',
    });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walk = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const workOccurrences = walk.occurrences.work ?? [];
    expect(workOccurrences).toHaveLength(3);
    expect(new Set(workOccurrences.map((occurrence) => occurrence.bodyHash)).size).toBe(1);
  });

  it('keeps bytes and formatted string expressions in body hashes', () => {
    writeFileSync(
      join(dir, 'a.py'),
      `def bytes_work():
    b"first"
    return 1

def formatted_work():
    f"first"
    return 1
`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'b.py'),
      `def bytes_work():
    b"second"
    return 1

def formatted_work():
    f"second"
    return 1
`,
      'utf8',
    );
    const discovery = pythonGraphAdapter.discoverFiles({
      cwd: dir,
      diagnosticIntent: 'quiet',
    });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walk = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const bytesOccurrences = walk.occurrences.bytes_work ?? [];
    const formattedOccurrences = walk.occurrences.formatted_work ?? [];
    expect(bytesOccurrences).toHaveLength(2);
    expect(bytesOccurrences[0]?.bodyHash).not.toBe(bytesOccurrences[1]?.bodyHash);
    expect(formattedOccurrences).toHaveLength(2);
    expect(formattedOccurrences[0]?.bodyHash).not.toBe(formattedOccurrences[1]?.bodyHash);
  });
});
