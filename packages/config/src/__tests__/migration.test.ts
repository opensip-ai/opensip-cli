import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { migrateConfigFile, migrateConfigText } from '../migration.js';

let tmp: string | undefined;

function makeTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'opensip-config-migration-'));
  return tmp;
}

afterEach(() => {
  if (tmp !== undefined) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('config migration', () => {
  it('keeps current schemaVersion configs byte-identical', () => {
    const text = 'schemaVersion: 1\nfitness:\n  failOnErrors: 1\n';
    const result = migrateConfigText({ text });
    expect(result.changed).toBe(false);
    expect(result.operations).toEqual([]);
    expect(result.migratedText).toBe(text);
  });

  it('adds schemaVersion to legacy configs that omitted it', () => {
    const result = migrateConfigText({
      text: '# custom comment\nfitness:\n  failOnErrors: 1\n',
      configPath: '/repo/opensip-cli.config.yml',
    });
    expect(result.changed).toBe(true);
    expect(result.fromVersion).toBe(1);
    expect(result.operations).toEqual([
      {
        kind: 'add-schema-version',
        toVersion: 1,
        message: 'Added schemaVersion: 1.',
      },
    ]);
    expect(result.migratedText).toContain('# custom comment');
    expect(result.migratedText).toContain('schemaVersion: 1');
    expect(result.migratedText).toContain('fitness:');
  });

  it('normalizes invalid schemaVersion scalars to the supported number', () => {
    const result = migrateConfigText({ text: 'schemaVersion: latest\ntargets: {}\n' });
    expect(result.changed).toBe(true);
    expect(result.operations[0]?.kind).toBe('normalize-schema-version');
    expect(result.migratedText).toContain('schemaVersion: 1');
  });

  it('treats a quoted numeric schemaVersion as the version it declares', () => {
    // "1" is already the supported version — nothing to migrate.
    const current = migrateConfigText({ text: 'schemaVersion: "1"\ntargets: {}\n' });
    expect(current.changed).toBe(false);
  });

  it('refuses configs newer than this CLI can migrate', () => {
    expect(() => migrateConfigText({ text: 'schemaVersion: 99\ntargets: {}\n' })).toThrow(
      ConfigurationError,
    );
    // A QUOTED newer version must refuse too — not silently downgrade to 1.
    expect(() => migrateConfigText({ text: 'schemaVersion: "999"\ntargets: {}\n' })).toThrow(
      ConfigurationError,
    );
  });

  it('reports dry-run file migrations without writing', () => {
    const dir = makeTmpDir();
    const configPath = join(dir, 'opensip-cli.config.yml');
    const original = 'targets: {}\n';
    writeFileSync(configPath, original, 'utf8');

    const result = migrateConfigFile({ configPath, dryRun: true });

    expect(result.changed).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.wrote).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('writes changed file migrations when dry-run is disabled', () => {
    const dir = makeTmpDir();
    const configPath = join(dir, 'opensip-cli.config.yml');
    writeFileSync(configPath, 'targets: {}\n', 'utf8');

    const result = migrateConfigFile({ configPath });

    expect(result.changed).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.wrote).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('schemaVersion: 1');
  });

  it('refuses missing and oversized config files', () => {
    const dir = makeTmpDir();
    const missingPath = join(dir, 'missing.yml');
    expect(existsSync(missingPath)).toBe(false);
    expect(() => migrateConfigFile({ configPath: missingPath })).toThrow(ConfigurationError);

    const configPath = join(dir, 'opensip-cli.config.yml');
    writeFileSync(configPath, 'schemaVersion: 1\n', 'utf8');
    expect(() => migrateConfigFile({ configPath, maxBytes: 1 })).toThrow(ConfigurationError);
  });

  it('rejects directories and other non-files after existsSync', () => {
    const dir = makeTmpDir();
    const asDir = join(dir, 'opensip-cli.config.yml');
    mkdirSync(asDir);
    expect(() => migrateConfigFile({ configPath: asDir })).toThrow(
      expect.objectContaining({
        name: 'ConfigurationError',
        code: 'CONFIG.MIGRATION.UNREADABLE',
      }),
    );
  });

  it('rejects invalid migration text targets and non-map YAML documents', () => {
    expect(() => migrateConfigText({ text: 'targets: {}\n', targetVersion: 0 })).toThrow(
      ConfigurationError,
    );
    expect(() => migrateConfigText({ text: '- nope\n' })).toThrow(ConfigurationError);
  });
});
