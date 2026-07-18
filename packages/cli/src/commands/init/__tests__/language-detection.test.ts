/**
 * Unit coverage for Init language detection and resolution.
 * Polyglot marker sets are accepted; only missing/invalid input fails.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALL_LANGUAGES,
  canonicalizeLanguages,
  detectLanguages,
  parseLanguageFlag,
  resolveLanguages,
  type SupportedLanguage,
} from '../language-detection.js';

describe('canonicalizeLanguages', () => {
  it('reorders into ALL_LANGUAGES order and dedupes', () => {
    expect(canonicalizeLanguages(['python', 'typescript', 'python', 'go'])).toEqual([
      'typescript',
      'python',
      'go',
    ]);
    expect(canonicalizeLanguages([...ALL_LANGUAGES].reverse())).toEqual([...ALL_LANGUAGES]);
  });
});

describe('detectLanguages', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lang-detect-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const singleCases: readonly { readonly file: string; readonly language: SupportedLanguage }[] = [
    { file: 'tsconfig.json', language: 'typescript' },
    { file: 'Cargo.toml', language: 'rust' },
    { file: 'pyproject.toml', language: 'python' },
    { file: 'go.mod', language: 'go' },
    { file: 'pom.xml', language: 'java' },
    { file: 'CMakeLists.txt', language: 'cpp' },
  ];

  for (const { file, language } of singleCases) {
    it(`detects ${language} via ${file}`, () => {
      writeFileSync(join(dir, file), language === 'go' ? 'module x\n' : '', 'utf8');
      expect(detectLanguages(dir)).toEqual([language]);
    });
  }

  it('detects polyglot projects without collapsing to one language', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
    writeFileSync(join(dir, 'pyproject.toml'), '', 'utf8');
    expect(new Set(detectLanguages(dir))).toEqual(new Set(['typescript', 'rust', 'python']));
  });

  it('does not treat package.json as TypeScript when another marker is present', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
    writeFileSync(join(dir, 'package.json'), '{}', 'utf8');
    expect(detectLanguages(dir)).toEqual(['rust']);
  });

  it('returns empty when no markers are present', () => {
    expect(detectLanguages(dir)).toEqual([]);
  });
});

describe('parseLanguageFlag', () => {
  it('normalizes repeated and comma-separated values into canonical order', () => {
    expect(parseLanguageFlag('go,typescript,go')).toEqual(['typescript', 'go']);
    expect(parseLanguageFlag(' Python , RUST ')).toEqual(['rust', 'python']);
  });

  it('rejects unknown tokens and empty lists', () => {
    expect(() => parseLanguageFlag('cobol')).toThrow(/Unknown language 'cobol'/);
    expect(() => parseLanguageFlag(',,,')).toThrow(/empty list/);
    expect(() => parseLanguageFlag('')).toThrow(/empty list/);
  });
});

describe('resolveLanguages', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lang-resolve-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a single detected language', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\n', 'utf8');
    expect(resolveLanguages(dir, undefined)).toEqual({ ok: true, languages: ['go'] });
  });

  it('accepts polyglot detection in ALL_LANGUAGES order', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
    writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'go.mod'), 'module x\n', 'utf8');
    expect(resolveLanguages(dir, undefined)).toEqual({
      ok: true,
      languages: ['typescript', 'rust', 'go'],
    });
  });

  it('honours explicit flags over detection, with canonical order', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
    expect(resolveLanguages(dir, ['python', 'typescript'])).toEqual({
      ok: true,
      languages: ['typescript', 'python'],
    });
    expect(resolveLanguages(dir, ['python,go', 'typescript'])).toEqual({
      ok: true,
      languages: ['typescript', 'python', 'go'],
    });
  });

  it('fails when no markers and no flag', () => {
    const result = resolveLanguages(dir, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detected).toEqual([]);
      expect(result.error.message).toMatch(/No language markers/);
    }
  });

  it('fails on unknown explicit language', () => {
    const result = resolveLanguages(dir, ['cobol']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Unknown language 'cobol'/);
    }
  });
});
