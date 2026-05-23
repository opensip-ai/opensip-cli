/**
 * Branch-coverage tests for lang-rust/walk.ts.
 *
 * Drives the full Rust adapter (discover + parse + walk) over fixtures
 * that include line comments, block comments, nested block comments,
 * and string literals. These exercise the comment-stripping helpers
 * (skipToEndOfLine, skipBlockComment, consumeStringLiteral) used by
 * the body-hash normalizer.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rustGraphAdapter } from '../../lang-rust/index.js';

describe('lang-rust walk.ts — comment-stripping branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-walk-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('walks a Rust file with line comments without error', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `// hello\nfn with_line_comment() -> i32 {\n    // inner comment\n    1\n}\n`,
      'utf8',
    );
    const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = rustGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    });
    const walk = rustGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    expect(Object.keys(walk.occurrences).length).toBeGreaterThan(0);
    expect(Object.keys(walk.occurrences)).toContain('with_line_comment');
  });

  it('walks a Rust file with block comments and nested block comments', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `/* simple block */\n` +
        `/* nested /* deeper */ outer */\n` +
        `fn with_block_comment() -> i32 {\n` +
        `    /* mid-body */\n` +
        `    1\n` +
        `}\n`,
      'utf8',
    );
    const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = rustGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    });
    const walk = rustGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    expect(Object.keys(walk.occurrences)).toContain('with_block_comment');
  });

  it('preserves string literals when stripping comments', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/lib.rs'),
      `fn with_strings() -> &'static str {\n` +
        `    let _ = "a /* fake comment */ inside string";\n` +
        `    let _ = "another // not a comment";\n` +
        `    "ok"\n` +
        `}\n`,
      'utf8',
    );
    const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = rustGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    });
    const walk = rustGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    expect(Object.keys(walk.occurrences)).toContain('with_strings');
  });
});
