import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureEphemeralRuntimeDirectory,
  ensureEphemeralRuntimeRoot,
} from '../ephemeral-runtime-directory.js';

import type * as PathsModule from '../paths.js';
import type { EphemeralProjectPaths, UserPaths } from '../paths.js';
import type * as NodeFs from 'node:fs';

interface DirectoryProbe {
  userPaths: UserPaths | undefined;
  mkdirErrorPath: string | undefined;
  mismatchOnFstatCall: Map<string, number>;
  fstatCalls: Map<string, number>;
  openPaths: Map<number, string>;
}

const directoryProbe = vi.hoisted<DirectoryProbe>(() => ({
  userPaths: undefined,
  mkdirErrorPath: undefined,
  mismatchOnFstatCall: new Map<string, number>(),
  fstatCalls: new Map<string, number>(),
  openPaths: new Map<number, string>(),
}));

vi.mock('../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PathsModule>();
  return {
    ...actual,
    resolveUserPaths: () => {
      if (directoryProbe.userPaths === undefined) throw new Error('test layout is unset');
      return directoryProbe.userPaths;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    mkdirSync: ((path: NodeFs.PathLike, options?: NodeFs.MakeDirectoryOptions) => {
      if (String(path) === directoryProbe.mkdirErrorPath) {
        const error = new Error('injected mkdir failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return actual.mkdirSync(path, options);
    }) as typeof actual.mkdirSync,
    openSync: ((path: NodeFs.PathLike, flags: NodeFs.OpenMode) => {
      const fd = actual.openSync(path, flags);
      directoryProbe.openPaths.set(fd, String(path));
      return fd;
    }) as typeof actual.openSync,
    fstatSync: ((fd: number, options: { bigint: true }) => {
      const stat = actual.fstatSync(fd, options);
      const path = directoryProbe.openPaths.get(fd);
      if (path === undefined) return stat;
      const call = (directoryProbe.fstatCalls.get(path) ?? 0) + 1;
      directoryProbe.fstatCalls.set(path, call);
      if (directoryProbe.mismatchOnFstatCall.get(path) !== call) return stat;
      return new Proxy(stat, {
        get(target, property) {
          if (property === 'ino') return target.ino + 1n;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof actual.fstatSync,
    closeSync: ((fd: number) => {
      directoryProbe.openPaths.delete(fd);
      actual.closeSync(fd);
    }) as typeof actual.closeSync,
  };
});

describe('ephemeral runtime directory guards', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ephemeral-runtime-directory-'));
    directoryProbe.userPaths = userPathsFor(root);
    directoryProbe.mkdirErrorPath = undefined;
    directoryProbe.mismatchOnFstatCall.clear();
    directoryProbe.fstatCalls.clear();
    directoryProbe.openPaths.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function userPathsFor(base: string): UserPaths {
    const userHomeDir = join(base, 'user');
    const cacheDir = join(userHomeDir, 'cache');
    return {
      userHomeDir,
      configFile: join(userHomeDir, 'config.yml'),
      cacheDir,
      ephemeralProjectsDir: join(cacheDir, 'ephemeral'),
      pluginsDir: (domain) => join(userHomeDir, 'plugins', domain),
      authoredToolsDir: join(userHomeDir, 'tools'),
      updateStateFile: join(userHomeDir, 'update-state.json'),
    };
  }

  it('rejects a cache directory that is not a direct child of the user home', () => {
    const paths = userPathsFor(root);
    directoryProbe.userPaths = {
      ...paths,
      cacheDir: join(paths.userHomeDir, 'nested', 'cache'),
      ephemeralProjectsDir: join(paths.userHomeDir, 'nested', 'cache', 'ephemeral'),
    };

    expect(() => ensureEphemeralRuntimeRoot()).toThrow(
      'Ephemeral cache directory is not a direct child',
    );
  });

  it('propagates a non-existence-independent mkdir failure', () => {
    const paths = userPathsFor(root);
    directoryProbe.mkdirErrorPath = paths.userHomeDir;

    expect(() => ensureEphemeralRuntimeRoot()).toThrow('injected mkdir failure');
  });

  it('closes and rejects a child whose descriptor identity differs from lstat', () => {
    const paths = userPathsFor(root);
    mkdirSync(paths.userHomeDir, { mode: 0o700 });
    directoryProbe.mismatchOnFstatCall.set(paths.userHomeDir, 1);

    expect(() => ensureEphemeralRuntimeRoot()).toThrow(
      'Ephemeral cache directory changed or escaped',
    );
  });

  it('rejects a parent descriptor that changes during child preparation', () => {
    const paths = userPathsFor(root);
    mkdirSync(paths.userHomeDir, { mode: 0o700 });
    directoryProbe.mismatchOnFstatCall.set(root, 3);

    expect(() => ensureEphemeralRuntimeRoot()).toThrow(
      'Ephemeral cache parent changed during directory preparation',
    );
  });

  it('rejects a runtime path that does not match its cache identity', () => {
    const paths = userPathsFor(root);
    const invalid = {
      cacheKey: 'not-a-cache-key',
      runtimeDir: join(paths.ephemeralProjectsDir, 'not-a-cache-key'),
    } as EphemeralProjectPaths;

    expect(() => ensureEphemeralRuntimeDirectory(invalid)).toThrow(
      'Ephemeral runtime path does not match its cache identity',
    );
  });
});
