/**
 * @fileoverview init command — language detection, scaffolding,
 * gitignore append, ambiguous-language prompt.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveToolHooks } from '@opensip-cli/core';
import { fitnessTool } from '@opensip-cli/fitness';
import { simulationTool } from '@opensip-cli/simulation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectLanguages,
  parseLanguageFlag,
  type SupportedLanguage,
} from '../commands/init/language-detection.js';
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
function makeArgs(
  overrides: Partial<InitOptions> = {},
): InitOptions & { toolScaffolds: ToolScaffold[] } {
  return {
    json: false,
    cwd: testDir,
    debug: false,
    toolScaffolds: firstPartyScaffolds(),
    ...overrides,
  };
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
  it('scaffolds the project layout for a Rust project', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');

    const result = executeInit(makeArgs());

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
    expect(check).toContain("scope: { languages: ['rust']");

    // .gitignore was created/appended
    expect(result.gitignoreUpdated).toBe(true);
    const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('opensip-cli/.runtime/');
  });

  it('scaffolds for TypeScript when --language is explicit', () => {
    const result = executeInit(makeArgs({ language: ['typescript'] }));
    expect(result.languages).toEqual(['typescript']);
    const config = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(config).toContain('typescript-source:');
  });
});

describe('executeInit (polyglot)', () => {
  it('scaffolds one example check per language with distinct slugs', () => {
    const result = executeInit(makeArgs({ language: ['rust', 'typescript'] }));
    expect(result.languages).toEqual(['rust', 'typescript']);

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
  it('refuses to scaffold when multiple language markers present and no --language', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');

    const result = executeInit(makeArgs());

    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError).toBeDefined();
    expect(result.ambiguousLanguageError?.detected.sort()).toEqual(['rust', 'typescript']);
    expect(result.ambiguousLanguageError?.message).toContain('--language');

    // Nothing was written
    expect(existsSync(join(testDir, 'opensip-cli.config.yml'))).toBe(false);
    expect(existsSync(join(testDir, 'opensip-cli'))).toBe(false);
  });

  it('refuses to scaffold when no language markers present and no --language', () => {
    const result = executeInit(makeArgs());

    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError).toBeDefined();
    expect(result.ambiguousLanguageError?.detected).toEqual([]);
  });

  it('returns an error result when --language is unknown', () => {
    const result = executeInit(makeArgs({ language: ['cobol'] }));
    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError?.message).toContain("Unknown language 'cobol'");
  });

  // Regression for the 2026-05-25 audit fix: previously a non-existent
  // --cwd returned `{ created: false, state: 'pristine' }` with no error
  // discriminant, so register-init mapped it to exit 0. The fix surfaces
  // it as ambiguousLanguageError so the existing exit-2 path fires.
  it('surfaces a structured error when --cwd does not exist on disk', () => {
    const missing = join(testDir, 'definitely-does-not-exist');
    const result = executeInit(makeArgs({ cwd: missing }));
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

  it('refuses to overwrite without a flag', () => {
    executeInit(makeArgs());
    const before = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');

    const second = executeInit(makeArgs());
    expect(second.created).toBe(false);
    expect(second.state).toBe('fully-initialized');
    expect(second.partialStateError).toBeDefined();
    expect(second.partialStateError?.state).toBe('fully-initialized');

    const after = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(after).toBe(before);
  });

  it('--remove blows away opensip-cli/ and rewrites everything', () => {
    executeInit(makeArgs());
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), '# manually edited');
    // Custom file in the dir — should be removed by --remove.
    writeFileSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs'), '// custom');

    const result = executeInit(makeArgs({ remove: true }));
    expect(result.created).toBe(true);
    expect(result.state).toBe('fully-initialized');

    const config = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(config).toContain('rust-source:');
    expect(config).not.toContain('manually edited');
    // Custom file is gone.
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs'))).toBe(
      false,
    );
  });

  it('--keep overwrites scaffolded files but preserves custom ones', () => {
    executeInit(makeArgs());
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), '# manually edited');
    // A user-authored file that --keep must preserve.
    const customPath = join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs');
    writeFileSync(customPath, '// custom logic');
    // A scaffolded file the user has tweaked — counts as 'custom' under
    // hash-based detection because the bytes drifted, so --keep
    // preserves it. (The audit calls this out as the safer outcome.)
    const tweakedPath = join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs');
    writeFileSync(tweakedPath, '// I edited this');

    const result = executeInit(makeArgs({ keep: true }));
    expect(result.created).toBe(true);
    expect(result.state).toBe('fully-initialized');

    // Config rewritten (it's a function of language, not of user content).
    const config = readFileSync(join(testDir, 'opensip-cli.config.yml'), 'utf8');
    expect(config).not.toContain('manually edited');
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

  it('refuses by default with a partial-state error', () => {
    const result = executeInit(makeArgs());
    expect(result.created).toBe(false);
    expect(result.state).toBe('partial-config-only');
    expect(result.partialStateError?.state).toBe('partial-config-only');
    expect(result.partialStateError?.message).toContain('--keep');
    expect(result.partialStateError?.message).toContain('--remove');
  });

  it('--keep scaffolds the missing dir', () => {
    const result = executeInit(makeArgs({ keep: true }));
    expect(result.created).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
      true,
    );
  });

  it('--remove scaffolds (no dir to remove)', () => {
    const result = executeInit(makeArgs({ remove: true }));
    expect(result.created).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
      true,
    );
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

  it('refuses by default with a partial-state error listing the custom file', () => {
    const result = executeInit(makeArgs());
    expect(result.created).toBe(false);
    expect(result.state).toBe('partial-dir-only');
    expect(result.partialStateError?.state).toBe('partial-dir-only');
    const customFile = result.partialStateError?.preExistingFiles.find((f) =>
      f.path.endsWith('my-real-check.mjs'),
    );
    expect(customFile?.classification).toBe('custom');
  });

  it('--keep preserves the custom file and writes the YAML', () => {
    const result = executeInit(makeArgs({ keep: true }));
    expect(result.created).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli.config.yml'))).toBe(true);
    expect(
      readFileSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'my-real-check.mjs'), 'utf8'),
    ).toBe('// custom');
  });

  it('--remove blows away the dir and writes the YAML', () => {
    const result = executeInit(makeArgs({ remove: true }));
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
  it('classifies a stale-language scaffold and surfaces it under --keep', () => {
    // Initial polyglot scaffold.
    executeInit(makeArgs({ language: ['typescript', 'rust'] }));
    expect(
      existsSync(join(testDir, 'opensip-cli', 'fit', 'checks', 'example-check-rust.mjs')),
    ).toBe(true);

    // Re-init with only typescript + --keep. The rust example should be
    // tagged stale-scaffolded and preserved (we don't remove it; user
    // may have been working with it).
    const result = executeInit(makeArgs({ language: ['typescript'], keep: true }));
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

  it('rejects --keep --remove together', () => {
    const result = executeInit(makeArgs({ keep: true, remove: true }));
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

  it('creates .gitignore when absent', () => {
    expect(existsSync(join(testDir, '.gitignore'))).toBe(false);
    const result = executeInit(makeArgs());
    expect(result.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(testDir, '.gitignore'), 'utf8')).toContain('opensip-cli/.runtime/');
  });

  it('appends to an existing .gitignore', () => {
    writeFileSync(join(testDir, '.gitignore'), 'node_modules/\ntarget/\n');
    const result = executeInit(makeArgs());
    expect(result.gitignoreUpdated).toBe(true);
    const content = readFileSync(join(testDir, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('target/');
    expect(content).toContain('opensip-cli/.runtime/');
  });

  it('does NOT duplicate the line on re-init with --remove', () => {
    executeInit(makeArgs());
    const first = readFileSync(join(testDir, '.gitignore'), 'utf8');

    const result = executeInit(makeArgs({ remove: true }));
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

  it('creates AGENTS.md on pristine init', () => {
    const result = executeInit(makeArgs());
    expect(result.agentsMdCreated).toBe(true);
    expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('Agent Playbook');
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toContain('agent-fast');
  });

  it('does not overwrite an existing AGENTS.md', () => {
    writeFileSync(join(testDir, 'AGENTS.md'), '# Custom playbook\n', 'utf8');
    const result = executeInit(makeArgs());
    expect(result.agentsMdCreated).toBe(false);
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toBe('# Custom playbook\n');
  });

  it('preserves AGENTS.md on re-init with --keep', () => {
    executeInit(makeArgs());
    const first = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    const result = executeInit(makeArgs({ keep: true }));
    expect(result.agentsMdCreated).toBe(false);
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toBe(first);
  });
});

// =============================================================================
// SupportedLanguage type spot-check
// =============================================================================

describe('SupportedLanguage', () => {
  it('exhausts the known set', () => {
    const all: SupportedLanguage[] = ['typescript', 'rust', 'python', 'go', 'java', 'cpp'];
    for (const lang of all) {
      const result = executeInit(makeArgs({ language: [lang] }));
      expect(result.languages).toEqual([lang]);
      // Cleanup so each language gets a fresh testDir state
      rmSync(join(testDir, 'opensip-cli.config.yml'), { force: true });
      rmSync(join(testDir, 'opensip-cli'), { recursive: true, force: true });
      rmSync(join(testDir, '.gitignore'), { force: true });
    }
  });
});
