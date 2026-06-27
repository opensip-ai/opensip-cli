import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from '../../lib/logger.js';
import { loadPlugin, loadAllPlugins } from '../loader.js';

import type { DiscoveredPlugin, PluginLayout } from '../types.js';

/** Fit-shaped layout used by the loadAllPlugins discovery tests. */
const FIT_LAYOUT: PluginLayout = {
  domain: 'fit',
  userSubdirs: ['checks', 'recipes'],
};

let testDir: string;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-loader-test-'));
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  debugSpy.mockRestore();
});

function writePluginFile(name: string, content: string): string {
  const filePath = join(testDir, name);
  writeFileSync(filePath, content);
  return filePath;
}

function makeDiscovered(entryPoint: string): DiscoveredPlugin {
  return {
    type: 'file',
    entryPoint,
    namespace: 'test-ns',
    source: 'test-source',
  };
}

describe('loadPlugin', () => {
  it('loads a plugin, calls registerExports, and returns counts', async () => {
    const entry = writePluginFile('plugin-1.mjs', 'export const foo = 1;');
    const discovered = makeDiscovered(entry);
    const registerExports = vi.fn().mockResolvedValue({
      checks: 3,
      recipes: 2,
    });

    const result = await loadPlugin(discovered, registerExports);

    expect(result).toMatchObject({
      namespace: 'test-ns',
      source: 'test-source',
      type: 'file',
      registered: { checks: 3, recipes: 2 },
    });
    expect(result.registered.adapters).toBeUndefined();
    expect(result.registered.scenarios).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(registerExports).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'plugin.loader.load.success',
        namespace: 'test-ns',
      }),
    );
  });

  it('passes through an adapters count when the callback returns it', async () => {
    const entry = writePluginFile('plugin-adapt.mjs', 'export const x = 1;');
    const result = await loadPlugin(makeDiscovered(entry), () => ({
      adapters: 2,
    }));
    expect(result.registered.adapters).toBe(2);
    expect(result.registered.checks).toBeUndefined();
    expect(result.registered.recipes).toBeUndefined();
  });

  it('passes through a scenarios count when the callback returns it', async () => {
    const entry = writePluginFile('plugin-sim.mjs', 'export const x = 1;');
    const result = await loadPlugin(makeDiscovered(entry), () => ({
      scenarios: 5,
    }));
    expect(result.registered.scenarios).toBe(5);
  });

  it('warns when nothing was registered', async () => {
    const entry = writePluginFile('plugin-empty.mjs', 'export const x = 1;');
    await loadPlugin(makeDiscovered(entry), () => ({}));
    const calls = warnSpy.mock.calls.map((c: readonly unknown[]) => c[0]);
    expect(
      calls.some((c: unknown) => (c as { evt?: string }).evt === 'plugin.loader.no_exports'),
    ).toBe(true);
  });

  it('does not warn when at least one counter is non-zero', async () => {
    const entry = writePluginFile('plugin-nonzero.mjs', 'export const x = 1;');
    await loadPlugin(makeDiscovered(entry), () => ({ checks: 1 }));
    const noExports = warnSpy.mock.calls.some(
      (c: readonly unknown[]) => (c[0] as { evt?: string }).evt === 'plugin.loader.no_exports',
    );
    expect(noExports).toBe(false);
  });

  it('captures errors thrown by the callback and returns an error result', async () => {
    const entry = writePluginFile('plugin-err.mjs', 'export const x = 1;');
    const result = await loadPlugin(makeDiscovered(entry), () => {
      throw new Error('boom');
    });
    expect(result.error).toBe('boom');
    expect(result.registered).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'plugin.loader.load.error',
        error: 'boom',
      }),
    );
  });

  it('stringifies non-Error throws', async () => {
    const entry = writePluginFile('plugin-err2.mjs', 'export const x = 1;');
    const result = await loadPlugin(makeDiscovered(entry), () => {
      const nonError: unknown = 'plain string error';
      throw nonError;
    });
    expect(result.error).toBe('plain string error');
  });

  it('handles import failures (missing file)', async () => {
    const discovered = makeDiscovered(join(testDir, 'does-not-exist.mjs'));
    const result = await loadPlugin(discovered, () => ({ checks: 1 }));
    expect(result.error).toBeTruthy();
    expect(result.registered).toEqual({});
  });

  it('passes warn/debug helpers to the callback', async () => {
    const entry = writePluginFile('plugin-ctx.mjs', 'export const x = 1;');
    let captured:
      | {
          warn: typeof globalThis.console.warn;
          debug: typeof globalThis.console.debug;
        }
      | undefined;
    await loadPlugin(makeDiscovered(entry), (_mod, ctx) => {
      ctx.warn('my.evt', 'my message', { extra: 'field' });
      ctx.debug('my.debug.evt', { foo: 'bar' });
      captured = ctx;
      return { checks: 1 };
    });
    expect(captured).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'my.evt',
        msg: 'my message',
        extra: 'field',
        namespace: 'test-ns',
        source: 'test-source',
      }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'my.debug.evt',
        foo: 'bar',
        namespace: 'test-ns',
      }),
    );
  });
});

describe('loadAllPlugins', () => {
  it('returns an empty result when no plugins are discovered (no projectDir)', async () => {
    const result = await loadAllPlugins({ domain: 'lang', userSubdirs: [] }, undefined, () => ({}));
    expect(result.plugins).toEqual([]);
    expect(result.totals).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it('rolls up counts across multiple discovered plugins', async () => {
    // Build a minimal fit project layout that discovers two user-source plugins.
    const checksDir = join(testDir, 'opensip-cli', 'fit', 'checks');
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, 'a.mjs'), 'export const x = 1;');
    writeFileSync(join(checksDir, 'b.mjs'), 'export const x = 2;');

    let call = 0;
    const result = await loadAllPlugins(FIT_LAYOUT, testDir, () => {
      call += 1;
      return { checks: call, recipes: 1 };
    });

    expect(result.plugins.length).toBe(2);
    expect(result.totals.checks).toBe(3); // 1 + 2
    expect(result.totals.recipes).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('collects errors from failing plugins without halting', async () => {
    const checksDir = join(testDir, 'opensip-cli', 'fit', 'checks');
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, 'good.mjs'), 'export const x = 1;');
    writeFileSync(join(checksDir, 'bad.mjs'), 'export const x = 1;');

    const result = await loadAllPlugins(FIT_LAYOUT, testDir, (_mod, ctx) => {
      if (ctx.plugin.source.includes('bad')) {
        throw new Error('bad plugin');
      }
      return { checks: 1 };
    });

    expect(result.plugins.length).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('bad plugin');
    expect(result.totals.checks).toBe(1);
  });

  it('rolls up arbitrary per-kind counts', async () => {
    const checksDir = join(testDir, 'opensip-cli', 'fit', 'checks');
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, 'a.mjs'), 'export const x = 1;');

    const result = await loadAllPlugins(FIT_LAYOUT, testDir, () => ({
      adapters: 3,
      scenarios: 2,
    }));
    expect(result.totals.adapters).toBe(3);
    expect(result.totals.scenarios).toBe(2);
  });
});
