import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProjectConfigPath, PROJECT_CONFIG_FILENAME } from '../config-resolution.js';
import { ToolError } from '../lib/errors.js';
import { normalizeFailure } from '../lib/failure-envelope.js';
import { toPublicFailureProjection } from '../lib/failure-projection.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-config-resolve-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveProjectConfigPath', () => {
  it('returns the default path when opensip-cli.config.yml exists at root', () => {
    const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
    writeFileSync(defaultPath, 'targets: {}');
    expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
  });

  it('throws the registered not-found code when no config exists anywhere', () => {
    // WAS: code 'ERRORS.CONFIG.NOT_FOUND'. The head `ERRORS` is unmapped, so
    // definitionFromLegacyCode demoted the product's most common first-run failure to
    // CORE.SYSTEM.UNKNOWN_FAILURE — severity fatal, responsibility unknown.
    expect(() => resolveProjectConfigPath(testDir)).toThrow(ToolError);
    try {
      resolveProjectConfigPath(testDir);
      expect.unreachable('resolveProjectConfigPath must throw when no config exists');
    } catch (error) {
      expect((error as Error).message).toContain('No opensip-cli.config.yml found');
      expect((error as ToolError).code).toBe('CONFIGURATION.CONFIG.NOT_FOUND');
      expect((error as ToolError).definition.defaultResponsibility).toBe('user');
      expect((error as ToolError).definition.severity).toBe('error');
    }
  });

  it('keeps the enumerated search paths in the PUBLIC projection', () => {
    // This is the assertion that actually proves the fix. Under the old operator-only
    // exposure, outwardMessage replaced the entire attempt list with the fixed string
    // "An unexpected internal failure occurred." — so the user learned nothing about where
    // opensip had looked. A public definition is what keeps the list.
    let thrown: unknown;
    try {
      resolveProjectConfigPath(testDir);
    } catch (error) {
      thrown = error;
    }
    const projection = toPublicFailureProjection(normalizeFailure(thrown));
    expect(projection.message).toContain('No opensip-cli.config.yml found');
    expect(projection.message).toContain(PROJECT_CONFIG_FILENAME);
    expect(projection.message).not.toContain('An unexpected internal failure occurred');
    expect(projection.code).toBe('CONFIGURATION.CONFIG.NOT_FOUND');
  });

  describe('explicit --config path', () => {
    it('accepts an absolute explicit path', () => {
      const explicit = join(testDir, 'custom.yml');
      writeFileSync(explicit, 'targets: {}');
      expect(resolveProjectConfigPath(testDir, explicit)).toBe(explicit);
    });

    it('accepts a relative explicit path resolved against rootDir', () => {
      mkdirSync(join(testDir, 'cfg'));
      const explicit = join(testDir, 'cfg', 'custom.yml');
      writeFileSync(explicit, 'targets: {}');
      expect(resolveProjectConfigPath(testDir, 'cfg/custom.yml')).toBe(explicit);
    });

    it('throws the explicit-path code when --config points at a non-existent file', () => {
      expect(() => resolveProjectConfigPath(testDir, '/nope/missing.yml')).toThrow(
        /does not exist/,
      );
      try {
        resolveProjectConfigPath(testDir, '/nope/missing.yml');
        expect.unreachable('an explicit --config miss must throw');
      } catch (error) {
        // Distinct from the discovery-walk miss: the repair is different (fix the flag vs
        // run init), so collapsing both onto one code would make the operator action wrong
        // for one of them.
        expect((error as ToolError).code).toBe('CONFIGURATION.CONFIG.EXPLICIT_PATH_MISSING');
      }
    });

    it('ignores empty-string explicit paths and falls through to the default', () => {
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(defaultPath, 'targets: {}');
      expect(resolveProjectConfigPath(testDir, '')).toBe(defaultPath);
    });
  });

  describe('canonical root config', () => {
    it('ignores package.json#opensip-cli.configPath when the root config exists', () => {
      mkdirSync(join(testDir, '.config'));
      const pointed = join(testDir, '.config', 'cfg.yml');
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(pointed, 'targets: pointed');
      writeFileSync(defaultPath, 'targets: root');
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ 'opensip-cli': { configPath: '.config/cfg.yml' } }),
      );

      expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
    });

    it('throws when only package.json#opensip-cli.configPath points at a config', () => {
      mkdirSync(join(testDir, '.config'));
      const pointed = join(testDir, '.config', 'cfg.yml');
      writeFileSync(pointed, 'targets: pointed');
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ 'opensip-cli': { configPath: '.config/cfg.yml' } }),
      );

      expect(() => resolveProjectConfigPath(testDir)).toThrow(/No opensip-cli.config.yml found/);
    });

    it('falls through to default when package.json is malformed', () => {
      writeFileSync(join(testDir, 'package.json'), '{not-json');
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(defaultPath, 'targets: {}');
      expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
    });

    it('falls through to default when package.json has no opensip-cli section', () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'x' }));
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(defaultPath, 'targets: {}');
      expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
    });
  });
});
