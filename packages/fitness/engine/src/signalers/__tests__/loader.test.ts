import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError, SystemError } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSignalersConfig } from '../loader.js';

let testDir: string;

beforeEach(() => {
   
  testDir = mkdtempSync(join(tmpdir(), 'opensip-signalers-loader-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('loadSignalersConfig', () => {
  it('loads a minimal valid config', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'targets: {}\n',
    );
    const cfg = loadSignalersConfig(testDir);
    expect(cfg.targets).toEqual({});
    expect(cfg.fitness.failOnErrors).toBe(1);
    expect(cfg.fitness.failOnWarnings).toBe(0);
  });

  it('parses targets with description, include, exclude', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: TS source
    include:
      - "src/**/*.ts"
    exclude:
      - "**/*.test.ts"
    languages: [typescript]
    concerns: [backend]
`,
    );
    const cfg = loadSignalersConfig(testDir);
    expect(cfg.targets.src?.description).toBe('TS source');
    expect(cfg.targets.src?.include).toEqual(['src/**/*.ts']);
  });

  it('caches by resolved file path within the TTL', () => {
    const path = join(testDir, 'opensip-tools.config.yml');
    writeFileSync(path, 'targets: {}\n');
    const a = loadSignalersConfig(testDir);
    // Re-write the file content; cached load should not re-read.
    writeFileSync(path, 'targets: {alt: {description: x, include: ["y"]}}\n');
    const b = loadSignalersConfig(testDir);
    expect(b).toBe(a); // same frozen reference
  });

  it('throws ValidationError when target name violates kebab-case', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  Invalid_Name:
    description: x
    include: ["y"]
`,
    );
    expect(() => loadSignalersConfig(testDir)).toThrow(ValidationError);
  });

  it('throws ValidationError when YAML is malformed', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'targets: [unbalanced\n');
    expect(() => loadSignalersConfig(testDir)).toThrow(ValidationError);
  });

  it('throws SystemError when the file is too large', () => {
    const huge = 'x'.repeat(11 * 1024 * 1024); // 11 MB > 10 MB limit
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), huge);
    expect(() => loadSignalersConfig(testDir)).toThrow(SystemError);
  });

  it('respects an explicit --config path', () => {
    writeFileSync(
      join(testDir, 'custom.yml'),
      'targets: {}\n',
    );
    const cfg = loadSignalersConfig(testDir, join(testDir, 'custom.yml'));
    expect(cfg.targets).toEqual({});
  });

  it('treats null YAML as an empty object', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), '');
    const cfg = loadSignalersConfig(testDir);
    expect(cfg.targets).toEqual({});
  });
});
