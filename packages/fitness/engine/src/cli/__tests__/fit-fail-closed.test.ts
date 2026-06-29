/**
 * Fitness fail-closed outcomes (ADR-0060, Phase 4).
 *
 * Setup failures before a credible scan return command-error — no findings
 * envelope, no runFaulted-driven FAIL (0 Errors, 0 Warnings) presentation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLI_DIAGNOSTIC_CODES } from '@opensip-cli/contracts';
import {
  LanguageRegistry,
  RunScope,
  applyToolContributeScope,
  runWithScope,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFitnessLoadState,
  currentCheckRegistry,
  currentFitnessLoadState,
} from '../../framework/scope-registry.js';
import { fitnessTool } from '../../tool.js';
import { finalizeFitLoadOutcome } from '../fit/load-outcome.js';
import { executeFit } from '../fit.js';

import type * as LoaderModule from '../../plugins/loader.js';
import type { FitOptions } from '@opensip-cli/contracts';
import type * as CoreModule from '@opensip-cli/core';

const DEFAULT_FIT_CONFIG: Record<string, unknown> = {
  targets: {
    source: {
      description: 'minimal',
      languages: ['typescript'],
      concerns: ['backend'],
      include: ['src/**/*.ts'],
    },
  },
};

const loadAllPluginsMock = vi.hoisted(() => vi.fn());
const loadCapabilityDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../plugins/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LoaderModule>();
  return {
    ...actual,
    loadAllPlugins: loadAllPluginsMock,
  };
});

vi.mock('@opensip-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    loadCapabilityDomain: loadCapabilityDomainMock,
  };
});

let projectDir: string;

function fitArgs(cwd: string): FitOptions {
  return {
    json: false,
    list: false,
    recipes: false,
    verbose: false,
    debug: false,
    quiet: true,
    open: false,
    cwd,
    exclude: [],
    gateSave: false,
    gateCompare: false,
  };
}

function withFitScope<T>(
  fn: () => Promise<T>,
  configDocument: Record<string, unknown> = DEFAULT_FIT_CONFIG,
): Promise<T> {
  const scope = new RunScope({
    languages: new LanguageRegistry(),
    runId: 'run_test',
  });
  applyToolContributeScope(scope, fitnessTool);
  Object.assign(scope, { configDocument });
  return runWithScope(scope, fn);
}

function writeMinimalConfig(dir: string): void {
  writeFileSync(
    join(dir, 'opensip-cli.config.yml'),
    `targets:
  source:
    description: minimal
    languages: [typescript]
    concerns: [backend]
    include:
      - "src/**/*.ts"
`,
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'opensip-fit-fail-closed-'));
  writeMinimalConfig(projectDir);
  loadAllPluginsMock.mockReset();
  loadCapabilityDomainMock.mockReset();
  loadAllPluginsMock.mockResolvedValue({ plugins: [], totals: {}, errors: [] });
  loadCapabilityDomainMock.mockResolvedValue([]);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('executeFit fail-closed (ADR-0060)', () => {
  it('returns command-error when the check registry is empty', async () => {
    await withFitScope(async () => {
      const result = await executeFit(fitArgs(projectDir));
      expect(result.envelope).toBeUndefined();
      expect(result.result.type).toBe('error');
      if (result.result.type !== 'error') return;
      expect(result.result.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_EMPTY_CHECK_REGISTRY);
      expect(result.result.diagnostic?.code).toBe(
        CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_EMPTY_CHECK_REGISTRY,
      );
      expect(result.result.diagnostic?.logRef).toBeDefined();
    });
  });

  it('scrubs absolute module paths from required plugin command-error detail', async () => {
    const pluginPath = join(projectDir, 'opensip-cli', 'fit', 'checks');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'broken.mjs'), 'export default {};\n');

    const absolute =
      '/Users/sb/proj/node_modules/.pnpm/@opensip-cli+core@file+packages+core/node_modules/@opensip-cli/core/dist/missing.js';
    loadAllPluginsMock.mockResolvedValue({
      plugins: [],
      totals: {},
      errors: [`broken.mjs: Cannot find module '${absolute}'`],
    });

    await withFitScope(async () => {
      const result = await executeFit(fitArgs(projectDir));
      expect(result.result.type).toBe('error');
      if (result.result.type !== 'error') return;
      expect(result.result.diagnostic?.message).not.toContain('/Users/sb/proj/node_modules');
      const detail = result.result.diagnostic?.detail;
      if (detail !== undefined) {
        expect(detail).not.toContain('/Users/sb/proj/node_modules');
      }
    });
  });

  it('returns command-error when a required project-local plugin fails to load', async () => {
    const pluginPath = join(projectDir, 'opensip-cli', 'fit', 'checks');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(join(pluginPath, 'broken.mjs'), 'export default {};\n');

    loadAllPluginsMock.mockResolvedValue({
      plugins: [],
      totals: {},
      errors: ['broken.mjs: Cannot find module @opensip/missing'],
    });

    await withFitScope(async () => {
      const result = await executeFit(fitArgs(projectDir));
      expect(result.envelope).toBeUndefined();
      expect(result.result.type).toBe('error');
      if (result.result.type !== 'error') return;
      expect(result.result.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_PLUGIN_LOAD_FAILED);
    });
  });

  it('classifies required checkPackages load failure as command-error', async () => {
    await withFitScope(
      () => {
        const load = currentFitnessLoadState();
        Object.assign(load, createFitnessLoadState());
        load.loadedFor = projectDir;
        load.checkPackErrors = ['@acme/required-pack → fit-pack: ERR_MODULE_NOT_FOUND'];
        currentCheckRegistry().register(
          {
            config: {
              id: '00000000-0000-4000-8000-000000000002',
              slug: 'other-check',
              description: 'other',
              tags: [],
              checkScope: 'file',
            },
            analyze: () => [],
          } as never,
          'test',
        );
        finalizeFitLoadOutcome(projectDir);
        expect(load.commandError?.code).toBe(
          CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_CHECK_PACK_LOAD_FAILED,
        );
        return Promise.resolve();
      },
      {
        plugins: { checkPackages: ['@acme/required-pack'] },
        targets: {
          source: {
            description: 'minimal',
            languages: ['typescript'],
            concerns: ['backend'],
            include: ['src/**/*.ts'],
          },
        },
      },
    );
  });

  it('classifies required checkPackages discovery diagnostics as command-error', async () => {
    await withFitScope(
      () => {
        const load = currentFitnessLoadState();
        Object.assign(load, createFitnessLoadState());
        load.loadedFor = projectDir;
        load.checkPackErrors = [
          'package @opensip/fit resolves a different @opensip-cli/core (0.1.14) than this runtime (0.1.15) — skipping to avoid a split run scope',
          'configured package "@acme/missing" is not installed in node_modules — skipping',
        ];
        currentCheckRegistry().register(
          {
            config: {
              id: '00000000-0000-4000-8000-000000000003',
              slug: 'other-check',
              description: 'other',
              tags: [],
              checkScope: 'file',
            },
            analyze: () => [],
          } as never,
          'test',
        );
        finalizeFitLoadOutcome(projectDir);
        expect(load.commandError?.code).toBe(
          CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_CHECK_PACK_LOAD_FAILED,
        );
        expect(load.commandError?.message).toContain('@opensip/fit');
        expect(load.loadWarnings).not.toContain('Optional check pack "unknown" failed to load.');
        return Promise.resolve();
      },
      {
        plugins: { checkPackages: ['@opensip/fit', '@acme/missing'] },
        targets: {
          source: {
            description: 'minimal',
            languages: ['typescript'],
            concerns: ['backend'],
            include: ['src/**/*.ts'],
          },
        },
      },
    );
  });

  it('marks optional plugin failure as degraded when built-in checks are registered', async () => {
    await withFitScope(() => {
      const load = currentFitnessLoadState();
      Object.assign(load, createFitnessLoadState());
      load.loadedFor = projectDir;
      load.pluginLoadErrors = ['optional-third-party: import failed'];
      load.checkPackErrors = [];
      currentCheckRegistry().register(
        {
          config: {
            id: '00000000-0000-4000-8000-000000000001',
            slug: 'stub-check',
            description: 'stub',
            tags: [],
            checkScope: 'file',
          },
          analyze: () => [],
        } as never,
        'test',
      );

      finalizeFitLoadOutcome(projectDir);

      expect(load.commandError).toBeUndefined();
      expect(load.loadDegraded).toBe(true);
      expect(load.degradedDiagnostics.length).toBeGreaterThan(0);
      return Promise.resolve();
    });
  });
});
