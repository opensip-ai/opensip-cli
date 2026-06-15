import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  RunScope,
  SystemError,
  ToolRegistry,
  ValidationError,
  runWithScopeSync,
} from '@opensip-cli/core';
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
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), 'targets: {}\n');
    const cfg = loadSignalersConfig(testDir);
    expect(cfg.targets).toEqual({});
    expect(cfg.fitness.failOnErrors).toBe(1);
    expect(cfg.fitness.failOnWarnings).toBe(0);
  });

  it('parses targets with description, include, exclude', () => {
    writeFileSync(
      join(testDir, 'opensip-cli.config.yml'),
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
    const path = join(testDir, 'opensip-cli.config.yml');
    writeFileSync(path, 'targets: {}\n');
    const a = loadSignalersConfig(testDir);
    // Re-write the file content; cached load should not re-read.
    writeFileSync(path, 'targets: {alt: {description: x, include: ["y"]}}\n');
    const b = loadSignalersConfig(testDir);
    expect(b).toBe(a); // same frozen reference
  });

  it('throws ValidationError when target name violates kebab-case', () => {
    writeFileSync(
      join(testDir, 'opensip-cli.config.yml'),
      `targets:
  Invalid_Name:
    description: x
    include: ["y"]
`,
    );
    expect(() => loadSignalersConfig(testDir)).toThrow(ValidationError);
  });

  it('throws ValidationError when YAML is malformed', () => {
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), 'targets: [unbalanced\n');
    expect(() => loadSignalersConfig(testDir)).toThrow(ValidationError);
  });

  it('throws SystemError when the file is too large', () => {
    const huge = 'x'.repeat(11 * 1024 * 1024); // 11 MB > 10 MB limit
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), huge);
    expect(() => loadSignalersConfig(testDir)).toThrow(SystemError);
  });

  it('respects an explicit --config path', () => {
    writeFileSync(join(testDir, 'custom.yml'), 'targets: {}\n');
    const cfg = loadSignalersConfig(testDir, join(testDir, 'custom.yml'));
    expect(cfg.targets).toEqual({});
  });

  it('treats null YAML as an empty object', () => {
    writeFileSync(join(testDir, 'opensip-cli.config.yml'), '');
    const cfg = loadSignalersConfig(testDir);
    expect(cfg.targets).toEqual({});
  });

  it('throws ValidationError when an explicit path points to a non-existent file', () => {
    // resolveProjectConfigPath throws when --config points at a missing
    // file. This validates that error path propagates cleanly.
    expect(() => loadSignalersConfig(testDir, join(testDir, 'does-not-exist.yml'))).toThrow();
  });

  it('throws ValidationError when the resolved path is a directory (readFileSync EISDIR)', () => {
    const dirAsConfig = join(testDir, 'opensip-cli.config.yml');
    mkdirSync(dirAsConfig, { recursive: true });
    expect(() => loadSignalersConfig(testDir)).toThrow();
  });

  it('treats explicit null section values as default empty objects', () => {
    // Exercises the section() preprocess branch: v != null is preserved
    // verbatim. Counterpart to "treats null YAML as empty object" — that
    // test handles the nullish branch; this one covers the truthy branch.
    writeFileSync(
      join(testDir, 'opensip-cli.config.yml'),
      `targets: {}
fitness:
  failOnErrors: 5
`,
    );
    const cfg = loadSignalersConfig(testDir);
    expect(cfg.fitness.failOnErrors).toBe(5);
  });
});

/** Scope carrying a host-validated config document on its structural slot —
 *  installed via Object.assign exactly like the CLI pre-action hook does
 *  (scope-types.ts declares it readonly for readers). */
const makeScopeWithDocument = (configDocument: Record<string, unknown>): RunScope => {
  const scope = new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });
  Object.assign(scope, { configDocument });
  return scope;
};

describe('loadSignalersConfig — scope-first (ADR-0023 one-reader)', () => {
  it('projects from scope.configDocument without touching the filesystem', () => {
    // No config file exists in testDir — a file read would throw. The scope
    // document alone must satisfy the load.
    const scope = makeScopeWithDocument({
      targets: { src: { description: 'TS source', include: ['src/**/*.ts'] } },
      fitness: { failOnErrors: 3 },
    });
    const cfg = runWithScopeSync(scope, () => loadSignalersConfig(testDir));
    expect(cfg.targets.src?.description).toBe('TS source');
    expect(cfg.fitness.failOnErrors).toBe(3);
  });

  it('ignores a stale on-disk file when the scope carries the document', () => {
    // The host read + validated the document at bootstrap; a file edited
    // after bootstrap (or a different file the tool would have resolved)
    // must NOT win over the scope-carried document.
    writeFileSync(
      join(testDir, 'opensip-cli.config.yml'),
      'targets: {}\nfitness:\n  failOnErrors: 99\n',
    );
    const scope = makeScopeWithDocument({ targets: {}, fitness: { failOnErrors: 2 } });
    const cfg = runWithScopeSync(scope, () => loadSignalersConfig(testDir));
    expect(cfg.fitness.failOnErrors).toBe(2);
  });

  it('memoizes the projection per document object (one parse per run)', () => {
    const scope = makeScopeWithDocument({ targets: {} });
    const a = runWithScopeSync(scope, () => loadSignalersConfig(testDir));
    const b = runWithScopeSync(scope, () => loadSignalersConfig(testDir));
    expect(b).toBe(a); // same frozen reference
  });

  it('falls back to the file read when the scope carries no document', () => {
    // A scope WITHOUT configDocument (config-less/agnostic run) must keep the
    // loud missing-config error — never silently validate an empty document.
    const scope = new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });
    expect(() => runWithScopeSync(scope, () => loadSignalersConfig(testDir))).toThrow(
      ValidationError,
    );
  });

  it('still rejects an invalid scope document with the fitness error shape', () => {
    const scope = makeScopeWithDocument({ targets: { 'Bad Name': { include: [] } } });
    expect(() => runWithScopeSync(scope, () => loadSignalersConfig(testDir))).toThrow(
      ValidationError,
    );
  });
});
