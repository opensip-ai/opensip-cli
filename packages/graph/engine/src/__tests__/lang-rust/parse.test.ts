/**
 * Branch-coverage tests for lang-rust/parse.ts.
 *
 * Exercises the rootNode.hasError branch by feeding intentionally
 * broken Rust source.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProject } from '../../lang-rust/parse.js';

describe('lang-rust parse.ts — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-parse-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns no parseErrors for a syntactically valid file', () => {
    const file = join(dir, 'main.rs');
    writeFileSync(file, 'fn main() { let x = 1; }\n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [file] });
    expect(out.parseErrors).toEqual([]);
    expect(out.project.files.size).toBe(1);
  });

  it('records a parseError when tree-sitter reports rootNode.hasError', () => {
    const file = join(dir, 'broken.rs');
    // Unterminated function body: tree-sitter will mark hasError but
    // still produce a partial tree.
    writeFileSync(file, 'fn broken() { let x =\n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [file] });
    expect(out.parseErrors.length).toBeGreaterThan(0);
    expect(out.parseErrors[0]?.message).toContain('tree-sitter');
    // The partial tree is still retained for the walk stage.
    expect(out.project.files.size).toBe(1);
  });

  it('processes multiple files independently — one bad does not block others', () => {
    const a = join(dir, 'a.rs');
    const b = join(dir, 'b.rs');
    writeFileSync(a, 'fn ok() { }\n', 'utf8');
    writeFileSync(b, 'fn broken() { let x =\n', 'utf8');
    const out = parseProject({ projectDirAbs: dir, files: [a, b] });
    expect(out.project.files.size).toBe(2);
    expect(out.parseErrors.length).toBeGreaterThan(0);
  });

  it('parses Rust source with line comments, block comments, and string literals', () => {
    // Exercises the comment-stripping helpers in walk.ts indirectly:
    // tree-sitter parses fine, the walk later strips comments and
    // preserves strings. This drives the // and /* */ branches.
    const file = join(dir, 'comments.rs');
    writeFileSync(
      file,
      `// line comment\n` +
        `/* block comment */\n` +
        `/* nested /* depth */ stays */\n` +
        `fn with_comments() -> &'static str {\n` +
        `    // more comments\n` +
        `    let s = "a string with /* fake comment */ inside";\n` +
        `    s\n` +
        `}\n`,
      'utf8',
    );
    const out = parseProject({ projectDirAbs: dir, files: [file] });
    expect(out.parseErrors).toEqual([]);
  });
});
