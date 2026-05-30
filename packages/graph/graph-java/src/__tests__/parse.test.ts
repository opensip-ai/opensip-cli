/**
 * Branch-coverage tests for graph-java/parse.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProject } from '../parse.js';

describe('graph-java parse.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-java-parse-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no parseErrors for a syntactically valid file', () => {
    const file = join(dir, 'A.java');
    writeFileSync(file, 'class A { void m() { int x = 1; } }\n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [file], resolutionMode: 'exact' });
    expect(out.parseErrors).toEqual([]);
    expect(out.project.files.size).toBe(1);
  });

  it('records a parseError when tree-sitter reports rootNode.hasError', () => {
    const file = join(dir, 'Broken.java');
    // Unterminated method body — tree-sitter still produces a partial tree.
    writeFileSync(file, 'class Broken { void m() { int x = \n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [file], resolutionMode: 'exact' });
    expect(out.parseErrors.length).toBeGreaterThan(0);
    expect(out.parseErrors[0]?.message).toContain('tree-sitter');
    expect(out.project.files.size).toBe(1);
  });

  it('processes multiple files independently', () => {
    const a = join(dir, 'A.java');
    const b = join(dir, 'B.java');
    writeFileSync(a, 'class A { void ok() {} }\n', 'utf8');
    writeFileSync(b, 'class B { void broken() { int x = \n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [a, b], resolutionMode: 'exact' });
    expect(out.project.files.size).toBe(2);
    expect(out.parseErrors.length).toBeGreaterThan(0);
  });

  it('parses Java source with line/block/Javadoc comments and string literals', () => {
    const file = join(dir, 'Comments.java');
    writeFileSync(
      file,
      `// line comment\n` +
        `/* block comment */\n` +
        `/** Javadoc */\n` +
        `class Comments {\n` +
        `  /** method Javadoc */\n` +
        '  String m() {\n' +
        '    String s = "a /* fake comment */ inside";\n' +
        '    String t = """\n      multi-line text block\n      """;\n' +
        '    return s + t;\n' +
        `  }\n` +
        `}\n`,
      'utf8',
    );
    const out = parseProject({ projectDirAbs: dir, files: [file], resolutionMode: 'exact' });
    expect(out.parseErrors).toEqual([]);
  });
});
