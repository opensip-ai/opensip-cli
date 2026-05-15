/**
 * @fileoverview init command — language detection, scaffolding,
 * gitignore append, ambiguous-language prompt.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectLanguages,
  executeInit,
  parseLanguageFlag,
  type SupportedLanguage,
} from '../commands/init.js';

import type { CliArgs } from '@opensip-tools/cli-shared';

let testDir: string;

beforeEach(() => {
   
  testDir = mkdtempSync(join(tmpdir(), 'opensip-init-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeArgs(overrides: Partial<CliArgs & { language?: string; force?: boolean }> = {}): CliArgs & { language?: string; force?: boolean } {
  return {
    command: 'init',
    json: false,
    cwd: testDir,
    help: false,
    list: false,
    listRecipes: false,
    verbose: false,
    exclude: [],
    findings: false,
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
  it('scaffolds the v3 layout for a Rust project', () => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');

    const result = executeInit(makeArgs());

    expect(result.created).toBe(true);
    expect(result.languages).toEqual(['rust']);
    expect(result.createdFiles).toBeDefined();

    // Config + 4 example files
    expect(existsSync(join(testDir, 'opensip-tools.config.yml'))).toBe(true);
    expect(existsSync(join(testDir, 'opensip-tools', 'fit', 'checks', 'example-check.mjs'))).toBe(true);
    expect(existsSync(join(testDir, 'opensip-tools', 'fit', 'recipes', 'example-recipe.mjs'))).toBe(true);
    expect(existsSync(join(testDir, 'opensip-tools', 'sim', 'scenarios', 'example-scenario.mjs'))).toBe(true);
    expect(existsSync(join(testDir, 'opensip-tools', 'sim', 'recipes', 'example-recipe.mjs'))).toBe(true);

    // Config has the right target shape
    const config = readFileSync(join(testDir, 'opensip-tools.config.yml'), 'utf8');
    expect(config).toContain('rust-source:');
    expect(config).toContain('languages: [rust]');
    expect(config).toContain('"src/**/*.rs"');

    // Example check has matching scope.languages
    const check = readFileSync(join(testDir, 'opensip-tools', 'fit', 'checks', 'example-check.mjs'), 'utf8');
    expect(check).toContain("scope: { languages: ['rust']");

    // .gitignore was created/appended
    expect(result.gitignoreUpdated).toBe(true);
    const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('opensip-tools/.runtime/');
  });

  it('scaffolds for TypeScript when --language is explicit', () => {
    const result = executeInit(makeArgs({ language: 'typescript' }));
    expect(result.languages).toEqual(['typescript']);
    const config = readFileSync(join(testDir, 'opensip-tools.config.yml'), 'utf8');
    expect(config).toContain('typescript-source:');
  });
});

describe('executeInit (polyglot)', () => {
  it('scaffolds one example check per language with distinct slugs', () => {
    const result = executeInit(makeArgs({ language: 'rust,typescript' }));
    expect(result.languages).toEqual(['rust', 'typescript']);

    expect(existsSync(join(testDir, 'opensip-tools', 'fit', 'checks', 'example-check-rust.mjs'))).toBe(true);
    expect(existsSync(join(testDir, 'opensip-tools', 'fit', 'checks', 'example-check-typescript.mjs'))).toBe(true);

    // Recipe references both
    const recipe = readFileSync(join(testDir, 'opensip-tools', 'fit', 'recipes', 'example-recipe.mjs'), 'utf8');
    expect(recipe).toContain("'example-check-rust'");
    expect(recipe).toContain("'example-check-typescript'");

    // Config has a target per language
    const config = readFileSync(join(testDir, 'opensip-tools.config.yml'), 'utf8');
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
    expect(existsSync(join(testDir, 'opensip-tools.config.yml'))).toBe(false);
    expect(existsSync(join(testDir, 'opensip-tools'))).toBe(false);
  });

  it('refuses to scaffold when no language markers present and no --language', () => {
    const result = executeInit(makeArgs());

    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError).toBeDefined();
    expect(result.ambiguousLanguageError?.detected).toEqual([]);
  });

  it('returns an error result when --language is unknown', () => {
    const result = executeInit(makeArgs({ language: 'cobol' }));
    expect(result.created).toBe(false);
    expect(result.ambiguousLanguageError?.message).toContain("Unknown language 'cobol'");
  });
});

describe('executeInit (alreadyExists)', () => {
  beforeEach(() => {
    writeFileSync(join(testDir, 'Cargo.toml'), '[package]\nname = "x"');
  });

  it('refuses to overwrite without --force', () => {
    executeInit(makeArgs());
    const before = readFileSync(join(testDir, 'opensip-tools.config.yml'), 'utf8');

    const second = executeInit(makeArgs());
    expect(second.created).toBe(false);
    expect(second.alreadyExists).toBe(true);

    const after = readFileSync(join(testDir, 'opensip-tools.config.yml'), 'utf8');
    expect(after).toBe(before);
  });

  it('overwrites when --force is passed', () => {
    executeInit(makeArgs());
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), '# manually edited');

    const result = executeInit(makeArgs({ force: true }));
    expect(result.created).toBe(true);

    const config = readFileSync(join(testDir, 'opensip-tools.config.yml'), 'utf8');
    expect(config).toContain('rust-source:');
    expect(config).not.toContain('manually edited');
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
    expect(readFileSync(join(testDir, '.gitignore'), 'utf8')).toContain('opensip-tools/.runtime/');
  });

  it('appends to an existing .gitignore', () => {
    writeFileSync(join(testDir, '.gitignore'), 'node_modules/\ntarget/\n');
    const result = executeInit(makeArgs());
    expect(result.gitignoreUpdated).toBe(true);
    const content = readFileSync(join(testDir, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('target/');
    expect(content).toContain('opensip-tools/.runtime/');
  });

  it('does NOT duplicate the line on re-init with --force', () => {
    executeInit(makeArgs());
    const first = readFileSync(join(testDir, '.gitignore'), 'utf8');

    const result = executeInit(makeArgs({ force: true }));
    expect(result.gitignoreUpdated).toBe(false);

    const second = readFileSync(join(testDir, '.gitignore'), 'utf8');
    expect(second).toBe(first);
  });
});

// =============================================================================
// SupportedLanguage type spot-check
// =============================================================================

describe('SupportedLanguage', () => {
  it('exhausts the known set', () => {
    const all: SupportedLanguage[] = ['typescript', 'rust', 'python', 'go', 'java', 'cpp'];
    for (const lang of all) {
      const result = executeInit(makeArgs({ language: lang }));
      expect(result.languages).toEqual([lang]);
      // Cleanup so each language gets a fresh testDir state
      rmSync(join(testDir, 'opensip-tools.config.yml'), { force: true });
      rmSync(join(testDir, 'opensip-tools'), { recursive: true, force: true });
      rmSync(join(testDir, '.gitignore'), { force: true });
    }
  });
});
