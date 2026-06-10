import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type * as NodeOs from 'node:os';

let HOME: string;
let projectDir: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => HOME,
  };
});

async function loadModule() {
  return await import('../bootstrap/cli-defaults.js');
}

const originalEnv = { ...process.env };

beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), 'opensip-clidefaults-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'opensip-clidefaults-proj-'));
  delete process.env.OPENSIP_API_KEY;
  vi.resetModules();
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

function writeProjectConfig(yaml: string): void {
  writeFileSync(join(projectDir, 'opensip-tools.config.yml'), yaml);
}

describe('loadCliDefaults', () => {
  it('returns {} when no config exists', async () => {
    const { loadCliDefaults } = await loadModule();
    expect(loadCliDefaults(projectDir)).toEqual({});
  });

  it('reads the cli: block when present', async () => {
    writeProjectConfig(`cli:\n  recipe: my-recipe\n  verbose: true\n`);
    const { loadCliDefaults } = await loadModule();
    expect(loadCliDefaults(projectDir)).toEqual({ recipe: 'my-recipe', verbose: true });
  });

  it('respects an explicit config path', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'opensip-custom-'));
    try {
      const customPath = join(customDir, 'custom.yml');
      writeFileSync(customPath, 'cli:\n  recipe: from-custom\n');
      const { loadCliDefaults } = await loadModule();
      expect(loadCliDefaults(projectDir, customPath)).toEqual({ recipe: 'from-custom' });
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });
});

describe('mergeConfigDefaults', () => {
  // ADR-0022: recipe is no longer merged generically — it is tool-scoped and
  // each tool resolves its own default via resolveToolRecipeName. The generic
  // merge must leave `opts.recipe` untouched (explicit flag only).
  it('does NOT merge cli.recipe onto opts (tool-scoped per ADR-0022)', async () => {
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: undefined,
      verbose: false,
      json: false,
      exclude: [],
      apiKey: undefined,
    };
    mergeConfigDefaults(opts, { recipe: 'x' });
    expect(opts.recipe).toBeUndefined();
  });

  it('leaves an explicit --recipe untouched', async () => {
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: 'explicit',
      verbose: false,
      json: false,
      exclude: [],
      apiKey: undefined,
    };
    mergeConfigDefaults(opts, { recipe: 'from-config' });
    expect(opts.recipe).toBe('explicit');
  });

  it('applies verbose default when flag is false', async () => {
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: undefined,
      verbose: false,
      json: false,
      exclude: [],
      apiKey: undefined,
    };
    mergeConfigDefaults(opts, { verbose: true });
    expect(opts.verbose).toBe(true);
  });

  it('applies json and reportTo defaults', async () => {
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: undefined,
      verbose: false,
      json: false,
      exclude: [],
      apiKey: undefined,
    };
    mergeConfigDefaults(opts, { json: true, reportTo: join(projectDir, 'r') });
    expect(opts.json).toBe(true);
    expect(opts.reportTo).toBe(join(projectDir, 'r'));
  });

  it('extends exclude when empty', async () => {
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: undefined,
      verbose: false,
      json: false,
      exclude: [],
      apiKey: undefined,
    };
    mergeConfigDefaults(opts, { exclude: ['dist/**', 'build/**'] });
    expect(opts.exclude).toEqual(['dist/**', 'build/**']);
  });

  it('does not extend exclude when it already has values', async () => {
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: undefined,
      verbose: false,
      json: false,
      exclude: ['mine/**'],
      apiKey: undefined,
    };
    mergeConfigDefaults(opts, { exclude: ['from-config/**'] });
    expect(opts.exclude).toEqual(['mine/**']);
  });

  it('resolves apiKey via cli config when flag absent and no env var', async () => {
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: undefined,
      verbose: false,
      json: false,
      exclude: [],
      apiKey: undefined,
    };
    mergeConfigDefaults(opts, { apiKey: 'sk-from-cli-block' });
    expect(opts.apiKey).toBe('sk-from-cli-block');
  });

  it('does not overwrite apiKey when explicitly set on opts', async () => {
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: undefined,
      verbose: false,
      json: false,
      exclude: [],
      apiKey: 'explicit-key',
    };
    mergeConfigDefaults(opts, { apiKey: 'sk-from-cli-block' });
    expect(opts.apiKey).toBe('explicit-key');
  });

  it('falls back to resolveApiKey (env var) when neither flag nor cli-block provides one', async () => {
    process.env.OPENSIP_API_KEY = 'sk-from-env';
    const { mergeConfigDefaults } = await loadModule();
    const opts: Record<string, unknown> = {
      recipe: undefined,
      verbose: false,
      json: false,
      exclude: [],
      apiKey: undefined,
    };
    mergeConfigDefaults(opts, {});
    expect(opts.apiKey).toBe('sk-from-env');
  });
});
