/**
 * Unit tests for the `no-module-singleton` guardrail.
 *
 * Two layers:
 *  1. The pure `analyzeNoModuleSingleton(content, filePath)` detector —
 *     a re-added registry singleton (flagged), the exempt fileCache/
 *     memoryProfiler (0 findings), the `@allow-module-singleton` escape hatch,
 *     a non-mutable `new` (not matched), and a nested (non-top-level) local.
 *  2. The full `analyzeAll` over a fake in-memory `FileAccessor`.
 */
import { describe, expect, it } from 'vitest';

import { analyzeAllNoModuleSingleton, analyzeNoModuleSingleton } from '../no-module-singleton.js';

import type { FileAccessor } from '@opensip-tools/fitness';

const SRC = 'packages/fitness/engine/src/framework/registry.ts';
const FILE_CACHE = 'packages/fitness/engine/src/framework/file-cache.ts';
const MEM_PROFILER = 'packages/fitness/engine/src/framework/memory-profiler.ts';

describe('analyzeNoModuleSingleton (pure detector)', () => {
  it('flags a re-added registry singleton', () => {
    const v = analyzeNoModuleSingleton('export const defaultRegistry = new CheckRegistry()\n', SRC);
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('no-module-singleton');
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('defaultRegistry');
  });

  it('flags a module-level EventEmitter / Map singleton', () => {
    expect(analyzeNoModuleSingleton('export const bus = new EventEmitter()\n', SRC)).toHaveLength(
      1,
    );
    expect(analyzeNoModuleSingleton('export const cache = new Map()\n', SRC)).toHaveLength(1);
  });

  it('exempts fileCache in file-cache.ts (ADR-0023)', () => {
    expect(
      analyzeNoModuleSingleton('export const fileCache = new FileCache()\n', FILE_CACHE),
    ).toEqual([]);
  });

  it('exempts memoryProfiler in memory-profiler.ts (ADR-0023)', () => {
    expect(
      analyzeNoModuleSingleton(
        'export const memoryProfiler = new MemoryProfiler()\n',
        MEM_PROFILER,
      ),
    ).toEqual([]);
  });

  it('does NOT exempt fileCache when declared in some OTHER file', () => {
    expect(
      analyzeNoModuleSingleton('export const fileCache = new FileCache()\n', SRC),
    ).toHaveLength(1);
  });

  it('honours the @allow-module-singleton inline marker', () => {
    const sameLine =
      'export const r = new CheckRegistry() // @allow-module-singleton legacy seam\n';
    expect(analyzeNoModuleSingleton(sameLine, SRC)).toEqual([]);
    const aboveLine =
      '// @allow-module-singleton legacy seam\nexport const r = new CheckRegistry()\n';
    expect(analyzeNoModuleSingleton(aboveLine, SRC)).toEqual([]);
  });

  it('does not match a non-mutable constructor', () => {
    expect(analyzeNoModuleSingleton('export const url = new URL("x")\n', SRC)).toEqual([]);
    expect(analyzeNoModuleSingleton('export const re = new RegExp("x")\n', SRC)).toEqual([]);
  });

  it('does not match a nested (non-top-level) local registry', () => {
    const nested = `function make() {
  const registry = new CheckRegistry()
  return registry
}\n`;
    expect(analyzeNoModuleSingleton(nested, SRC)).toEqual([]);
  });

  it('does not match a factory return', () => {
    const factory = 'export function createCheckRegistry() { return new CheckRegistry() }\n';
    expect(analyzeNoModuleSingleton(factory, SRC)).toEqual([]);
  });
});

describe('analyzeNoModuleSingleton — module-level mutable `let` (audit F1/F2 shapes)', () => {
  it('flags a loaded-state marker let (F1)', () => {
    const v = analyzeNoModuleSingleton('let scenariosLoadedFor: string | null = null\n', SRC);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toMatch(/loaded-state marker or mutable accumulator/);
  });

  it('flags a mutable-accumulator-typed let (F2: : *Cache)', () => {
    expect(
      analyzeNoModuleSingleton('let activeCache: LanguageParseCache | null = null\n', SRC),
    ).toHaveLength(1);
  });

  it('flags a let initialized to a Map/Set-typed accumulator', () => {
    expect(
      analyzeNoModuleSingleton('let merged: Map<string, number> = new Map()\n', SRC),
    ).toHaveLength(1);
  });

  it('does NOT flag a *Registry-typed let (the cli-context bootstrap seam)', () => {
    expect(
      analyzeNoModuleSingleton('let currentToolRegistry: ToolRegistry | undefined\n', SRC),
    ).toEqual([]);
  });

  it('does NOT flag a primitive/boolean let (telemetry started, warn-once flags)', () => {
    expect(analyzeNoModuleSingleton('let started = false\n', SRC)).toEqual([]);
    expect(analyzeNoModuleSingleton('let cachedBundle: string | null = null\n', SRC)).toEqual([]);
  });

  it('honors the @allow-module-singleton escape hatch on a flagged let', () => {
    const allowed =
      '// @allow-module-singleton process-global by design\nlet activeCache: LanguageParseCache = new LanguageParseCache()\n';
    expect(analyzeNoModuleSingleton(allowed, SRC)).toEqual([]);
  });

  it('does NOT match a nested (non-top-level) let', () => {
    expect(
      analyzeNoModuleSingleton(
        'function f() {\n  let activeCache: SomeCache | null = null\n}\n',
        SRC,
      ),
    ).toEqual([]);
  });
});

/** Build a fake FileAccessor over an in-memory path→content map. */
function fakeAccessor(files: Record<string, string>): FileAccessor {
  return {
    paths: Object.keys(files),
    read: (p) => Promise.resolve(files[p] ?? ''),
    readMany: (ps) => Promise.resolve(new Map(ps.map((p) => [p, files[p] ?? '']))),
    readAll: () => Promise.resolve(new Map(Object.entries(files))),
  };
}

describe('analyzeAllNoModuleSingleton (self-targeting over the file set)', () => {
  it('returns 0 findings for the exempt singletons + a factory', async () => {
    const files = {
      [FILE_CACHE]: 'export const fileCache = new FileCache()\n',
      [MEM_PROFILER]: 'export const memoryProfiler = new MemoryProfiler()\n',
      [SRC]: 'export function createCheckRegistry() { return new CheckRegistry() }\n',
      'packages/fitness/engine/src/framework/registry.test.ts':
        'export const defaultRegistry = new CheckRegistry()\n', // test file — ignored
    };
    expect(await analyzeAllNoModuleSingleton(fakeAccessor(files))).toEqual([]);
  });

  it('flags a re-added default registry singleton', async () => {
    const files = { [SRC]: 'export const defaultRegistry = new CheckRegistry()\n' };
    const v = await analyzeAllNoModuleSingleton(fakeAccessor(files));
    expect(v).toHaveLength(1);
    expect(v[0]?.filePath).toBe(SRC);
  });
});
