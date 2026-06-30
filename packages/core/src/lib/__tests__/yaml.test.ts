/**
 * @fileoverview Tests for `readYamlFile` — the permissive helper used
 * by plugin-discovery sites.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { SystemError, ValidationError } from '../errors.js';
import { readYamlFile, readYamlFileOrThrow } from '../yaml.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-yaml-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('readYamlFile', () => {
  it('returns undefined when the file does not exist', () => {
    expect(readYamlFile(join(testDir, 'missing.yml'))).toBeUndefined();
  });

  it('returns undefined for malformed YAML', () => {
    const path = join(testDir, 'bad.yml');
    writeFileSync(path, 'a: [unterminated');
    expect(readYamlFile(path)).toBeUndefined();
  });

  it('returns the parsed document for valid YAML', () => {
    const path = join(testDir, 'good.yml');
    writeFileSync(path, 'plugins:\n  fit:\n    - one\n    - two\n');
    expect(readYamlFile(path)).toEqual({ plugins: { fit: ['one', 'two'] } });
  });

  it('returns null when the document is an empty YAML', () => {
    const path = join(testDir, 'empty.yml');
    writeFileSync(path, '');
    // js-yaml returns undefined for completely empty input
    expect(readYamlFile(path)).toBeUndefined();
  });

  it('returns undefined for a comment-only YAML document', () => {
    const path = join(testDir, 'comment-only.yml');
    writeFileSync(path, '# project marker\n');
    expect(readYamlFile(path)).toBeUndefined();
  });
});

describe('readYamlFileOrThrow (audit-round-2 Finding F)', () => {
  it('returns the parsed document for valid YAML', () => {
    const path = join(testDir, 'good.yml');
    writeFileSync(path, 'fitness:\n  failOnErrors: 1\n');
    expect(readYamlFileOrThrow(path)).toEqual({ fitness: { failOnErrors: 1 } });
  });

  it('returns {} for empty YAML rather than undefined', () => {
    const path = join(testDir, 'empty.yml');
    writeFileSync(path, '');
    expect(readYamlFileOrThrow(path)).toEqual({});
  });

  it('returns {} for comment-only YAML rather than throwing', () => {
    const path = join(testDir, 'comment-only.yml');
    writeFileSync(path, '---\n# project marker\n');
    expect(readYamlFileOrThrow(path)).toEqual({});
  });

  it('throws ValidationError for a missing file with loader attribution', () => {
    const path = join(testDir, 'missing.yml');
    expect(() => readYamlFileOrThrow(path, { loader: 'signalers' })).toThrow(ValidationError);
  });

  it('throws ValidationError for malformed YAML', () => {
    const path = join(testDir, 'bad.yml');
    writeFileSync(path, 'a: [unterminated');
    try {
      readYamlFileOrThrow(path, { loader: 'signalers' });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain('invalid YAML');
    }
  });

  it('throws SystemError when the file exceeds maxBytes', () => {
    const path = join(testDir, 'big.yml');
    writeFileSync(path, 'x: '.repeat(2000));
    try {
      readYamlFileOrThrow(path, { maxBytes: 64, loader: 'signalers' });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SystemError);
      expect((error as SystemError).code).toBe('SYSTEM.FILE.TOO_LARGE');
    }
  });
});
