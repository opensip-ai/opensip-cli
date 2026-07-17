import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  legacyEphemeralProjectCacheKey,
  resolveEphemeralProjectPaths,
  resolveUserPaths,
  touchEphemeralRuntime,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeRuntimeStatus } from '../runtime-status.js';

let sandbox: string;
let home: string;
let previousHome: string | undefined;

function makeProject(name: string, initialized = false): string {
  const project = join(sandbox, name);
  mkdirSync(join(project, '.git'), { recursive: true });
  if (initialized) writeFileSync(join(project, 'opensip-cli.config.yml'), 'schemaVersion: 1\n');
  return project;
}

function execute(cwd: string) {
  return executeRuntimeStatus({ cwd, cwdExplicit: true });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'opensip-runtime-status-'));
  home = join(sandbox, 'home');
  mkdirSync(home);
  previousHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('executeRuntimeStatus', () => {
  it('reports a fresh project without creating project or cache state', () => {
    const project = makeProject('fresh');
    const before = readdirSync(project);

    const result = execute(project);

    expect(result).toMatchObject({
      type: 'runtime-status',
      projectInitialized: false,
      activePlane: 'none',
      cache: { exists: false, identityStrength: 'generation-bound' },
      project: { exists: false },
      evidenceDatabase: { exists: false },
      adoptionState: 'not-needed',
      nextCommands: ['opensip init'],
    });
    expect(readdirSync(project)).toEqual(before);
    expect(existsSync(resolveUserPaths().userHomeDir)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(home);
    expect(JSON.stringify(result)).not.toContain(project);
  });

  it('projects cache-only evidence and its read commands', () => {
    const project = makeProject('cache-only');
    const paths = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(paths, Date.parse('2026-07-16T12:00:00.000Z'));
    writeFileSync(join(paths.runtimeDir, 'datastore.sqlite'), 'evidence');

    const result = execute(project);

    expect(result).toMatchObject({
      activePlane: 'cache',
      projectInitialized: false,
      cache: {
        exists: true,
        identityStrength: 'generation-bound',
        lastUsedAt: '2026-07-16T12:00:00.000Z',
      },
      project: { exists: false },
      evidenceDatabase: { exists: true, sizeBytes: 8 },
      adoptionState: 'ready',
      nextCommands: ['opensip init', 'opensip runs list --json', 'opensip sessions list --json'],
    });
  });

  it('selects initialized project storage even when it is empty', () => {
    const project = makeProject('initialized-empty', true);

    const result = execute(project);

    expect(result).toMatchObject({
      projectInitialized: true,
      activePlane: 'project',
      project: { exists: false },
      evidenceDatabase: { exists: false },
      adoptionState: 'not-needed',
      nextCommands: ['opensip uninstall --project --dry-run'],
    });
  });

  it('reports project-only storage and a generation-verified cache conflict', () => {
    const projectOnly = makeProject('project-only', true);
    const projectRuntime = join(projectOnly, 'opensip-cli', '.runtime');
    mkdirSync(projectRuntime, { recursive: true });
    writeFileSync(join(projectRuntime, 'datastore.sqlite'), 'project-db');
    expect(execute(projectOnly)).toMatchObject({
      activePlane: 'project',
      project: { exists: true },
      cache: { exists: false },
      evidenceDatabase: { exists: true },
      adoptionState: 'not-needed',
    });

    const conflict = makeProject('conflict', true);
    mkdirSync(join(conflict, 'opensip-cli', '.runtime'), { recursive: true });
    const cachePaths = resolveEphemeralProjectPaths(conflict);
    touchEphemeralRuntime(cachePaths);
    expect(execute(conflict)).toMatchObject({
      activePlane: 'project',
      project: { exists: true },
      cache: { exists: true, identityStrength: 'generation-bound' },
      adoptionState: 'conflict',
      nextCommands: expect.arrayContaining(['opensip init']),
    });

    writeFileSync(join(cachePaths.runtimeDir, EPHEMERAL_MARKER_FILE), '{');
    expect(execute(conflict)).toMatchObject({
      projectInitialized: true,
      adoptionState: 'legacy-unverified',
      nextCommands: expect.arrayContaining(['opensip init']),
    });
  });

  it('converges root, nested, explicit-cwd, and symlink aliases', () => {
    const project = makeProject('nested');
    const nested = join(project, 'packages', 'app', 'src');
    mkdirSync(nested, { recursive: true });
    const paths = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(paths);
    writeFileSync(join(paths.runtimeDir, 'datastore.sqlite'), 'x');

    const rootResult = executeRuntimeStatus({ cwd: project, cwdExplicit: false });
    const nestedResult = executeRuntimeStatus({ cwd: nested, cwdExplicit: true });
    expect(nestedResult).toEqual(rootResult);

    if (platform() !== 'win32') {
      const alias = join(sandbox, 'project-alias');
      symlinkSync(project, alias);
      expect(execute(alias)).toEqual(rootResult);
    }
  });

  it('classifies legacy, malformed, and oversize markers as unverified', () => {
    const legacyProject = makeProject('legacy');
    const legacyDir = join(
      resolveUserPaths().ephemeralProjectsDir,
      legacyEphemeralProjectCacheKey(legacyProject),
    );
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, EPHEMERAL_MARKER_FILE),
      JSON.stringify({
        projectDir: legacyProject,
        lastUsedAt: '2026-07-15T00:00:00.000Z',
      }),
    );
    expect(execute(legacyProject)).toMatchObject({
      activePlane: 'cache',
      cache: { exists: true, identityStrength: 'legacy-unverified' },
      adoptionState: 'legacy-unverified',
    });

    for (const [name, marker] of [
      ['malformed', '{'],
      ['oversize', 'x'.repeat(EPHEMERAL_MARKER_MAX_BYTES + 1)],
    ] as const) {
      const project = makeProject(name);
      const paths = resolveEphemeralProjectPaths(project);
      mkdirSync(paths.runtimeDir, { recursive: true });
      writeFileSync(join(paths.runtimeDir, EPHEMERAL_MARKER_FILE), marker);
      expect(execute(project)).toMatchObject({
        cache: { exists: true, identityStrength: 'legacy-unverified' },
        adoptionState: 'legacy-unverified',
      });
    }
  });

  it('bounds runtime traversal and reports truncation', () => {
    const project = makeProject('bounded', true);
    const runtime = join(project, 'opensip-cli', '.runtime');
    mkdirSync(join(runtime, 'many'), { recursive: true });
    writeFileSync(join(runtime, 'one'), '1');
    writeFileSync(join(runtime, 'two'), '2');
    writeFileSync(join(runtime, 'many', 'three'), '3');
    writeFileSync(join(runtime, 'datastore.sqlite'), '0123456789');

    const result = executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      sizeLimits: { maxEntries: 2, maxBytes: 2 },
    });

    expect(result.project).toMatchObject({
      exists: true,
      sizeTruncated: true,
    });
    expect(result.evidenceDatabase).toEqual({ exists: true, sizeBytes: 10 });
  });

  it('does not follow project or cache runtime symlinks to expose another location', () => {
    if (platform() === 'win32') return;

    const project = makeProject('project-symlink', true);
    const externalProjectState = join(sandbox, 'external-project-state');
    mkdirSync(join(externalProjectState, '.runtime'), { recursive: true });
    writeFileSync(join(externalProjectState, '.runtime', 'datastore.sqlite'), 'private-evidence');
    symlinkSync(externalProjectState, join(project, 'opensip-cli'), 'dir');

    const projectResult = execute(project);
    expect(projectResult.project).toEqual({ exists: true, sizeTruncated: true });
    expect(projectResult.evidenceDatabase).toEqual({ exists: false });

    const cacheProject = makeProject('cache-symlink');
    const cachePaths = resolveEphemeralProjectPaths(cacheProject);
    const externalCacheState = join(sandbox, 'external-cache-state');
    mkdirSync(externalCacheState, { recursive: true });
    writeFileSync(join(externalCacheState, 'datastore.sqlite'), 'other-private-evidence');
    mkdirSync(dirname(cachePaths.runtimeDir), { recursive: true });
    symlinkSync(externalCacheState, cachePaths.runtimeDir, 'dir');

    const cacheResult = execute(cacheProject);
    expect(cacheResult.cache).toEqual({
      exists: true,
      identityStrength: 'legacy-unverified',
      sizeTruncated: true,
    });
    expect(cacheResult.evidenceDatabase).toEqual({ exists: false });
  });

  it('discloses path-only identity without claiming generation proof', () => {
    const missingProject = join(sandbox, 'does-not-exist');
    const cache = resolveEphemeralProjectPaths(missingProject);
    expect(cache.identityStrength).toBe('path-only');
    touchEphemeralRuntime(cache);

    const result = execute(missingProject);
    expect(result).toMatchObject({
      activePlane: 'cache',
      cache: { exists: true, identityStrength: 'path-only' },
      adoptionState: 'legacy-unverified',
    });
    expect(JSON.stringify(result)).not.toContain(missingProject);
  });
});
