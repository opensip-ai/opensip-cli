/**
 * @fileoverview Unit tests for `resolveProjectContext`.
 *
 * Critical isolation note: every fixture uses `mkdtempSync` + `stopAt` so
 * the walker cannot escape into the real opensip-tools repo's
 * `opensip-tools.config.yml` (which sits somewhere above the test runner's
 * cwd). Tests that omit `stopAt` would be machine-dependent and flaky.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ValidationError } from '../errors.js';
import { logger } from '../logger.js';
import { resolveProjectContext } from '../project-context.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-project-context-'));
  vi.restoreAllMocks();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeConfig(dir: string): string {
  const path = join(dir, 'opensip-tools.config.yml');
  writeFileSync(path, 'targets: {}\n');
  return path;
}

describe('resolveProjectContext', () => {
  describe('basic ancestor walking', () => {
    it('returns the project when cwd is the root itself', () => {
      const configPath = writeConfig(testDir);
      const ctx = resolveProjectContext({
        cwd: testDir,
        cwdExplicit: false,
        stopAt: testDir,
      });
      expect(ctx.projectRoot).toBe(testDir);
      expect(ctx.configPath).toBe(configPath);
      expect(ctx.walkedUp).toBe(0);
      expect(ctx.scope).toBe('project');
    });

    it('walks up one level to find the config', () => {
      writeConfig(testDir);
      const subdir = join(testDir, 'sub');
      mkdirSync(subdir);
      const ctx = resolveProjectContext({
        cwd: subdir,
        cwdExplicit: false,
        stopAt: testDir,
      });
      expect(ctx.projectRoot).toBe(testDir);
      expect(ctx.walkedUp).toBe(1);
      expect(ctx.scope).toBe('project');
    });

    it('walks up several levels to find the config', () => {
      writeConfig(testDir);
      const deep = join(testDir, 'a', 'b', 'c', 'd');
      mkdirSync(deep, { recursive: true });
      const ctx = resolveProjectContext({
        cwd: deep,
        cwdExplicit: false,
        stopAt: testDir,
      });
      expect(ctx.projectRoot).toBe(testDir);
      expect(ctx.walkedUp).toBe(4);
    });

    it('picks the nearest ancestor when multiple configs exist', () => {
      writeConfig(testDir);
      const inner = join(testDir, 'outer');
      mkdirSync(inner);
      writeConfig(inner);
      const sub = join(inner, 'sub');
      mkdirSync(sub);
      const ctx = resolveProjectContext({
        cwd: sub,
        cwdExplicit: false,
        stopAt: testDir,
      });
      expect(ctx.projectRoot).toBe(inner);
      expect(ctx.walkedUp).toBe(1);
    });
  });

  describe('no project found', () => {
    it("returns scope 'none' when no config exists up to stopAt", () => {
      const ctx = resolveProjectContext({
        cwd: testDir,
        cwdExplicit: false,
        stopAt: testDir,
      });
      expect(ctx.scope).toBe('none');
      expect(ctx.projectRoot).toBe(testDir);
      expect(ctx.configPath).toBeUndefined();
      expect(ctx.walkedUp).toBe(0);
    });

    it('honors stopAt to prevent walking into the real repo above tmpdir', () => {
      // No config anywhere in testDir, but the host machine's real
      // opensip-tools repo's config lives somewhere above tmpdir. The
      // walker MUST stop at testDir; otherwise this test passes
      // on machines that don't host an opensip-tools checkout and
      // fails on machines that do.
      const inner = join(testDir, 'inner');
      mkdirSync(inner);
      const ctx = resolveProjectContext({
        cwd: inner,
        cwdExplicit: false,
        stopAt: testDir,
      });
      expect(ctx.scope).toBe('none');
    });
  });

  describe('package.json pointer at ancestor', () => {
    it('honors package.json#opensip-tools.configPath when walking up', () => {
      // testDir/package.json → "configPath": "config/opensip-tools.config.yml"
      // testDir/config/opensip-tools.config.yml exists
      mkdirSync(join(testDir, 'config'));
      const pointedConfig = join(testDir, 'config', 'opensip-tools.config.yml');
      writeFileSync(pointedConfig, 'targets: {}\n');
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ 'opensip-tools': { configPath: 'config/opensip-tools.config.yml' } }),
      );
      const sub = join(testDir, 'sub');
      mkdirSync(sub);
      const ctx = resolveProjectContext({
        cwd: sub,
        cwdExplicit: false,
        stopAt: testDir,
      });
      expect(ctx.projectRoot).toBe(testDir);
      expect(ctx.configPath).toBe(pointedConfig);
      expect(ctx.walkedUp).toBe(1);
    });
  });

  describe('explicit --config behavior', () => {
    it('uses explicitConfigPath when it resolves to an existing file at cwd', () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'opensip-elsewhere-'));
      try {
        const explicit = writeConfig(elsewhere);
        const ctx = resolveProjectContext({
          cwd: testDir,
          cwdExplicit: false,
          explicitConfigPath: explicit,
          stopAt: testDir,
        });
        expect(ctx.scope).toBe('project');
        expect(ctx.projectRoot).toBe(testDir);
        expect(ctx.configPath).toBe(explicit);
        expect(ctx.walkedUp).toBe(0);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('THROWS ValidationError when explicitConfigPath does not resolve (strict --config)', () => {
      // No silent walk-up: an explicit --config that misses is a USER ERROR.
      const missing = join(testDir, 'definitely-not-here.yml');
      expect(() =>
        resolveProjectContext({
          cwd: testDir,
          cwdExplicit: false,
          explicitConfigPath: missing,
          stopAt: testDir,
        }),
      ).toThrow(ValidationError);
    });

    it('does not apply explicitConfigPath beyond the starting ancestor', () => {
      // Sanity check: explicit is only consulted at walkedUp === 0. If the
      // explicit resolves (existing file), it wins immediately — so there's
      // no observable "ancestor 2 had its own explicit check" scenario to
      // construct. This test instead confirms that an explicit hitting the
      // CWD ancestor doesn't keep walking once it wins.
      const explicit = writeConfig(testDir);
      // Also plant a different config in an ancestor — walker should NOT
      // travel to it because explicit at cwd already resolved.
      const parentLike = join(testDir, 'parentlike');
      mkdirSync(parentLike);
      writeConfig(parentLike); // not used
      const ctx = resolveProjectContext({
        cwd: testDir,
        cwdExplicit: false,
        explicitConfigPath: explicit,
        stopAt: testDir,
      });
      expect(ctx.projectRoot).toBe(testDir);
      expect(ctx.walkedUp).toBe(0);
    });
  });

  describe('cwd handling', () => {
    it('flows cwdExplicit through unchanged', () => {
      writeConfig(testDir);
      const truthy = resolveProjectContext({
        cwd: testDir,
        cwdExplicit: true,
        stopAt: testDir,
      });
      expect(truthy.cwdExplicit).toBe(true);

      const falsy = resolveProjectContext({
        cwd: testDir,
        cwdExplicit: false,
        stopAt: testDir,
      });
      expect(falsy.cwdExplicit).toBe(false);
    });

    it('resolves a relative cwd to absolute', () => {
      // Pass a relative path; the returned `cwd` must be absolute.
      const ctx = resolveProjectContext({
        cwd: 'some/relative/path',
        cwdExplicit: false,
        stopAt: resolve('some/relative/path'),
      });
      expect(ctx.cwd).toBe(resolve('some/relative/path'));
      expect(ctx.cwd.startsWith('/')).toBe(true);
    });
  });

  describe('structured logging', () => {
    it("emits 'project.root.resolved' on success", () => {
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      writeConfig(testDir);
      resolveProjectContext({
        cwd: testDir,
        cwdExplicit: false,
        stopAt: testDir,
      });
      const resolvedCall = debugSpy.mock.calls.find(
        (c) =>
          typeof c[0] === 'object' && (c[0] as { evt?: string }).evt === 'project.root.resolved',
      );
      expect(resolvedCall).toBeDefined();
      const payload = resolvedCall![0] as Record<string, unknown>;
      expect(payload.cwd).toBe(testDir);
      expect(payload.projectRoot).toBe(testDir);
      expect(payload.walkedUp).toBe(0);
    });

    it("emits 'project.root.not-found' on miss", () => {
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      resolveProjectContext({
        cwd: testDir,
        cwdExplicit: false,
        stopAt: testDir,
      });
      const notFoundCall = debugSpy.mock.calls.find(
        (c) =>
          typeof c[0] === 'object' && (c[0] as { evt?: string }).evt === 'project.root.not-found',
      );
      expect(notFoundCall).toBeDefined();
    });
  });
});
