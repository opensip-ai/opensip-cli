/**
 * BYTE-EXACT init golden (ADR-0038, Phase 0 golden-lock).
 *
 * Pins TODAY's `init` scaffold output — the config bytes, every example file's
 * bytes (including the pinned check ids), the `.gitignore` patch, and the
 * created-directory set — BEFORE the registry-driven refactor (Phases 1–3). The
 * refactor must leave these snapshots UNCHANGED; any diff is a behavior
 * regression, not a re-snapshot. (Phase 2 re-points the `executeInit` call to its
 * new signature but does NOT loosen these assertions.)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fitnessTool } from '@opensip-cli/fitness';
import { simulationTool } from '@opensip-cli/simulation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeInit } from '../commands/init.js';

import type { ToolScaffold } from '../commands/shared.js';
import type { InitOptions } from '@opensip-cli/contracts';

/** The first-party scaffold contributions, mirroring the host's registry aggregation. */
function firstPartyScaffolds(): ToolScaffold[] {
  return [fitnessTool, simulationTool]
    .filter((t) => t.pluginLayout !== undefined)
    .map((t) => ({
      layout: t.pluginLayout!,
      scaffoldExamples: t.scaffoldExamples,
      stableExampleIds: t.stableExampleIds,
      scaffoldConfigBlock: t.scaffoldConfigBlock,
    }));
}

/**
 * The pinned check id fitness embeds for a single language — read from the
 * tool's OWN contribution (ADR-0038), not a CLI-side constant. This is the id
 * that drives stale-scaffolded detection, so asserting the scaffolded file
 * contains it verifies the id-embedding contract end to end.
 */
function pinnedCheckId(language: string): string {
  const files = fitnessTool.scaffoldExamples?.({ languages: [language] }) ?? [];
  const check = files.find((f) => f.filename.startsWith('example-check'));
  if (!check) throw new Error(`no example-check contribution for ${language}`);
  return check.stableId;
}

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-init-golden-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeArgs(overrides: Partial<InitOptions> = {}): InitOptions {
  return { json: false, cwd: testDir, debug: false, ...overrides };
}

function read(rel: string): string {
  return readFileSync(join(testDir, rel), 'utf8');
}

describe('init golden — single language (typescript)', () => {
  it('scaffolds the exact fit+sim layout, config bytes, ids, .gitignore, and dirs', () => {
    const result = executeInit({
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

  it('the config contains the host-rendered fitness: block (Phase 3 must reproduce it)', () => {
    executeInit({
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
  it('scaffolds per-language check files + the polyglot recipe slug list', () => {
    const result = executeInit({
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
