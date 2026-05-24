/**
 * Unit tests for the language-adapter registry's `pickAdapter` heuristic.
 *
 * PR 6 of plan docs/plans/10-graph-language-pluggability.md introduced
 * file-extension dominance counting when ≥ 2 adapters are registered.
 * These tests cover the dominance heuristic + tie-breaking preference
 * order.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@opensip-tools/core';
import {
  _clearAdaptersForTesting,
  pickAdapter,
  registerAdapter,
} from '@opensip-tools/graph';
import { pythonGraphAdapter } from '@opensip-tools/graph-python';
import { rustGraphAdapter } from '@opensip-tools/graph-rust';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';



import { typescriptGraphAdapter } from '../index.js';

describe('pickAdapter — registry-size shortcuts', () => {
  beforeEach(() => {
    _clearAdaptersForTesting();
  });

  afterEach(() => {
    _clearAdaptersForTesting();
  });

  it('throws when no adapter is registered', () => {
    expect(() => pickAdapter()).toThrow(ConfigurationError);
  });

  it('returns the only adapter when exactly one is registered', () => {
    registerAdapter(rustGraphAdapter);
    const picked = pickAdapter('/tmp');
    expect(picked.id).toBe('rust');
  });

  it('falls back to alphabetical order when no preferred adapter is registered', () => {
    // Register only non-typescript adapters; tie between python and rust.
    // resolveTie's preference list contains 'python' first, so it wins.
    // Then drop 'python' and only register rust → falls through to
    // alphabetical sort, picks rust.
    const dir = mkdtempSync(join(tmpdir(), 'graph-pick-fb-'));
    try {
      registerAdapter(rustGraphAdapter);
      // Write only an unrelated file so the dominance counter sees no
      // matches and findMaxCount returns null.
      writeFileSync(join(dir, 'README.md'), '', 'utf8');
      const picked = pickAdapter(dir);
      expect(picked.id).toBe('rust');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pickAdapter — multi-adapter dominance heuristic', () => {
  let dir: string;

  beforeEach(() => {
    _clearAdaptersForTesting();
    registerAdapter(typescriptGraphAdapter);
    registerAdapter(pythonGraphAdapter);
    registerAdapter(rustGraphAdapter);
    dir = mkdtempSync(join(tmpdir(), 'graph-pick-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    _clearAdaptersForTesting();
  });

  it('picks Python when only .py files are present', () => {
    writeFileSync(join(dir, 'a.py'), 'def foo(): pass\n', 'utf8');
    writeFileSync(join(dir, 'b.py'), 'def bar(): pass\n', 'utf8');
    const adapter = pickAdapter(dir);
    expect(adapter.id).toBe('python');
  });

  it('picks Rust when only .rs files are present', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/lib.rs'), 'fn foo() {}\n', 'utf8');
    writeFileSync(join(dir, 'src/main.rs'), 'fn main() {}\n', 'utf8');
    const adapter = pickAdapter(dir);
    expect(adapter.id).toBe('rust');
  });

  it('picks the dominant language when multiple are present', () => {
    // 3 .py files, 1 .rs file → Python wins.
    writeFileSync(join(dir, 'a.py'), 'pass', 'utf8');
    writeFileSync(join(dir, 'b.py'), 'pass', 'utf8');
    writeFileSync(join(dir, 'c.py'), 'pass', 'utf8');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/lib.rs'), 'fn foo() {}', 'utf8');
    expect(pickAdapter(dir).id).toBe('python');
  });

  it('breaks ties by preferring TypeScript', () => {
    // 1 .ts and 1 .py file → tie at 1; TypeScript wins.
    writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/index.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(dir, 'a.py'), 'pass', 'utf8');
    expect(pickAdapter(dir).id).toBe('typescript');
  });

  it('falls back to TypeScript when no language files match', () => {
    // Empty dir — heuristic returns no winner; preference list picks TS.
    expect(pickAdapter(dir).id).toBe('typescript');
  });

  it('ignores excluded directories when counting', () => {
    mkdirSync(join(dir, 'target'), { recursive: true });
    writeFileSync(join(dir, 'target/cached.rs'), 'fn x() {}', 'utf8');
    writeFileSync(join(dir, 'a.py'), 'pass', 'utf8');
    expect(pickAdapter(dir).id).toBe('python');
  });
});
