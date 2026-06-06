/**
 * Unit tests for the language-adapter registry.
 *
 * The registry is resolved from the current RunScope. Every test enters a
 * fresh graph scope and clears that scope-bound registry after the case, so
 * registration state stays deterministic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, enterScope, logger } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  currentAdapterRegistry,
  pickAdapter,
} from '../../lang-adapter/registry.js';
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js';

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

describe('adapter registry register / pickAdapter', () => {
  beforeEach(() => {
    // Item 1: adapter registry is per-RunScope. Each test enters a
    // fresh scope (with graph subscope) so `currentAdapterRegistry()`
    // resolves the scope-bound registry instance.
    enterScope(makeGraphTestScope());
  });

  afterEach(() => {
    currentAdapterRegistry().clear();
  });

  it('throws ConfigurationError when no adapters are registered', () => {
    expect(() => pickAdapter()).toThrow(ConfigurationError);
    expect(() => pickAdapter('/tmp')).toThrow(/no language adapter is registered/);
  });

  it('returns the only adapter when exactly one is registered', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    currentAdapterRegistry().register(ts);
    expect(pickAdapter()).toBe(ts);
    expect(pickAdapter('/tmp')).toBe(ts);
  });

  it('re-registering an adapter with the same id replaces the previous one', () => {
    currentAdapterRegistry().register(fakeAdapter('typescript', ['.ts']));
    const replacement = fakeAdapter('typescript', ['.tsx']);
    currentAdapterRegistry().register(replacement);
    expect(pickAdapter()).toBe(replacement);
  });
});

describe('pickAdapter — multi-adapter dominance', () => {
  let dir: string;

  beforeEach(() => {
    enterScope(makeGraphTestScope());
    dir = mkdtempSync(join(tmpdir(), 'graph-registry-'));
  });

  afterEach(() => {
    currentAdapterRegistry().clear();
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
    currentAdapterRegistry().register(ts);
    currentAdapterRegistry().register(py);
    writeFiles(['src/a.py', 'src/b.py', 'src/c.py', 'src/x.ts']);
    expect(pickAdapter(dir)).toBe(py);
  });

  it('tie-breaks in favor of typescript', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    const py = fakeAdapter('python', ['.py']);
    currentAdapterRegistry().register(ts);
    currentAdapterRegistry().register(py);
    writeFiles(['src/a.py', 'src/x.ts']);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('tie-breaks in favor of python when typescript is not present', () => {
    const py = fakeAdapter('python', ['.py']);
    const rs = fakeAdapter('rust', ['.rs']);
    currentAdapterRegistry().register(py);
    currentAdapterRegistry().register(rs);
    writeFiles(['src/a.py', 'src/x.rs']);
    expect(pickAdapter(dir)).toBe(py);
  });

  it('falls back to typescript preference when no files match', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    const py = fakeAdapter('python', ['.py']);
    currentAdapterRegistry().register(ts);
    currentAdapterRegistry().register(py);
    // Empty cwd, but no cwd-based override either
    expect(pickAdapter()).toBe(ts);
  });

  it('falls back to typescript preference when cwd has zero matching files', () => {
    const ts = fakeAdapter('typescript', ['.ts']);
    const py = fakeAdapter('python', ['.py']);
    currentAdapterRegistry().register(ts);
    currentAdapterRegistry().register(py);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('warns with an install hint when no installed adapter matches any file (#4 fix 3)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const ts = fakeAdapter('typescript', ['.ts']);
      const py = fakeAdapter('python', ['.py']);
      currentAdapterRegistry().register(ts);
      currentAdapterRegistry().register(py);
      // `dir` is empty — neither registered adapter matches a file, which
      // is the "Go/Java repo but no Go/Java adapter installed" smell.
      expect(pickAdapter(dir)).toBe(ts);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const payload = warnSpy.mock.calls[0]?.[0] as { evt: string; registered: string[] };
      expect(payload.evt).toBe('graph.lang_adapter.no_match');
      expect(payload.registered).toEqual(expect.arrayContaining(['typescript', 'python']));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips node_modules / dist / build when counting files', () => {
    const py = fakeAdapter('python', ['.py']);
    const ts = fakeAdapter('typescript', ['.ts']);
    currentAdapterRegistry().register(py);
    currentAdapterRegistry().register(ts);
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
    currentAdapterRegistry().register(ts);
    currentAdapterRegistry().register(py);
    writeFiles(['src/a.tsx', 'src/b.tsx', 'src/c.py']);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('ignores adapters with empty fileExtensions in dominance counting', () => {
    const empty = fakeAdapter('empty', []);
    const ts = fakeAdapter('typescript', ['.ts']);
    currentAdapterRegistry().register(empty);
    currentAdapterRegistry().register(ts);
    writeFiles(['src/a.ts']);
    expect(pickAdapter(dir)).toBe(ts);
  });

  it('tolerates extension specs without a leading dot', () => {
    const ts = fakeAdapter('typescript', ['ts']);
    const py = fakeAdapter('python', ['py']);
    currentAdapterRegistry().register(ts);
    currentAdapterRegistry().register(py);
    writeFiles(['src/a.py', 'src/b.py']);
    expect(pickAdapter(dir)).toBe(py);
  });
});
