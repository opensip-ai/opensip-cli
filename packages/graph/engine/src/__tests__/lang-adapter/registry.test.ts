/**
 * Unit tests for the language-adapter registry.
 *
 * The registry is a process-global Map<string, GraphLanguageAdapter>.
 * Every test starts by clearing it so registration state is
 * deterministic, and restores any previous adapters afterwards (today
 * tests don't run alongside a bootstrap-time registration, but the
 * registry is global so we still need to clean up).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _clearAdaptersForTesting,
  pickAdapter,
  registerAdapter,
} from '../../lang-adapter/registry.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';

function fakeAdapter(id: string, exts: readonly string[]): GraphLanguageAdapter {
  return {
    id,
    fileExtensions: exts,
    displayName: id,
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: '/tmp',
      files: [],
    }),
    parseProject: (): ParseOutput => ({ project: null, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {},
      callSites: [],
      parseErrors: [],
    }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => `${id}-test`,
  };
}

describe('registerAdapter / pickAdapter', () => {
  beforeEach(() => {
    _clearAdaptersForTesting();
  });

  afterEach(() => {
    _clearAdaptersForTesting();
  });

  it('throws ConfigurationError when no adapters are registered', () => {
    expect(() => pickAdapter()).toThrow(ConfigurationError);
    expect(() => pickAdapter('/tmp')).toThrow(/no language adapter registered/);
  });

  it('returns the only adapter when exactly one is registered', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    registerAdapter(ts);
    expect(pickAdapter()).toBe(ts);
    expect(pickAdapter('/tmp')).toBe(ts);
  });

  it('re-registering an adapter with the same id replaces the previous one', () => {
    registerAdapter(fakeAdapter('typescript', ['.ts']));
    const replacement = fakeAdapter('typescript', ['.tsx']);
    registerAdapter(replacement);
    expect(pickAdapter()).toBe(replacement);
  });
});

describe('pickAdapter — multi-adapter dominance', () => {
  let dir: string;

  beforeEach(() => {
    _clearAdaptersForTesting();
    dir = mkdtempSync(join(tmpdir(), 'graph-registry-'));
  });

  afterEach(() => {
    _clearAdaptersForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFiles(rel: readonly string[]): void {
    for (const r of rel) {
      const p = join(dir, r);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '');
    }
  }

  it('picks by file-extension dominance', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    const py = fakeAdapter('python', ['.py']);
    registerAdapter(ts);
    registerAdapter(py);
    writeFiles(['src/a.py', 'src/b.py', 'src/c.py', 'src/x.ts']);
    expect(pickAdapter(dir)).toBe(py);
  });

  it('tie-breaks in favor of typescript', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    const py = fakeAdapter('python', ['.py']);
    registerAdapter(ts);
    registerAdapter(py);
    writeFiles(['src/a.py', 'src/x.ts']);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('tie-breaks in favor of python when typescript is not present', () => {
    const py = fakeAdapter('python', ['.py']);
    const rs = fakeAdapter('rust', ['.rs']);
    registerAdapter(py);
    registerAdapter(rs);
    writeFiles(['src/a.py', 'src/x.rs']);
    expect(pickAdapter(dir)).toBe(py);
  });

  it('falls back to typescript preference when no files match', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    const py = fakeAdapter('python', ['.py']);
    registerAdapter(ts);
    registerAdapter(py);
    // Empty cwd, but no cwd-based override either
    expect(pickAdapter()).toBe(ts);
  });

  it('falls back to typescript preference when cwd has zero matching files', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    const py = fakeAdapter('python', ['.py']);
    registerAdapter(ts);
    registerAdapter(py);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('skips node_modules / dist / build when counting files', () => {
    const py = fakeAdapter('python', ['.py']);
    const ts = fakeAdapter('typescript', ['.ts']);
    registerAdapter(py);
    registerAdapter(ts);
    writeFiles([
      'node_modules/poison.py',
      'node_modules/poison2.py',
      'dist/poison.py',
      'build/poison.py',
      'src/real.ts',
    ]);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('handles adapters with multiple extensions', () => {
    const ts = fakeAdapter('typescript', ['.ts', '.tsx']);
    const py = fakeAdapter('python', ['.py']);
    registerAdapter(ts);
    registerAdapter(py);
    writeFiles(['src/a.tsx', 'src/b.tsx', 'src/c.py']);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('ignores adapters with empty fileExtensions in dominance counting', () => {
    const empty = fakeAdapter('empty', []);
    const ts = fakeAdapter('typescript', ['.ts']);
    registerAdapter(empty);
    registerAdapter(ts);
    writeFiles(['src/a.ts']);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('tolerates extension specs without a leading dot', () => {
    const ts = fakeAdapter('typescript', ['ts']);
    const py = fakeAdapter('python', ['py']);
    registerAdapter(ts);
    registerAdapter(py);
    writeFiles(['src/a.py', 'src/b.py']);
    expect(pickAdapter(dir)).toBe(py);
  });
});
