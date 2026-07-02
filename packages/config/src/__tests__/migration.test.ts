import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const result = migrateConfigText({ text: 'schemaVersion: "1"\ntargets: {}\n' });
    expect(result.changed).toBe(true);
    expect(result.operations[0]?.kind).toBe('normalize-schema-version');
    expect(result.migratedText).toContain('schemaVersion: 1');
  });

  it('refuses configs newer than this CLI can migrate', () => {
    expect(() => migrateConfigText({ text: 'schemaVersion: 99\ntargets: {}\n' })).toThrow(
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
});
