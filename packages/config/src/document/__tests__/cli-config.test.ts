import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadCliDefaults } from '../cli-config.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-cli-config-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeConfig(yaml: string): string {
  const filePath = join(testDir, 'opensip-cli.config.yml');
  writeFileSync(filePath, yaml);
  return filePath;
}

describe('loadCliDefaults', () => {
  it('returns {} when there is no config file', () => {
    const empty = mkdtempSync(join(tmpdir(), 'opensip-empty-'));
    try {
      expect(loadCliDefaults(empty)).toEqual({});
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns {} when the cli: section is missing', () => {
    writeConfig('targets: []\n');
    expect(loadCliDefaults(testDir)).toEqual({});
  });

  it('returns {} when the cli: section is not an object', () => {
    writeConfig('cli: "not an object"\n');
    expect(loadCliDefaults(testDir)).toEqual({});
  });

  it('returns {} when the YAML document is not a plain object', () => {
    writeConfig('- foo\n- bar\n');
    expect(loadCliDefaults(testDir)).toEqual({});
  });

  it('parses scalar string and boolean fields', () => {
    const reportPath = join(testDir, 'report.json');
    writeConfig(`cli:
  verbose: true
  json: false
  reportTo: ${reportPath}
  apiKey: sk-test
  debug: true
`);
    expect(loadCliDefaults(testDir)).toEqual({
      verbose: true,
      json: false,
      reportTo: reportPath,
      apiKey: 'sk-test',
      debug: true,
    });
  });

  it('parses string-array fields', () => {
    writeConfig(`cli:
  exclude:
    - dist/**
    - "**/*.min.js"
  fileTypes:
    - ts
    - tsx
  ignore:
    - node_modules
`);
    expect(loadCliDefaults(testDir)).toEqual({
      exclude: ['dist/**', '**/*.min.js'],
      fileTypes: ['ts', 'tsx'],
      ignore: ['node_modules'],
    });
  });

  it('drops fields with the wrong type', () => {
    writeConfig(`cli:
  verbose: "yes"
  exclude: not-an-array
  fileTypes:
    - ts
    - 7
`);
    const out = loadCliDefaults(testDir);
    expect(out.verbose).toBeUndefined();
    expect(out.exclude).toBeUndefined();
    // fileTypes is dropped because one element is not a string.
    expect(out.fileTypes).toBeUndefined();
  });

  it('respects an explicit config path', () => {
    const customDir = mkdtempSync(join(tmpdir(), 'opensip-custom-'));
    try {
      const customPath = join(customDir, 'custom.yml');
      writeFileSync(customPath, 'cli:\n  verbose: true\n');
      const out = loadCliDefaults(testDir, customPath);
      expect(out.verbose).toBe(true);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it('returns {} when the explicit path does not exist', () => {
    const bogus = join(testDir, 'nope.yml');
    expect(loadCliDefaults(testDir, bogus)).toEqual({});
  });

  it('returns {} when the file contains invalid YAML', () => {
    const filePath = writeConfig(': not\n  valid: : :\n');
    // Force malformed: write tab-only content yaml parser will refuse
    writeFileSync(filePath, '\t- not yaml\n\t bad: :');
    const out = loadCliDefaults(testDir);
    expect(out).toEqual({});
  });

  it('reads a valid ui.banner value', () => {
    writeConfig('cli:\n  ui:\n    banner: mini\n');
    expect(loadCliDefaults(testDir).ui?.banner).toBe('mini');
  });

  it('drops an unknown ui.banner value', () => {
    writeConfig('cli:\n  ui:\n    banner: enormous\n');
    expect(loadCliDefaults(testDir).ui).toBeUndefined();
  });

  it('ignores a non-object ui block', () => {
    writeConfig('cli:\n  ui: "nope"\n');
    expect(loadCliDefaults(testDir).ui).toBeUndefined();
  });

  it('reads the cloud.sync flag and endpoint override', () => {
    writeConfig('cli:\n  cloud:\n    sync: false\n    endpoint: https://cloud.test/api\n');
    expect(loadCliDefaults(testDir).cloud).toEqual({
      sync: false,
      endpoint: 'https://cloud.test/api',
    });
  });

  it('drops a cloud block with no recognized keys', () => {
    writeConfig('cli:\n  cloud:\n    bogus: 1\n');
    expect(loadCliDefaults(testDir).cloud).toBeUndefined();
  });

  it('ignores a non-object cloud block', () => {
    writeConfig('cli:\n  cloud: "nope"\n');
    expect(loadCliDefaults(testDir).cloud).toBeUndefined();
  });
});
