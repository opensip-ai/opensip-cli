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
  acquireRuntimeExclusiveLease,
  acquireRuntimeReadLease,
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  inspectRuntimeLeaseState,
  legacyEphemeralProjectCacheKey,
  mutateRuntimePromotionJournal,
  resolveCoordinationPaths,
  resolveEphemeralProjectPaths,
  resolveProjectContext,
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

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime coordination');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function stagePromotionJournal(project: string, state: 'open' | 'closed'): Promise<void> {
  const writer = await acquireRuntimeExclusiveLease({
    projectDir: project,
    policy: { waitMs: 3000, pollMs: 5 },
  });
  try {
    await mutateRuntimePromotionJournal(writer, {
      operation: 'create',
      content: JSON.stringify({
        kind: 'init-promotion',
        version: 1,
        coordinationKey: writer.coordinationKey,
        operationId: `status-${state}-journal`,
        state,
      }),
    });
  } finally {
    writer.release();
  }
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
  it('reports a fresh project without creating project or cache state', async () => {
    const project = makeProject('fresh');
    const before = readdirSync(project);

    const result = await execute(project);

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
    expect(existsSync(resolveCoordinationPaths().coordinationDir)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(home);
    expect(JSON.stringify(result)).not.toContain(project);
  });

  it('projects cache-only evidence and its read commands', async () => {
    const project = makeProject('cache-only');
    const paths = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(paths, Date.parse('2026-07-16T12:00:00.000Z'));
    writeFileSync(join(paths.runtimeDir, 'datastore.sqlite'), 'evidence');

    const result = await execute(project);

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

  it('selects initialized project storage even when it is empty', async () => {
    const project = makeProject('initialized-empty', true);

    const result = await execute(project);

    expect(result).toMatchObject({
      projectInitialized: true,
      activePlane: 'project',
      project: { exists: false },
      evidenceDatabase: { exists: false },
      adoptionState: 'not-needed',
      nextCommands: ['opensip uninstall --project --dry-run'],
    });
  });

  it('reports project-only storage and a generation-verified cache conflict', async () => {
    const projectOnly = makeProject('project-only', true);
    const projectRuntime = join(projectOnly, 'opensip-cli', '.runtime');
    mkdirSync(projectRuntime, { recursive: true });
    writeFileSync(join(projectRuntime, 'datastore.sqlite'), 'project-db');
    expect(await execute(projectOnly)).toMatchObject({
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
    expect(await execute(conflict)).toMatchObject({
      activePlane: 'project',
      project: { exists: true },
      cache: { exists: true, identityStrength: 'generation-bound' },
      adoptionState: 'conflict',
      nextCommands: expect.arrayContaining(['opensip init']),
    });

    writeFileSync(join(cachePaths.runtimeDir, EPHEMERAL_MARKER_FILE), '{');
    expect(await execute(conflict)).toMatchObject({
      projectInitialized: true,
      adoptionState: 'legacy-unverified',
      nextCommands: expect.arrayContaining(['opensip init']),
    });
  });

  it('converges root, nested, explicit-cwd, and symlink aliases', async () => {
    const project = makeProject('nested');
    const nested = join(project, 'packages', 'app', 'src');
    mkdirSync(nested, { recursive: true });
    const paths = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(paths);
    writeFileSync(join(paths.runtimeDir, 'datastore.sqlite'), 'x');

    const rootResult = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: false,
    });
    const nestedResult = await executeRuntimeStatus({
      cwd: nested,
      cwdExplicit: true,
    });
    expect(nestedResult).toEqual(rootResult);

    if (platform() !== 'win32') {
      const alias = join(sandbox, 'project-alias');
      symlinkSync(project, alias);
      expect(await execute(alias)).toEqual(rootResult);
    }
  });

  it('classifies legacy, malformed, and oversize markers as unverified', async () => {
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
    expect(await execute(legacyProject)).toMatchObject({
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
      expect(await execute(project)).toMatchObject({
        cache: { exists: true, identityStrength: 'legacy-unverified' },
        adoptionState: 'legacy-unverified',
      });
    }
  });

  it('bounds runtime traversal and reports truncation', async () => {
    const project = makeProject('bounded', true);
    const runtime = join(project, 'opensip-cli', '.runtime');
    mkdirSync(join(runtime, 'many'), { recursive: true });
    writeFileSync(join(runtime, 'one'), '1');
    writeFileSync(join(runtime, 'two'), '2');
    writeFileSync(join(runtime, 'many', 'three'), '3');
    writeFileSync(join(runtime, 'datastore.sqlite'), '0123456789');

    const result = await executeRuntimeStatus({
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

  it('does not follow project or cache runtime symlinks to expose another location', async () => {
    if (platform() === 'win32') return;

    const project = makeProject('project-symlink', true);
    const externalProjectState = join(sandbox, 'external-project-state');
    mkdirSync(join(externalProjectState, '.runtime'), { recursive: true });
    writeFileSync(join(externalProjectState, '.runtime', 'datastore.sqlite'), 'private-evidence');
    symlinkSync(externalProjectState, join(project, 'opensip-cli'), 'dir');

    const projectResult = await execute(project);
    expect(projectResult.project).toEqual({
      exists: true,
      sizeTruncated: true,
    });
    expect(projectResult.evidenceDatabase).toEqual({ exists: false });

    const cacheProject = makeProject('cache-symlink');
    const cachePaths = resolveEphemeralProjectPaths(cacheProject);
    const externalCacheState = join(sandbox, 'external-cache-state');
    mkdirSync(externalCacheState, { recursive: true });
    writeFileSync(join(externalCacheState, 'datastore.sqlite'), 'other-private-evidence');
    mkdirSync(dirname(cachePaths.runtimeDir), { recursive: true });
    symlinkSync(externalCacheState, cachePaths.runtimeDir, 'dir');

    const cacheResult = await execute(cacheProject);
    expect(cacheResult.cache).toEqual({
      exists: true,
      identityStrength: 'legacy-unverified',
      sizeTruncated: true,
    });
    expect(cacheResult.evidenceDatabase).toEqual({ exists: false });
  });

  it('discloses path-only identity without claiming generation proof', async () => {
    const missingProject = join(sandbox, 'does-not-exist');
    const cache = resolveEphemeralProjectPaths(missingProject);
    expect(cache.identityStrength).toBe('path-only');
    touchEphemeralRuntime(cache);

    const result = await execute(missingProject);
    expect(result).toMatchObject({
      activePlane: 'cache',
      cache: { exists: true, identityStrength: 'path-only' },
      adoptionState: 'legacy-unverified',
    });
    expect(JSON.stringify(result)).not.toContain(missingProject);
  });

  it('reports other current-project readers while excluding its transient reader', async () => {
    const project = makeProject('active-reader');
    const reader = await acquireRuntimeReadLease({
      projectDir: project,
      policy: { waitMs: 3000, pollMs: 5 },
    });
    try {
      const result = await execute(project);

      expect(result).toMatchObject({
        adoptionState: 'not-needed',
        leaseActivity: {
          activeReaders: 1,
          writerPending: false,
          busy: false,
        },
      });
      expect(result).not.toHaveProperty('inspectionUnavailable');
    } finally {
      reader.release();
    }
  });

  it('reports a waiting promoter as busy without projecting runtime trees', async () => {
    const project = makeProject('waiting-promoter');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'must-not-project');
    const reader = await acquireRuntimeReadLease({
      projectDir: project,
      policy: { waitMs: 3000, pollMs: 5 },
    });
    const writerPromise = acquireRuntimeExclusiveLease({
      projectDir: project,
      policy: { waitMs: 3000, pollMs: 5 },
    });
    void writerPromise.catch(() => undefined);
    try {
      await waitUntil(async () => {
        const state = await inspectRuntimeLeaseState(project);
        return state.status === 'stable' && state.writer !== 'none';
      });

      const result = await execute(project);

      expect(result).toMatchObject({
        inspectionUnavailable: true,
        adoptionState: 'busy',
        cache: { exists: false },
        evidenceDatabase: { exists: false },
        leaseActivity: {
          activeReaders: 1,
          writerPending: true,
          busy: true,
        },
        nextCommands: [],
      });
      expect(result.evidenceDatabase).not.toHaveProperty('sizeBytes');
    } finally {
      reader.release();
      const writer = await writerPromise;
      writer.release();
    }
  });

  it('reports open and malformed promotion journals as bounded recovery', async () => {
    const openProject = makeProject('open-journal');
    const openCache = resolveEphemeralProjectPaths(openProject);
    touchEphemeralRuntime(openCache);
    writeFileSync(join(openCache.runtimeDir, 'datastore.sqlite'), 'must-not-project');
    await stagePromotionJournal(openProject, 'open');

    const open = await execute(openProject);
    expect(open).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'recovery-required',
      recoveryPhase: 'unknown',
      recoveryReasonCode: 'operation-interrupted',
      recoveryCommand: 'opensip init',
      nextCommands: ['opensip init'],
    });
    expect(open).not.toHaveProperty('sourcePreserved');
    expect(open.evidenceDatabase).toEqual({ exists: false });

    const malformedProject = makeProject('malformed-journal');
    const writer = await acquireRuntimeExclusiveLease({
      projectDir: malformedProject,
      policy: { waitMs: 3000, pollMs: 5 },
    });
    try {
      const journal = resolveCoordinationPaths().forProject(
        writer.coordinationKey,
      ).promotionJournalFile;
      writeFileSync(journal, '{', { mode: 0o600 });
    } finally {
      writer.release();
    }

    expect(await execute(malformedProject)).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'recovery-required',
      recoveryPhase: 'unknown',
      recoveryReasonCode: 'journal-malformed',
      recoveryCommand: 'opensip init',
    });
  });

  it('reads safely through a closed journal and reports terminal cleanup pending', async () => {
    const project = makeProject('closed-journal');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'evidence');
    await stagePromotionJournal(project, 'closed');

    const result = await execute(project);

    expect(result).toMatchObject({
      activePlane: 'cache',
      cache: { exists: true },
      evidenceDatabase: { exists: true, sizeBytes: 8 },
      adoptionState: 'ready',
      recoveryPhase: 'cleanup',
      recoveryReasonCode: 'cleanup-pending',
      cleanupPending: true,
      recoveryCommand: 'opensip init',
      leaseActivity: {
        activeReaders: 0,
        writerPending: false,
        busy: false,
      },
    });
    expect(result).not.toHaveProperty('sourcePreserved');
    expect(result).not.toHaveProperty('inspectionUnavailable');
  });

  it('discards a tree projection if coordination appears during an absent-root scan', async () => {
    const project = makeProject('coordination-race');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'raced-evidence');
    let presenceChecks = 0;

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      coordination: {
        rootPresence: () => {
          presenceChecks++;
          return presenceChecks === 1 ? 'absent' : 'present';
        },
      },
    });

    expect(result).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'busy',
      cache: { exists: false },
      evidenceDatabase: { exists: false },
    });
    expect(result.evidenceDatabase).not.toHaveProperty('sizeBytes');
  });

  it.each([
    'TIMEOUT.RUNTIME_READ',
    'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH',
    'SYSTEM.RUNTIME_COORDINATION.EXISTS',
    'SYSTEM.RUNTIME_LEASE.CAPACITY',
    'SYSTEM.RUNTIME_LEASE.CLEANUP_CAPACITY',
  ])('maps bounded lease unavailability %s to busy without reading storage', async (code) => {
    const project = makeProject('lease-timeout');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'must-not-project');
    const stableInspection = {
      status: 'stable',
      projectReaders: 0,
      userStateReaders: 7,
      writer: 'none',
      globalWriter: 'none',
      promotion: { status: 'absent' },
      userUninstall: { status: 'absent' },
    } as const;

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      coordination: {
        rootPresence: () => 'present',
        inspect: () => Promise.resolve(stableInspection),
        acquireRead: () =>
          Promise.reject(
            Object.assign(new Error('private timeout detail'), {
              code,
            }),
          ),
      },
    });

    expect(result).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'busy',
      cache: { exists: false },
      evidenceDatabase: { exists: false },
      leaseActivity: {
        activeReaders: 0,
        writerPending: false,
        busy: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('private timeout detail');
    expect(JSON.stringify(result)).not.toContain('must-not-project');
    expect(JSON.stringify(result)).not.toContain('userStateReaders');
  });

  it('maps a changed coordination snapshot during inspection to busy without acquiring', async () => {
    const project = makeProject('inspection-snapshot-changed');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'must-not-project');
    let acquisitionCalls = 0;

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      coordination: {
        rootPresence: () => 'present',
        inspect: () =>
          Promise.reject(
            Object.assign(new Error('private snapshot detail'), {
              code: 'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH',
            }),
          ),
        acquireRead: () => {
          acquisitionCalls++;
          return Promise.reject(new Error('must not acquire'));
        },
      },
    });

    expect(result).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'busy',
      cache: { exists: false },
      evidenceDatabase: { exists: false },
    });
    expect(JSON.stringify(result)).not.toContain('private snapshot detail');
    expect(JSON.stringify(result)).not.toContain('must-not-project');
    expect(acquisitionCalls).toBe(0);
  });

  it('refuses to scan when its transient reader is absent before storage inspection', async () => {
    const project = makeProject('reader-missing-before-scan');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'must-not-project');
    let inspectionCalls = 0;
    let releaseCalls = 0;
    const beforeAcquisition = {
      status: 'stable',
      projectReaders: 0,
      userStateReaders: 0,
      writer: 'none',
      globalWriter: 'none',
      promotion: { status: 'absent' },
      userUninstall: { status: 'absent' },
    } as const;

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      coordination: {
        rootPresence: () => 'present',
        inspect: () => {
          inspectionCalls++;
          return Promise.resolve(beforeAcquisition);
        },
        acquireRead: () =>
          Promise.resolve({
            kind: 'runtime-read',
            ownerToken: 'status-reader-missing-before-0001',
            acquiredAt: Date.now(),
            coordinationKey: cache.coordinationKey,
            release: () => {
              releaseCalls++;
            },
          }),
      },
    });

    expect(result).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'busy',
      cache: { exists: false },
      evidenceDatabase: { exists: false },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-project');
    expect(inspectionCalls).toBe(2);
    expect(releaseCalls).toBe(1);
  });

  it('discards scanned storage facts when its transient reader disappears afterward', async () => {
    const project = makeProject('reader-missing-after-scan');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'discard-after-scan');
    let inspectionCalls = 0;
    let releaseCalls = 0;
    const inspection = () => {
      inspectionCalls++;
      return Promise.resolve({
        status: 'stable' as const,
        projectReaders: inspectionCalls === 2 ? 1 : 0,
        userStateReaders: 0,
        writer: 'none' as const,
        globalWriter: 'none' as const,
        promotion: { status: 'absent' as const },
        userUninstall: { status: 'absent' as const },
      });
    };

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      coordination: {
        rootPresence: () => 'present',
        inspect: inspection,
        acquireRead: () =>
          Promise.resolve({
            kind: 'runtime-read',
            ownerToken: 'status-reader-missing-after-0001',
            acquiredAt: Date.now(),
            coordinationKey: cache.coordinationKey,
            release: () => {
              releaseCalls++;
            },
          }),
      },
    });

    expect(result).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'busy',
      cache: { exists: false },
      evidenceDatabase: { exists: false },
    });
    expect(JSON.stringify(result)).not.toContain('discard-after-scan');
    expect(inspectionCalls).toBe(3);
    expect(releaseCalls).toBe(1);
  });

  it('discards scanned storage facts when transient lease release is unproven', async () => {
    const project = makeProject('lease-release-failure');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'discard-after-scan');
    let inspectionCalls = 0;
    let releaseCalls = 0;
    const stableInspection = {
      status: 'stable',
      projectReaders: 1,
      userStateReaders: 0,
      writer: 'none',
      globalWriter: 'none',
      promotion: { status: 'absent' },
      userUninstall: { status: 'absent' },
    } as const;

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      coordination: {
        rootPresence: () => 'present',
        inspect: () => {
          inspectionCalls++;
          return Promise.resolve(stableInspection);
        },
        acquireRead: () =>
          Promise.resolve({
            kind: 'runtime-read',
            ownerToken: 'status-release-failure-0001',
            acquiredAt: Date.now(),
            coordinationKey: cache.coordinationKey,
            release: () => {
              releaseCalls++;
              throw new Error('private release failure');
            },
          }),
      },
    });

    expect(result).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'busy',
      cache: { exists: false },
      evidenceDatabase: { exists: false },
    });
    expect(JSON.stringify(result)).not.toContain('discard-after-scan');
    expect(JSON.stringify(result)).not.toContain('private release failure');
    expect(inspectionCalls).toBe(3);
    expect(releaseCalls).toBe(1);
  });

  it('re-resolves storage selection after acquiring the transient reader', async () => {
    const project = makeProject('context-refresh');
    const projectRuntime = join(project, 'opensip-cli', '.runtime');
    mkdirSync(projectRuntime, { recursive: true });
    writeFileSync(join(projectRuntime, 'datastore.sqlite'), 'project-evidence');
    const coordinationKey = resolveEphemeralProjectPaths(project).coordinationKey;
    const stableInspection = {
      status: 'stable',
      projectReaders: 1,
      userStateReaders: 0,
      writer: 'none',
      globalWriter: 'none',
      promotion: { status: 'absent' },
      userUninstall: { status: 'absent' },
    } as const;

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      coordination: {
        rootPresence: () => 'present',
        inspect: () => Promise.resolve(stableInspection),
        acquireRead: () => {
          writeFileSync(join(project, 'opensip-cli.config.yml'), 'schemaVersion: 1\n');
          return Promise.resolve({
            kind: 'runtime-read',
            ownerToken: 'status-context-refresh-0001',
            acquiredAt: Date.now(),
            coordinationKey,
            release: () => undefined,
          });
        },
      },
    });

    expect(result).toMatchObject({
      projectInitialized: true,
      activePlane: 'project',
      project: { exists: true },
      evidenceDatabase: { exists: true, sizeBytes: 16 },
    });
  });

  it('preserves explicit config authority while re-resolving under the transient reader', async () => {
    const project = makeProject('explicit-config');
    const explicitConfigPath = join(project, 'custom-opensip.yml');
    writeFileSync(
      explicitConfigPath,
      [
        'schemaVersion: 1',
        'targets: {}',
        'cli:',
        '  sessions:',
        '    keep: 17',
        '    maxAgeDays: 23',
        '    maxSizeMb: 41',
        '',
      ].join('\n'),
    );
    const projectContext = resolveProjectContext({
      cwd: project,
      cwdExplicit: true,
      explicitConfigPath,
    });
    const reader = await acquireRuntimeReadLease({
      projectDir: project,
      policy: { waitMs: 3000, pollMs: 5 },
    });
    reader.release();

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      explicitConfigPath,
      projectContext,
    });

    expect(result).toMatchObject({
      projectInitialized: true,
      activePlane: 'project',
      retention: {
        evidence: {
          keep: 17,
          maxAgeDays: 23,
          maxSizeMb: 41,
        },
      },
    });
  });

  it('refuses to scan when the acquired lease does not protect the re-resolved root', async () => {
    const project = makeProject('context-key-mismatch');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'must-not-project');
    let releaseCalls = 0;
    const stableInspection = {
      status: 'stable',
      projectReaders: 1,
      userStateReaders: 0,
      writer: 'none',
      globalWriter: 'none',
      promotion: { status: 'absent' },
      userUninstall: { status: 'absent' },
    } as const;

    const result = await executeRuntimeStatus({
      cwd: project,
      cwdExplicit: true,
      coordination: {
        rootPresence: () => 'present',
        inspect: () => Promise.resolve(stableInspection),
        acquireRead: () =>
          Promise.resolve({
            kind: 'runtime-read',
            ownerToken: 'status-context-mismatch-0001',
            acquiredAt: Date.now(),
            coordinationKey: 'different-canonical-root',
            release: () => {
              releaseCalls++;
            },
          }),
      },
    });

    expect(result).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'busy',
      cache: { exists: false },
      evidenceDatabase: { exists: false },
    });
    expect(releaseCalls).toBe(1);
  });

  it('does not disclose another project reader or writer activity', async () => {
    const current = makeProject('current-project');
    const other = makeProject('other-project');
    const otherWriter = await acquireRuntimeExclusiveLease({
      projectDir: other,
      policy: { waitMs: 3000, pollMs: 5 },
    });
    try {
      const result = await execute(current);
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({
        adoptionState: 'not-needed',
        leaseActivity: {
          activeReaders: 0,
          writerPending: false,
          busy: false,
        },
      });
      expect(serialized).not.toContain(other);
      expect(serialized).not.toContain(current);
      expect(serialized).not.toContain(home);
    } finally {
      otherWriter.release();
    }
  });

  it('reports an unsafe coordination parent without following it or reading storage', async () => {
    if (platform() === 'win32') return;
    const project = makeProject('unsafe-coordination');
    const cache = resolveEphemeralProjectPaths(project);
    touchEphemeralRuntime(cache);
    writeFileSync(join(cache.runtimeDir, 'datastore.sqlite'), 'must-not-project');
    const external = join(sandbox, 'external-coordination');
    mkdirSync(external);
    symlinkSync(external, resolveCoordinationPaths().coordinationDir, 'dir');

    const result = await execute(project);

    expect(result).toMatchObject({
      inspectionUnavailable: true,
      adoptionState: 'busy',
      cache: { exists: false },
      evidenceDatabase: { exists: false },
    });
    expect(result.evidenceDatabase).not.toHaveProperty('sizeBytes');
  });
});
