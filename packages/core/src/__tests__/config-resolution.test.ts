import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProjectConfigPath, PROJECT_CONFIG_FILENAME } from '../config-resolution.js';
import { ValidationError } from '../lib/errors.js';

let testDir: string;

beforeEach(() => {
   
  testDir = mkdtempSync(join(tmpdir(), 'opensip-config-resolve-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveProjectConfigPath', () => {
  it('returns the default path when opensip-tools.config.yml exists at root', () => {
    const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
    writeFileSync(defaultPath, 'targets: {}');
    expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
  });

  it('throws ValidationError when no config exists anywhere', () => {
    expect(() => resolveProjectConfigPath(testDir)).toThrow(ValidationError);
    try {
      resolveProjectConfigPath(testDir);
    } catch (error) {
      expect((error as Error).message).toContain('No opensip-tools.config.yml found');
    }
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

    it('throws when --config points at a non-existent file', () => {
      expect(() => resolveProjectConfigPath(testDir, '/nope/missing.yml')).toThrow(
        /does not exist/,
      );
    });

    it('ignores empty-string explicit paths and falls through to the default', () => {
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(defaultPath, 'targets: {}');
      expect(resolveProjectConfigPath(testDir, '')).toBe(defaultPath);
    });
  });

  describe('package.json pointer', () => {
    it('reads opensip-tools.configPath from package.json and resolves relative paths', () => {
      mkdirSync(join(testDir, '.config'));
      const target = join(testDir, '.config', 'cfg.yml');
      writeFileSync(target, 'targets: {}');
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ 'opensip-tools': { configPath: '.config/cfg.yml' } }),
      );

      expect(resolveProjectConfigPath(testDir)).toBe(target);
    });

    it('accepts an absolute path in package.json pointer', () => {
      const target = join(testDir, 'cfg.yml');
      writeFileSync(target, 'targets: {}');
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ 'opensip-tools': { configPath: target } }),
      );

      expect(resolveProjectConfigPath(testDir)).toBe(target);
    });

    it('throws when the package.json pointer targets a missing file', () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ 'opensip-tools': { configPath: 'nope/missing.yml' } }),
      );
      expect(() => resolveProjectConfigPath(testDir)).toThrow(/points to a file that does not exist/);
    });

    it('falls through to default when package.json is malformed', () => {
      writeFileSync(join(testDir, 'package.json'), '{not-json');
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(defaultPath, 'targets: {}');
      expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
    });

    it('falls through to default when package.json has no opensip-tools section', () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'x' }));
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(defaultPath, 'targets: {}');
      expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
    });

    it('falls through when configPath is missing or empty', () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ 'opensip-tools': { configPath: '' } }),
      );
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(defaultPath, 'targets: {}');
      expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
    });

    it('falls through when opensip-tools is not an object', () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ 'opensip-tools': 'string-not-object' }),
      );
      const defaultPath = join(testDir, PROJECT_CONFIG_FILENAME);
      writeFileSync(defaultPath, 'targets: {}');
      expect(resolveProjectConfigPath(testDir)).toBe(defaultPath);
    });
  });
});
