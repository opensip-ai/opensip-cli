import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError, SystemError } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadTargetsConfig } from '../loader.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-targets-loader-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('loadTargetsConfig', () => {
  it('loads a minimal targets config', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: Source
    include:
      - "src/**/*.ts"
`,
    );
    const { registry, config } = loadTargetsConfig(testDir);
    expect(registry.has('src')).toBe(true);
    expect(config.globalExcludes).toEqual([]);
  });

  it('applies default exclude patterns when none provided', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: Source
    include: ["src/**"]
`,
    );
    const { registry } = loadTargetsConfig(testDir);
    const target = registry.getAll().find((t) => t.config.name === 'src');
    expect(target?.config.exclude).toContain('**/node_modules/**');
  });

  it('preserves custom exclude patterns when provided', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: Source
    include: ["src/**"]
    exclude:
      - "src/legacy/**"
`,
    );
    const { registry } = loadTargetsConfig(testDir);
    const target = registry.getAll().find((t) => t.config.name === 'src');
    expect(target?.config.exclude).toEqual(['src/legacy/**']);
  });

  it('parses globalExcludes', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `globalExcludes:
  - "**/docs/**"
targets:
  src:
    description: x
    include: ["src/**"]
`,
    );
    const { config } = loadTargetsConfig(testDir);
    expect(config.globalExcludes).toEqual(['**/docs/**']);
  });

  it('parses checkOverrides as string and as array', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    include: ["src/**"]
  tests:
    description: y
    include: ["test/**"]
checkOverrides:
  no-console-log: src
  multi-target: [src, tests]
`,
    );
    const { config } = loadTargetsConfig(testDir);
    expect(config.checkOverrides['no-console-log']).toBe('src');
    expect(config.checkOverrides['multi-target']).toEqual(['src', 'tests']);
  });

  it('throws when checkOverrides references an unknown target', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    include: ["src/**"]
checkOverrides:
  some-check: nonexistent
`,
    );
    expect(() => loadTargetsConfig(testDir)).toThrow(/unknown target/);
  });

  it('parses plugins block with current keys', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    include: ["src/**"]
plugins:
  fit: ["@a/b"]
  sim: ["@c/d"]
  checkPackages: ["@e/f"]
  scenarioPackages: ["@g/h"]
  autoDiscoverScenarios: false
  packageScopes: ["@acme"]
  graphAdapters: ["@i/j"]
  autoDiscoverGraphAdapters: false
`,
    );
    const { config } = loadTargetsConfig(testDir);
    expect(config.plugins?.fit).toEqual(['@a/b']);
    expect(config.plugins?.sim).toEqual(['@c/d']);
    expect(config.plugins?.checkPackages).toEqual(['@e/f']);
    expect(config.plugins?.scenarioPackages).toEqual(['@g/h']);
    expect(config.plugins?.autoDiscoverScenarios).toBe(false);
    expect(config.plugins?.packageScopes).toEqual(['@acme']);
    expect(config.plugins?.graphAdapters).toEqual(['@i/j']);
    expect(config.plugins?.autoDiscoverGraphAdapters).toBe(false);
  });

  it.each([
    ['unknown key', 'scenarioPackagez: ["@g/h"]'],
    ['wrong explicit-list type', 'graphAdapters: "@i/j"'],
  ])('throws ValidationError on malformed plugins config: %s', (_label, pluginsBody) => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    include: ["src/**"]
plugins:
  ${pluginsBody}
`,
    );
    expect(() => loadTargetsConfig(testDir)).toThrow(ValidationError);
  });

  it('throws ValidationError when target name is not kebab-case', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  Bad_Name:
    description: x
    include: ["y"]
`,
    );
    expect(() => loadTargetsConfig(testDir)).toThrow(ValidationError);
  });

  it('throws when the config file is missing', () => {
    expect(() => loadTargetsConfig(testDir)).toThrow();
  });

  it('throws ValidationError when YAML is malformed', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'targets: [unbalanced\n');
    expect(() => loadTargetsConfig(testDir)).toThrow(ValidationError);
  });

  it('respects an explicit --config path', () => {
    writeFileSync(
      join(testDir, 'custom.yml'),
      `targets:
  custom:
    description: x
    include: ["x"]
`,
    );
    const { registry } = loadTargetsConfig(testDir, join(testDir, 'custom.yml'));
    expect(registry.has('custom')).toBe(true);
  });

  it('throws SystemError when config file exceeds the size limit', () => {
    const huge = 'x'.repeat(11 * 1024 * 1024); // 11 MB > 10 MB limit
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), huge);
    expect(() => loadTargetsConfig(testDir)).toThrow(SystemError);
  });

  it('throws ValidationError when the resolved path is a directory (readFileSync EISDIR)', () => {
    mkdirSync(join(testDir, 'opensip-tools.config.yml'), { recursive: true });
    expect(() => loadTargetsConfig(testDir)).toThrow(ValidationError);
  });
});
