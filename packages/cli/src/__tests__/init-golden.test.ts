/**
 * BYTE-EXACT init golden (ADR-0038, Phase 0 golden-lock).
 *
 * Pins TODAY's `init` scaffold output — the config bytes, every example file's
 * bytes (including the pinned check ids), the `.gitignore` patch, and the
 * created-directory set. Any intentional byte change must update the exact
 * snapshot in the same change so this test continues to describe what Init
 * actually writes.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveToolHooks } from '@opensip-cli/core';
import { fitnessTool } from '@opensip-cli/fitness';
import { simulationTool } from '@opensip-cli/simulation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeInit } from '../commands/init.js';

import type { ToolScaffold } from '../commands/shared.js';
import type { InitOptions } from '@opensip-cli/contracts';
import type { DataStoreLockContext } from '@opensip-cli/datastore';

/** The first-party scaffold contributions, mirroring the host's registry aggregation. */
function firstPartyScaffolds(): ToolScaffold[] {
  return [fitnessTool, simulationTool]
    .filter((t) => t.pluginLayout !== undefined)
    .map((t) => {
      const hooks = resolveToolHooks(t);
      return {
        identity: {
          stableId: t.metadata.id,
          name: t.metadata.name,
          version: t.metadata.version,
        },
        layout: t.pluginLayout!,
        scaffoldExamples: hooks.scaffoldExamples,
        stableExampleIds: hooks.stableExampleIds,
        scaffoldConfigBlock: hooks.scaffoldConfigBlock,
      };
    });
}

/**
 * The pinned check id fitness embeds for a single language — read from the
 * tool's OWN contribution (ADR-0038), not a CLI-side constant. This is the id
 * that drives stale-scaffolded detection, so asserting the scaffolded file
 * contains it verifies the id-embedding contract end to end.
 */
function pinnedCheckId(language: string): string {
  const files =
    resolveToolHooks(fitnessTool).scaffoldExamples?.({
      languages: [language],
    }) ?? [];
  const check = files.find((f) => f.filename.startsWith('example-check'));
  if (!check) throw new Error(`no example-check contribution for ${language}`);
  return check.stableId;
}

let testDir: string;
let homeDir: string;
let priorHome: string | undefined;

const DATASTORE_LOCK_CONTEXT = {
  policy: { waitMs: 100, staleMs: 1000, heartbeatMs: 100 },
  command: 'opensip init',
  cwdBasename: 'init-golden-fixture',
} as const satisfies DataStoreLockContext;

beforeEach(() => {
  priorHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'opensip-init-golden-home-'));
  process.env.HOME = homeDir;
  testDir = mkdtempSync(join(tmpdir(), 'opensip-init-golden-'));
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(testDir, { recursive: true, force: true });
});

function makeArgs(
  overrides: Partial<InitOptions> = {},
): InitOptions & { readonly datastoreLockContext: DataStoreLockContext } {
  return {
    json: false,
    cwd: testDir,
    debug: false,
    datastoreLockContext: DATASTORE_LOCK_CONTEXT,
    ...overrides,
  };
}

function read(rel: string): string {
  return readFileSync(join(testDir, rel), 'utf8');
}

describe('init golden — single language (typescript)', () => {
  it('scaffolds the exact fit+sim layout, config bytes, ids, .gitignore, and dirs', async () => {
    const result = await executeInit({
      ...makeArgs({ language: ['typescript'] }),
      toolScaffolds: firstPartyScaffolds(),
    });
    expect(result.created).toBe(true);
    expect(result.gitignoreUpdated).toBe(true);

    // Created-directory set (the generic Phase 2 loop must reproduce this from
    // each tool's pluginLayout.userSubdirs).
    for (const dir of [
      'opensip-cli/fit/checks',
      'opensip-cli/fit/recipes',
      'opensip-cli/sim/scenarios',
      'opensip-cli/sim/recipes',
    ]) {
      expect(existsSync(join(testDir, dir)), `missing dir ${dir}`).toBe(true);
    }

    // The pinned check id is embedded in the check file (drives stale detection).
    const checkSrc = read('opensip-cli/fit/checks/example-check.mjs');
    expect(checkSrc).toContain(pinnedCheckId('typescript'));

    // Byte-exact contracts — the registry-driven refactor must reproduce these.
    expect(read('opensip-cli.config.yml')).toMatchSnapshot('config.yml');
    expect(checkSrc).toMatchSnapshot('fit/checks/example-check.mjs');
    expect(read('opensip-cli/fit/recipes/example-recipe.mjs')).toMatchSnapshot(
      'fit/recipes/example-recipe.mjs',
    );
    expect(read('opensip-cli/sim/scenarios/example-scenario.mjs')).toMatchSnapshot(
      'sim/scenarios/example-scenario.mjs',
    );
    expect(read('opensip-cli/sim/recipes/example-recipe.mjs')).toMatchSnapshot(
      'sim/recipes/example-recipe.mjs',
    );
    expect(read('.gitignore')).toMatchSnapshot('.gitignore');
  });

  it('the config contains the host-rendered fitness: block (Phase 3 must reproduce it)', async () => {
    await executeInit({
      ...makeArgs({ language: ['typescript'] }),
      toolScaffolds: firstPartyScaffolds(),
    });
    const config = read('opensip-cli.config.yml');
    expect(config).toContain('fitness:');
    // Lock the block bytes (from the first `fitness:` line to the end of its block).
    const block = config.slice(config.indexOf('fitness:'));
    expect(block).toMatchSnapshot('fitness-block');
  });
});

describe('init golden — polyglot (rust,typescript)', () => {
  it('scaffolds per-language check files + the polyglot recipe slug list', async () => {
    const result = await executeInit({
      ...makeArgs({ language: ['rust', 'typescript'] }),
      toolScaffolds: firstPartyScaffolds(),
    });
    expect(result.created).toBe(true);

    const rustCheck = read('opensip-cli/fit/checks/example-check-rust.mjs');
    const tsCheck = read('opensip-cli/fit/checks/example-check-typescript.mjs');
    expect(rustCheck).toContain(pinnedCheckId('rust'));
    expect(tsCheck).toContain(pinnedCheckId('typescript'));

    expect(rustCheck).toMatchSnapshot('poly/example-check-rust.mjs');
    expect(tsCheck).toMatchSnapshot('poly/example-check-typescript.mjs');
    // The recipe's slug list references the per-language check slugs.
    const recipe = read('opensip-cli/fit/recipes/example-recipe.mjs');
    expect(recipe).toContain('example-check-rust');
    expect(recipe).toContain('example-check-typescript');
    expect(recipe).toMatchSnapshot('poly/fit/recipes/example-recipe.mjs');
  });
});
