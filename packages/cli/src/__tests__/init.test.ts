/**
 * @fileoverview init command — language detection, scaffolding,
 * gitignore append, ambiguous-language prompt.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireRuntimeExclusiveLease,
  logger,
  resolveEphemeralProjectPaths,
  resolveProjectContext,
  resolveProjectPaths,
  resolveToolHooks,
  touchEphemeralRuntime,
} from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { fitnessTool } from '@opensip-cli/fitness';
import { simulationTool } from '@opensip-cli/simulation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDatastoreLockContext } from '../bootstrap/state-lock-policy.js';
import { createInitAuthoredPlan } from '../commands/init/init-authored-plan.js';
import {
  detectLanguages,
  parseLanguageFlag,
  type SupportedLanguage,
} from '../commands/init/language-detection.js';
import { renderGitignore } from '../commands/init/scaffold-writer.js';
import { executeInit } from '../commands/init.js';

import type { ToolScaffold } from '../commands/shared.js';
import type { InitOptions } from '@opensip-cli/contracts';

/** First-party scaffold contributions (ADR-0038), mirroring the host's registry aggregation. */
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

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-init-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ADR-0038: executeInit now takes the registered tools' scaffold contributions.
// makeArgs injects the first-party set so every existing call site is unchanged.
function makeArgs(overrides: Partial<InitOptions> = {}): Parameters<typeof executeInit>[0] {
  return {
    json: false,
    cwd: testDir,
    debug: false,
    datastoreLockContext: buildDatastoreLockContext(logger, {
      commandName: 'opensip init test',
      cwd: overrides.cwd ?? testDir,
    }),
    toolScaffolds: firstPartyScaffolds(),
    ...overrides,
  };
}

function seedVerifiedRuntime(runtimeDir: string, log: string): void {
  mkdirSync(join(runtimeDir, 'logs'), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(runtimeDir, 0o700);
    chmodSync(join(runtimeDir, 'logs'), 0o700);
  }
  writeFileSync(join(runtimeDir, 'logs', 'run.jsonl'), log, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const datastore = DataStoreFactory.open({
    backend: 'sqlite',
    path: join(runtimeDir, 'datastore.sqlite'),
  });
  const closed = datastore.closeForLifecycle?.();
  if (closed === undefined) datastore.close();
  else if (!closed.closed) throw new Error('Init test datastore did not close');
}

// =============================================================================
// detectLanguages
// =============================================================================

describe('detectLanguages', () => {
  it('detects Rust via Cargo.toml', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
    expect(detectLanguages(testDir)).toEqual(['rust']);
  });

  it('detects Python via pyproject.toml', () => {
    writeFileSync(join(testDir, 'pyproject.toml'), '');
    expect(detectLanguages(testDir)).toEqual(['python']);
  });

  it('detects Python via requirements.txt', () => {
    writeFileSync(join(testDir, 'requirements.txt'), 'pytest\n');
    expect(detectLanguages(testDir)).toEqual(['python']);
  });

  it('detects Go via go.mod', () => {
    writeFileSync(join(testDir, 'go.mod'), 'module x');
    expect(detectLanguages(testDir)).toEqual(['go']);
  });

  it('detects TypeScript via tsconfig.json', () => {
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');
    expect(detectLanguages(testDir)).toEqual(['typescript']);
  });

  it('detects TypeScript fallback via package.json when no other markers present', () => {
    writeFileSync(join(testDir, 'package.json'), '{}');
    expect(detectLanguages(testDir)).toEqual(['typescript']);
  });

  it('does NOT add typescript when package.json sits alongside another marker', () => {
    // A Rust workspace with a docs site shouldn't get TS scaffolding by default.
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
    writeFileSync(join(testDir, 'package.json'), '{}');
    expect(detectLanguages(testDir)).toEqual(['rust']);
  });

  it('returns multiple when polyglot', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');
    const detected = detectLanguages(testDir).sort();
    expect(detected).toEqual(['rust', 'typescript']);
  });

  it('detects C/C++ via Makefile', () => {
    writeFileSync(join(testDir, 'Makefile'), 'all:\n\tcc main.c\n');
    expect(detectLanguages(testDir)).toEqual(['cpp']);
  });

  it('returns empty when no markers present', () => {
    expect(detectLanguages(testDir)).toEqual([]);
  });
});

// =============================================================================
// parseLanguageFlag
// =============================================================================

describe('parseLanguageFlag', () => {
  it('accepts a single language', () => {
    expect(parseLanguageFlag('rust')).toEqual(['rust']);
  });

  it('accepts comma-separated list', () => {
    expect(parseLanguageFlag('rust,typescript')).toEqual(['rust', 'typescript']);
  });

  it('trims whitespace and lowercases', () => {
    expect(parseLanguageFlag(' Rust , TYPESCRIPT ')).toEqual(['rust', 'typescript']);
  });

  it('deduplicates', () => {
    expect(parseLanguageFlag('rust,rust,typescript')).toEqual(['rust', 'typescript']);
  });

  it('rejects unknown languages', () => {
    expect(() => parseLanguageFlag('cobol')).toThrow(/Unknown language 'cobol'/);
  });

  it('rejects an empty list', () => {
    expect(() => parseLanguageFlag('')).toThrow(/empty list/);
  });
});

// =============================================================================
// executeInit — happy paths
// =============================================================================

describe('executeInit (single language)', () => {
  it.each([false, true])(
    'targets the canonical uninitialized workspace root from a nested cwd (cwdExplicit=%s)',
    async (cwdExplicit) => {
      const project = join(testDir, cwdExplicit ? 'explicit' : 'implicit');
      const nested = join(project, 'packages', 'app');
      mkdirSync(join(project, '.git'), { recursive: true });
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(project, 'tsconfig.json'), '{}');
      const projectContext = resolveProjectContext({
        cwd: nested,
        cwdExplicit,
        stopAt: project,
      });

      const result = await executeInit({
        ...makeArgs({ cwd: nested }),
        cwdExplicit,
        projectContext,
      });

      expect(result.created).toBe(true);
      expect(result.cwd).toBe(projectContext.projectRoot);
      expect(result.languages).toEqual(['typescript']);
      expect(existsSync(join(project, 'opensip-cli.config.yml'))).toBe(true);
      expect(existsSync(join(nested, 'opensip-cli.config.yml'))).toBe(false);
    },
  );

  it.each([false, true])(
    'keeps the initialized root authoritative from a nested cwd (cwdExplicit=%s)',
    async (cwdExplicit) => {
      const project = join(testDir, 'initialized');
      const nested = join(project, 'packages', 'app');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(project, 'opensip-cli.config.yml'), 'schemaVersion: 1\n');
      writeFileSync(join(project, 'tsconfig.json'), '{}');
      const projectContext = resolveProjectContext({
        cwd: nested,
        cwdExplicit,
        stopAt: project,
      });

      const result = await executeInit({
        ...makeArgs({ cwd: nested, language: ['typescript'] }),
        cwdExplicit,
        projectContext,
      });
      expect(result.cwd).toBe(projectContext.projectRoot);
      expect(result.insideExistingProject).toBeUndefined();
      expect(existsSync(join(project, 'opensip-cli.config.yml'))).toBe(true);
      expect(existsSync(join(nested, 'opensip-cli.config.yml'))).toBe(false);
    },
  );

  it('scaffolds the project layout for a Rust project', async () => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');

    const result = await executeInit(makeArgs());

    expect(result.created).toBe(true);
    expect(result.languages).toEqual(['rust']);
    expect(result.createdFiles).toBeDefined();

    // Config + 4 example files
    expect(existsSync(join(testDir, 'opensip-cli.config.yml'))).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
      true,
    );
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'recipes', 'example-recipe.mjs'))).toBe(
      true,
    );
    expect(
      existsSync(join(testDir, 'opensip-cli', 'sim', 'scenarios', 'example-scenario.mjs')),
    ).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli', 'sim', 'recipes', 'example-recipe.mjs'))).toBe(
      true,
    );

    // Config has the right target shape
    const config = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(config).toContain('rust-source:');
    expect(config).toContain('languages: [rust]');
    expect(config).toContain('"src/**/*.rs"');

    // Example check has matching scope.languages
    const check = readFileSync(
      join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'),
      'utf8',
    );
    expect(check).toContain("const CHECK_SCOPE = { languages: ['rust']");

    // .gitignore was created/appended
    expect(result.gitignoreUpdated).toBe(true);
    const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('opensip-cli/.runtime/');
  });

  it('scaffolds for TypeScript when --language is explicit', async () => {
    const result = await executeInit(makeArgs({ language: ['typescript'] }));
    expect(result.languages).toEqual(['typescript']);
    const config = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(config).toContain('typescript-source:');
  });

  it('reclassifies authored state after waiting for the exclusive lease', async () => {
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');
    const existingConfig = 'schemaVersion: 1\n# initialized by the winning invocation\n';
    let injected = false;

    const result = await executeInit(makeArgs(), {
      acquireLease: async (input) => {
        const lease = await acquireRuntimeExclusiveLease(input);
        mkdirSync(join(testDir, 'opensip-cli'), { recursive: true });
        writeFileSync(join(testDir, 'opensip-cli.config.yml'), existingConfig);
        writeFileSync(join(testDir, 'opensip-cli', 'winner.txt'), 'preserve\n');
        injected = true;
        return lease;
      },
    });

    expect(injected).toBe(true);
    expect(result).toMatchObject({
      created: false,
      refreshed: true,
      state: 'fully-initialized',
    });
    expect(result.languages).toBeUndefined();
    expect(readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8')).toBe(existingConfig);
    expect(readFileSync(join(testDir, 'opensip-cli', 'winner.txt'), 'utf8')).toBe('preserve\n');
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
      false,
    );
  }, 15_000);

  it('moves no-init runtime state into the project runtime during adoption', async () => {
    const oldHome = process.env.HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), 'opensip-init-home-'));
    process.env.HOME = isolatedHome;
    try {
      writeFileSync(join(testDir, 'tsconfig.json'), '{}');
      const ephemeralPaths = resolveEphemeralProjectPaths(testDir);
      touchEphemeralRuntime(ephemeralPaths);
      const ephemeralRuntime = ephemeralPaths.runtimeDir;
      seedVerifiedRuntime(ephemeralRuntime, '{}\n');

      const result = await executeInit(makeArgs());
      const projectRuntime = resolveProjectPaths(testDir).runtimeDir;

      expect(result.created).toBe(true);
      expect(existsSync(join(projectRuntime, 'logs', 'run.jsonl'))).toBe(true);
      expect(existsSync(ephemeralRuntime)).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports divergent runtime authority without overwriting either tree', async () => {
    const oldHome = process.env.HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), 'opensip-init-home-'));
    process.env.HOME = isolatedHome;
    try {
      writeFileSync(join(testDir, 'tsconfig.json'), '{}');
      const ephemeralPaths = resolveEphemeralProjectPaths(testDir);
      touchEphemeralRuntime(ephemeralPaths);
      const ephemeralRuntime = ephemeralPaths.runtimeDir;
      seedVerifiedRuntime(ephemeralRuntime, 'ephemeral\n');
      const projectRuntime = resolveProjectPaths(testDir).runtimeDir;
      seedVerifiedRuntime(projectRuntime, 'project\n');

      const result = await executeInit(makeArgs());

      expect(result.created).toBe(false);
      expect(result.runtimeAdoption).toMatchObject({
        status: 'conflict',
        reasonCode: 'divergent',
        sourcePreserved: true,
      });
      expect(readFileSync(join(projectRuntime, 'logs', 'run.jsonl'), 'utf8')).toBe('project\n');
      expect(readFileSync(join(ephemeralRuntime, 'logs', 'run.jsonl'), 'utf8')).toBe('ephemeral\n');
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe('executeInit (polyglot)', () => {
  it('scaffolds one example check per language with distinct slugs', async () => {
    const result = await executeInit(makeArgs({ language: ['rust', 'typescript'] }));
    expect(result.languages).toEqual(['typescript', 'rust']);

    expect(
      existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check-rust.mjs')),
    ).toBe(true);
    expect(
      existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check-typescript.mjs')),
    ).toBe(true);

    // Recipe references both
    const recipe = readFileSync(
      join(testDir, 'opensip-cli', 'fit', 'recipes', 'example-recipe.mjs'),
      'utf8',
    );
    expect(recipe).toContain("'example-check-rust'");
    expect(recipe).toContain("'example-check-typescript'");

    // Config has a target per language
    const config = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(config).toContain('rust-source:');
    expect(config).toContain('typescript-source:');
  });
});

// =============================================================================
// executeInit — error paths
// =============================================================================

describe('executeInit (ambiguous language)', () => {
  it('refuses to scaffold when multiple language markers present and no --language', async () => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');

    const result = await executeInit(makeArgs());

    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError).toBeDefined();
    expect([...(result.ambiguousLanguageError?.detected ?? [])].sort()).toEqual([
      'rust',
      'typescript',
    ]);
    expect(result.ambiguousLanguageError?.message).toContain('--language');

    // Nothing was written
    expect(existsSync(join(testDir, 'opensip-cli.config.yml'))).toBe(false);
    expect(existsSync(join(testDir, 'opensip-cli'))).toBe(false);
  });

  it('refuses to scaffold when no language markers present and no --language', async () => {
    const result = await executeInit(makeArgs());

    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError).toBeDefined();
    expect(result.ambiguousLanguageError?.detected).toEqual([]);
  });

  it('returns an error result when --language is unknown', async () => {
    const result = await executeInit(makeArgs({ language: ['cobol'] }));
    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError?.message).toContain("Unknown language 'cobol'");
  });

  // Regression for the 2026-05-25 audit fix: previously a non-existent
  // --cwd returned `{ created: false, state: 'pristine' }` with no error
  // discriminant, so register-init mapped it to exit 0. The fix surfaces
  // it as ambiguousLanguageError so the existing exit-2 path fires.
  it('surfaces a structured error when --cwd does not exist on disk', async () => {
    const missing = join(testDir, 'definitely-does-not-exist');
    const result = await executeInit(makeArgs({ cwd: missing }));
    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError).toBeDefined();
    expect(result.ambiguousLanguageError?.detected).toEqual([]);
    expect(result.ambiguousLanguageError?.message).toContain(missing);
  });
});

describe('executeInit (fully-initialized state)', () => {
  beforeEach(() => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
  });

  it('refreshes guidance without overwriting config or examples by default', async () => {
    await executeInit(makeArgs());
    const before = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    const examplePath = join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs');
    const exampleBefore = readFileSync(examplePath, 'utf8');

    const second = await executeInit(makeArgs());
    expect(second.created).toBe(false);
    expect(second.refreshed).toBe(true);
    expect(second.state).toBe('fully-initialized');
    expect(second.partialStateError).toBeUndefined();
    expect(second.agentGuidance?.targets.length).toBeGreaterThan(0);

    const after = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(after).toBe(before);
    expect(readFileSync(examplePath, 'utf8')).toBe(exampleBefore);
  });

  it('--remove rebuilds authored files while preserving runtime evidence', async () => {
    await executeInit(makeArgs());
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), '# manually edited');
    // Custom file in the dir — should be removed by --remove.
    writeFileSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs'), '// custom');
    const retainedEvidence = join(testDir, 'opensip-cli', '.runtime', 'logs', 'retained.jsonl');
    mkdirSync(join(testDir, 'opensip-cli', '.runtime', 'logs'), {
      recursive: true,
    });
    writeFileSync(retainedEvidence, '{"retained":true}\n', 'utf8');

    const result = await executeInit(makeArgs({ remove: true }));
    expect(result.created).toBe(true);
    expect(result.state).toBe('fully-initialized');

    const config = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(config).toContain('rust-source:');
    expect(config).not.toContain('manually edited');
    // Custom file is gone.
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs'))).toBe(
      false,
    );
    expect(readFileSync(retainedEvidence, 'utf8')).toBe('{"retained":true}\n');
  });

  it('--remove preserves generated output and a pnpm-like dependency symlink opaquely', async () => {
    if (process.platform === 'win32') return;
    await executeInit(makeArgs());
    const generated = join(testDir, 'opensip-cli', 'fit', 'dist', 'bundle.js');
    mkdirSync(join(generated, '..'), { recursive: true });
    writeFileSync(generated, 'generated output\n');
    const dependencyTarget = join(testDir, 'dependency-store');
    mkdirSync(dependencyTarget, { recursive: true });
    writeFileSync(join(dependencyTarget, 'sentinel.txt'), 'dependency data\n');
    const dependencyLink = join(testDir, 'opensip-cli', 'fit', 'node_modules');
    symlinkSync(dependencyTarget, dependencyLink);

    const result = await executeInit(makeArgs({ remove: true }));

    expect(result.created).toBe(true);
    expect(readFileSync(generated, 'utf8')).toBe('generated output\n');
    expect(readFileSync(join(dependencyLink, 'sentinel.txt'), 'utf8')).toBe('dependency data\n');
  });

  it('--keep preserves existing config and custom files', async () => {
    await executeInit(makeArgs());
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), '# manually edited');
    // A user-authored file that --keep must preserve.
    const customPath = join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs');
    writeFileSync(customPath, '// custom logic');
    // A scaffolded file the user has tweaked — counts as 'custom' under
    // hash-based detection because the bytes drifted, so --keep
    // preserves it. (The audit calls this out as the safer outcome.)
    const tweakedPath = join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs');
    writeFileSync(tweakedPath, '// I edited this');

    const result = await executeInit(makeArgs({ keep: true }));
    expect(result.created).toBe(true);
    expect(result.state).toBe('fully-initialized');

    // Existing root config is authoritative project state under --keep.
    const config = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(config).toBe('# manually edited');
    expect(result.createdFiles).not.toContain(join(testDir, 'opensip-cli.config.yml'));
    // Custom file preserved.
    expect(readFileSync(customPath, 'utf8')).toBe('// custom logic');
    // Tweaked example also preserved (drifted bytes → custom).
    expect(readFileSync(tweakedPath, 'utf8')).toBe('// I edited this');
  });
});

describe('executeInit (partial-config-only state)', () => {
  beforeEach(() => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
    // Create only the config (no opensip-cli/ dir).
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), '# stub');
  });

  it('refreshes guidance by default without scaffolding examples', async () => {
    const result = await executeInit(makeArgs());
    expect(result.created).toBe(false);
    expect(result.refreshed).toBe(true);
    expect(result.state).toBe('partial-config-only');
    expect(result.partialStateError).toBeUndefined();
    expect(result.agentGuidance?.targets.length).toBeGreaterThan(0);
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
      false,
    );
  });

  it('--keep scaffolds the missing dir', async () => {
    const configBefore = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    const result = await executeInit(makeArgs({ keep: true }));
    expect(result.created).toBe(true);
    expect(readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8')).toBe(configBefore);
    expect(result.createdFiles).not.toContain(join(testDir, 'opensip-cli.config.yml'));
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
      true,
    );
  });

  it('--remove scaffolds (no dir to remove)', async () => {
    const result = await executeInit(makeArgs({ remove: true }));
    expect(result.created).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
      true,
    );
  });
});

describe('executeInit (concurrent authored-state changes)', () => {
  it('fails before journaling when the exact plan snapshot disagrees with classification', async () => {
    const configPath = join(testDir, 'opensip-cli.config.yml');
    const result = await executeInit(makeArgs({ language: ['typescript'] }), {
      createPlan: (input) => {
        writeFileSync(configPath, '# created by another process\n');
        return createInitAuthoredPlan(input);
      },
    });

    expect(result.created).toBe(false);
    expect(result.state).toBe('partial-config-only');
    expect(result.authoredStateChangedError?.observedState).toBe('partial-config-only');
    expect(result.authoredStateChangedError?.message).toContain('No files were changed');
    expect(readFileSync(configPath, 'utf8')).toBe('# created by another process\n');
    expect(existsSync(join(testDir, 'opensip-cli'))).toBe(false);
  });
});

describe('executeInit (partial-dir-only state)', () => {
  beforeEach(() => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
    // Create only the dir + a custom file (no config).
    mkdirSync(join(testDir, 'opensip-cli', 'fit', 'checks'), {
      recursive: true,
    });
    writeFileSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs'), '// custom');
  });

  it('refuses by default with a partial-state error listing the custom file', async () => {
    const result = await executeInit(makeArgs());
    expect(result.created).toBe(false);
    expect(result.state).toBe('partial-dir-only');
    expect(result.partialStateError?.state).toBe('partial-dir-only');
    const customFile = result.partialStateError?.preExistingFiles.find((f) =>
      f.path.endsWith('my-real-check.mjs'),
    );
    expect(customFile?.classification).toBe('custom');
  });

  it('--keep preserves the custom file and writes the YAML', async () => {
    const result = await executeInit(makeArgs({ keep: true }));
    expect(result.created).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli.config.yml'))).toBe(true);
    expect(result.createdFiles).toContain(join(testDir, 'opensip-cli.config.yml'));
    expect(
      readFileSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs'), 'utf8'),
    ).toBe('// custom');
  });

  it('--remove blows away the dir and writes the YAML', async () => {
    const result = await executeInit(makeArgs({ remove: true }));
    expect(result.created).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli.config.yml'))).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs'))).toBe(
      false,
    );
    // The fresh scaffolded example IS there.
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
      true,
    );
  });
});

describe('executeInit (polyglot drift)', () => {
  it('classifies a stale-language scaffold and surfaces it under --keep', async () => {
    // Initial polyglot scaffold.
    await executeInit(makeArgs({ language: ['typescript', 'rust'] }));
    expect(
      existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check-rust.mjs')),
    ).toBe(true);

    // Re-init with only typescript + --keep. The rust example should be
    // tagged stale-scaffolded and preserved (we don't remove it; user
    // may have been working with it).
    const result = await executeInit(makeArgs({ language: ['typescript'], keep: true }));
    expect(result.created).toBe(true);
    expect(result.state).toBe('fully-initialized');

    const stale = result.preExistingFiles?.find((f) => f.path.endsWith('example-check-rust.mjs'));
    expect(stale?.classification).toBe('stale-scaffolded');

    // Still on disk.
    expect(
      existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check-rust.mjs')),
    ).toBe(true);
  });
});

describe('executeInit (mutex flags)', () => {
  beforeEach(() => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
  });

  it('rejects --keep --remove together', async () => {
    const result = await executeInit(makeArgs({ keep: true, remove: true }));
    expect(result.created).toBe(false);
    expect(result.partialStateError?.message).toContain('mutually exclusive');
  });
});

// =============================================================================
// .gitignore handling
// =============================================================================

describe('executeInit (.gitignore)', () => {
  beforeEach(() => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
  });

  it('creates .gitignore when absent', async () => {
    expect(existsSync(join(testDir, '.gitignore'))).toBe(false);
    const result = await executeInit(makeArgs());
    expect(result.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(testDir, '.gitignore'), 'utf8')).toContain('opensip-cli/.runtime/');
  });

  it('purely renders the same create, append, and idempotent bytes', () => {
    const created = renderGitignore(undefined);
    expect(created).toEqual({
      content: 'opensip-cli/.runtime/\n',
      changed: true,
    });

    const appended = renderGitignore('node_modules/\n');
    expect(appended).toEqual({
      content: 'node_modules/\n\n# opensip-cli runtime state\nopensip-cli/.runtime/\n',
      changed: true,
    });
    expect(renderGitignore(appended.content)).toEqual({
      content: appended.content,
      changed: false,
    });
  });

  it('appends to an existing .gitignore', async () => {
    writeFileSync(join(testDir, '.gitignore'), 'node_modules/\ntarget/\n');
    const result = await executeInit(makeArgs());
    expect(result.gitignoreUpdated).toBe(true);
    const content = readFileSync(join(testDir, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('target/');
    expect(content).toContain('opensip-cli/.runtime/');
  });

  it('does NOT duplicate the line on re-init with --remove', async () => {
    await executeInit(makeArgs());
    const first = readFileSync(join(testDir, '.gitignore'), 'utf8');

    const result = await executeInit(makeArgs({ remove: true }));
    expect(result.gitignoreUpdated).toBe(false);

    const second = readFileSync(join(testDir, '.gitignore'), 'utf8');
    expect(second).toBe(first);
  });
});

// =============================================================================
// AGENTS.md handling
// =============================================================================

describe('executeInit (AGENTS.md)', () => {
  beforeEach(() => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
  });

  it('creates AGENTS.md on pristine init', async () => {
    const result = await executeInit(makeArgs());
    expect(result.agentsMdCreated).toBe(true);
    expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('Agent Playbook');
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('OpenSIP MCP First');
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('auto-load a newer catalog');
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('get_runtime_wiring');
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('hard-cap reasons');
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('agent-fast');
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('trust.fullyVerified');
  });

  it('creates a graph-only AGENTS.md when no fit scaffold domain is registered', async () => {
    const result = await executeInit({ ...makeArgs(), toolScaffolds: [] });
    const agents = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    expect(result.agentsMdCreated).toBe(true);
    expect(agents).toContain('opensip graph impact --changed --json --top 20');
    expect(agents).toContain('trust.fullyVerified');
    expect(agents).toContain('opensip graph --recipe agent-final --gate-compare');
    expect(agents).not.toContain('agent-fast');
  });

  it('updates an existing AGENTS.md managed block and preserves custom content', async () => {
    writeFileSync(join(testDir, 'AGENTS.md'), '# Custom playbook\n', 'utf8');
    const result = await executeInit(makeArgs());
    expect(result.agentsMdCreated).toBe(false);
    const agents = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# Custom playbook');
    expect(agents).toContain('OpenSIP MCP First');
    expect(
      result.agentGuidance?.targets.find((target) => target.path.endsWith('AGENTS.md'))?.action,
    ).toBe('updated');
  });

  it('refreshes AGENTS.md on re-init with --keep without duplicating the block', async () => {
    await executeInit(makeArgs());
    const first = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    const result = await executeInit(makeArgs({ keep: true }));
    expect(result.agentsMdCreated).toBe(false);
    const second = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    expect(second).toBe(first);
    expect(second.split('<!-- opensip:agent-guidance start -->')).toHaveLength(2);
  });

  it('updates an existing CLAUDE.md during refresh', async () => {
    await executeInit(makeArgs());
    writeFileSync(join(testDir, 'CLAUDE.md'), '# Claude\n\nCustom guidance.\n', 'utf8');
    const result = await executeInit(makeArgs());
    const claude = readFileSync(join(testDir, 'CLAUDE.md'), 'utf8');
    expect(result.refreshed).toBe(true);
    expect(
      result.agentGuidance?.targets.find((target) => target.path.endsWith('CLAUDE.md'))?.action,
    ).toBe('updated');
    expect(claude).toContain('Custom guidance.');
    expect(claude).toContain('OpenSIP MCP First');
  });
});

// =============================================================================
// SupportedLanguage type spot-check
// =============================================================================

describe('SupportedLanguage', () => {
  it('exhausts the known set', async () => {
    const all: SupportedLanguage[] = ['typescript', 'rust', 'python', 'go', 'java', 'cpp'];
    for (const lang of all) {
      const result = await executeInit(makeArgs({ language: [lang] }));
      expect(result.languages).toEqual([lang]);
      // Cleanup so each language gets a fresh testDir state
      rmSync(join(testDir, 'opensip-cli.config.yml'), { force: true });
      rmSync(join(testDir, 'opensip-cli'), { recursive: true, force: true });
      rmSync(join(testDir, '.gitignore'), { force: true });
    }
  });
});
