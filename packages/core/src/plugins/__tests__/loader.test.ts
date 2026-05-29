import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from '../../lib/logger.js';
import { loadPlugin, loadAllPlugins } from '../loader.js';

import type { DiscoveredPlugin } from '../types.js';

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
      checksRegistered: 3,
      recipesRegistered: 2,
    });

    const result = await loadPlugin(discovered, registerExports);

    expect(result).toMatchObject({
      namespace: 'test-ns',
      source: 'test-source',
      type: 'file',
      checksRegistered: 3,
      recipesRegistered: 2,
    });
    expect(result.adaptersRegistered).toBeUndefined();
    expect(result.scenariosRegistered).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(registerExports).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'plugin.loader.load.success',
        namespace: 'test-ns',
      }),
    );
  });

  it('includes adaptersRegistered when callback returns it', async () => {
    const entry = writePluginFile('plugin-adapt.mjs', 'export const x = 1;');
    const result = await loadPlugin(makeDiscovered(entry), () => ({
      adaptersRegistered: 2,
    }));
    expect(result.adaptersRegistered).toBe(2);
    expect(result.checksRegistered).toBe(0);
    expect(result.recipesRegistered).toBe(0);
  });

  it('includes scenariosRegistered when callback returns it', async () => {
    const entry = writePluginFile('plugin-sim.mjs', 'export const x = 1;');
    const result = await loadPlugin(makeDiscovered(entry), () => ({
      scenariosRegistered: 5,
    }));
    expect(result.scenariosRegistered).toBe(5);
  });

  it('warns when nothing was registered', async () => {
    const entry = writePluginFile('plugin-empty.mjs', 'export const x = 1;');
    await loadPlugin(makeDiscovered(entry), () => ({}));
    const calls = warnSpy.mock.calls.map((c: readonly unknown[]) => c[0]);
    expect(calls.some((c: unknown) => (c as { evt?: string }).evt === 'plugin.loader.no_exports')).toBe(true);
  });

  it('does not warn when at least one counter is non-zero', async () => {
    const entry = writePluginFile('plugin-nonzero.mjs', 'export const x = 1;');
    await loadPlugin(makeDiscovered(entry), () => ({ checksRegistered: 1 }));
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
    expect(result.checksRegistered).toBe(0);
    expect(result.recipesRegistered).toBe(0);
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
    const result = await loadPlugin(discovered, () => ({ checksRegistered: 1 }));
    expect(result.error).toBeTruthy();
    expect(result.checksRegistered).toBe(0);
  });

  it('passes warn/debug helpers to the callback', async () => {
    const entry = writePluginFile('plugin-ctx.mjs', 'export const x = 1;');
    let captured: { warn: typeof globalThis.console.warn; debug: typeof globalThis.console.debug } | undefined;
    await loadPlugin(makeDiscovered(entry), (_mod, ctx) => {
      ctx.warn('my.evt', 'my message', { extra: 'field' });
      ctx.debug('my.debug.evt', { foo: 'bar' });
      captured = ctx;
      return { checksRegistered: 1 };
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
    const result = await loadAllPlugins('lang', undefined, () => ({}));
    expect(result.plugins).toEqual([]);
    expect(result.totalChecks).toBe(0);
    expect(result.totalRecipes).toBe(0);
    expect(result.totalAdapters).toBe(0);
    expect(result.totalScenarios).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('rolls up counts across multiple discovered plugins', async () => {
    // Build a minimal fit project layout that discovers two user-source plugins.
    const checksDir = join(testDir, 'opensip-tools', 'fit', 'checks');
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, 'a.mjs'), 'export const x = 1;');
    writeFileSync(join(checksDir, 'b.mjs'), 'export const x = 2;');

    let call = 0;
    const result = await loadAllPlugins('fit', testDir, () => {
      call += 1;
      return { checksRegistered: call, recipesRegistered: 1 };
    });

    expect(result.plugins.length).toBe(2);
    expect(result.totalChecks).toBe(3); // 1 + 2
    expect(result.totalRecipes).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('collects errors from failing plugins without halting', async () => {
    const checksDir = join(testDir, 'opensip-tools', 'fit', 'checks');
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, 'good.mjs'), 'export const x = 1;');
    writeFileSync(join(checksDir, 'bad.mjs'), 'export const x = 1;');

    const result = await loadAllPlugins('fit', testDir, (_mod, ctx) => {
      if (ctx.plugin.source.includes('bad')) {
        throw new Error('bad plugin');
      }
      return { checksRegistered: 1 };
    });

    expect(result.plugins.length).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('bad plugin');
    expect(result.totalChecks).toBe(1);
  });

  it('rolls up adapter and scenario counts', async () => {
    const checksDir = join(testDir, 'opensip-tools', 'fit', 'checks');
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, 'a.mjs'), 'export const x = 1;');

    const result = await loadAllPlugins('fit', testDir, () => ({
      adaptersRegistered: 3,
      scenariosRegistered: 2,
    }));
    expect(result.totalAdapters).toBe(3);
    expect(result.totalScenarios).toBe(2);
  });
});
