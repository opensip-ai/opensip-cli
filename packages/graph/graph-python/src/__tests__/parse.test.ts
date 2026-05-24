/**
 * Branch-coverage tests for lang-python/parse.ts.
 *
 * Mirrors the Rust parse tests: exercises the rootNode.hasError branch
 * by feeding intentionally broken Python source.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProject } from '../parse.js';

describe('lang-python parse.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-python-parse-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no parseErrors for a syntactically valid file', () => {
    const file = join(dir, 'main.py');
    writeFileSync(file, 'def main():\n    return 1\n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [file] });
    expect(out.parseErrors).toEqual([]);
    expect(out.project.files.size).toBe(1);
  });

  it('records a parseError when tree-sitter reports rootNode.hasError', () => {
    const file = join(dir, 'broken.py');
    // Unbalanced parens; tree-sitter recovers but flags hasError.
    writeFileSync(file, 'def broken(\n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [file] });
    expect(out.parseErrors.length).toBeGreaterThan(0);
    expect(out.parseErrors[0]?.message).toContain('tree-sitter');
    expect(out.project.files.size).toBe(1);
  });
});
