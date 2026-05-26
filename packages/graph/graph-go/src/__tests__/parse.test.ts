/**
 * Branch-coverage tests for graph-go/parse.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProject } from '../parse.js';

describe('graph-go parse.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-go-parse-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no parseErrors for a syntactically valid file', () => {
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\nfunc main() { x := 1; _ = x }\n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [file] });
    expect(out.parseErrors).toEqual([]);
    expect(out.project.files.size).toBe(1);
  });

  it('records a parseError when tree-sitter reports rootNode.hasError', () => {
    const file = join(dir, 'broken.go');
    // Unterminated function body — tree-sitter marks hasError but
    // still produces a partial tree.
    writeFileSync(file, 'package main\nfunc broken() { x := \n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [file] });
    expect(out.parseErrors.length).toBeGreaterThan(0);
    expect(out.parseErrors[0]?.message).toContain('tree-sitter');
    expect(out.project.files.size).toBe(1);
  });

  it('processes multiple files independently', () => {
    const a = join(dir, 'a.go');
    const b = join(dir, 'b.go');
    writeFileSync(a, 'package main\nfunc ok() { }\n', 'utf8');
    writeFileSync(b, 'package main\nfunc broken() { x := \n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [a, b] });
    expect(out.project.files.size).toBe(2);
    expect(out.parseErrors.length).toBeGreaterThan(0);
  });

  it('parses Go source with line comments, block comments, and string literals', () => {
    const file = join(dir, 'comments.go');
    writeFileSync(
      file,
      `package main\n` +
        `// line comment\n` +
        `/* block comment */\n` +
        `func withComments() string {\n` +
        `    // more comments\n` +
        '    s := "a string with /* fake comment */ inside"\n' +
        '    r := `raw string spanning\nmultiple lines`\n' +
        `    _ = r\n` +
        `    return s\n` +
        `}\n`,
      'utf8',
    );
    const out = parseProject({ projectDirAbs: dir, files: [file] });
    expect(out.parseErrors).toEqual([]);
  });
});
