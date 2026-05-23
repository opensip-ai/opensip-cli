/**
 * @fileoverview Tests for `readYamlFile` — the permissive helper used
 * by plugin-discovery sites.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { readYamlFile } from '../yaml.js';

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
});
