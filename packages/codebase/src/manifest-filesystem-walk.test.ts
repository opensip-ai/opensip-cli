import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { opendirMock, lstatMock } = vi.hoisted(() => ({
  opendirMock: vi.fn(),
  lstatMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return { ...actual, opendir: opendirMock, lstat: lstatMock };
});

import {
  MAX_MANIFEST_ENTRIES_PER_DIRECTORY,
  walkManifestFilesystem,
} from './manifest-filesystem-walk.js';

import type { Dir, Dirent } from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';

let root: string;

function fileEntry(name: string): Dirent<string> {
  return {
    name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    isFIFO: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as Dirent<string>;
}

function symlinkEntry(name: string): Dirent<string> {
  return {
    name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    isFIFO: () => false,
    isFile: () => false,
    isSocket: () => false,
    isSymbolicLink: () => true,
  } as Dirent<string>;
}

function unknownEntry(name: string): Dirent<string> {
  return {
    name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    isFIFO: () => false,
    isFile: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as Dirent<string>;
}

function fakeDirectory(input: {
  readonly close?: () => Promise<void>;
  readonly read: () => Promise<Dirent<string> | null>;
}): Dir {
  return {
    close: input.close ?? (() => Promise.resolve(undefined)),
    read: input.read,
  } as unknown as Dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-manifest-walk-'));
  opendirMock.mockReset();
  lstatMock.mockReset();
  lstatMock.mockImplementation(async (path: string) => {
    const { lstat } = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
    return lstat(path);
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('walkManifestFilesystem edge cases', () => {
  it('discovers nested package manifests and ignores root package.json candidates', async () => {
    mkdirSync(join(root, 'packages/app'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'packages/app/package.json'), '{}');
    writeFileSync(join(root, 'packages/app/readme.txt'), 'x');
    mkdirSync(join(root, 'node_modules/dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules/dep/package.json'), '{}');
    mkdirSync(join(root, 'opensip-cli/.runtime/private'), { recursive: true });
    writeFileSync(join(root, 'opensip-cli/.runtime/private/package.json'), '{}');

    // Use real fs for this integration-style walk.
    opendirMock.mockImplementation(async (path: string, options?: { bufferSize?: number }) => {
      const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
      return actual.opendir(path, options);
    });

    const offered: string[] = [];
    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      (candidate) => {
        offered.push(candidate.packageRoot);
      },
    );

    expect(result.cancelled).toBe(false);
    expect(result.capped).toBe(false);
    expect(offered).toEqual(['packages/app']);
  });

  it('stops the walk when the visitor returns false', async () => {
    mkdirSync(join(root, 'packages/a'), { recursive: true });
    mkdirSync(join(root, 'packages/b'), { recursive: true });
    writeFileSync(join(root, 'packages/a/package.json'), '{}');
    writeFileSync(join(root, 'packages/b/package.json'), '{}');
    opendirMock.mockImplementation(async (path: string, options?: { bufferSize?: number }) => {
      const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
      return actual.opendir(path, options);
    });

    const offered: string[] = [];
    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      (candidate) => {
        offered.push(candidate.packageRoot);
        return false;
      },
    );

    expect(result.stoppedByVisitor).toBe(true);
    expect(offered).toHaveLength(1);
  });

  it('marks the walk capped when opendir fails', async () => {
    opendirMock.mockRejectedValue(new Error('permission denied'));
    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      () => undefined,
    );
    expect(result).toMatchObject({
      cancelled: false,
      capped: true,
      readFailed: true,
      metrics: { visitedDirectories: 1 },
    });
  });

  it('classifies unknown directory entries via lstat and ignores plain files', async () => {
    const read = vi
      .fn<() => Promise<Dirent<string> | null>>()
      .mockResolvedValueOnce(fileEntry('notes.txt'))
      .mockResolvedValueOnce(symlinkEntry('package.json'))
      .mockResolvedValueOnce(unknownEntry('mystery-dir'))
      .mockResolvedValueOnce(unknownEntry('mystery-file'))
      .mockResolvedValueOnce(unknownEntry('broken'))
      .mockResolvedValueOnce(null);
    const close = vi.fn(() => Promise.resolve(undefined));
    opendirMock.mockResolvedValueOnce(fakeDirectory({ read, close }));
    // second open for mystery-dir
    opendirMock.mockResolvedValueOnce(
      fakeDirectory({
        read: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve(undefined)),
      }),
    );

    lstatMock
      .mockResolvedValueOnce({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      })
      .mockResolvedValueOnce({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })
      .mockRejectedValueOnce(new Error('lstat failed'));

    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      () => undefined,
    );

    expect(result.readFailed).toBe(true);
    expect(result.capped).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it('caps depth and respects shouldEnterDirectory pruning', async () => {
    mkdirSync(join(root, 'keep/nested'), { recursive: true });
    mkdirSync(join(root, 'skip/nested'), { recursive: true });
    writeFileSync(join(root, 'keep/nested/package.json'), '{}');
    writeFileSync(join(root, 'skip/nested/package.json'), '{}');
    opendirMock.mockImplementation(async (path: string, options?: { bufferSize?: number }) => {
      const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
      return actual.opendir(path, options);
    });

    const offered: string[] = [];
    const result = await walkManifestFilesystem(
      root,
      1,
      (relativeDirectory) => !relativeDirectory.startsWith('skip'),
      (candidate) => {
        offered.push(candidate.packageRoot);
      },
    );

    // depth 1 means keep is entered, keep/nested is depth-capped
    expect(result.capped).toBe(true);
    expect(offered).toEqual([]);
  });

  it('ignores common vendor directories and symbolic-link package.json files', async () => {
    mkdirSync(join(root, 'packages/app'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'coverage'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'packages/app/package.json'), '{}');
    writeFileSync(join(root, 'dist/package.json'), '{}');
    const realManifest = join(root, 'packages/app/package.json');
    symlinkSync(realManifest, join(root, 'packages/linked-package.json'));
    // Place a package.json symlink under packages/linked/
    mkdirSync(join(root, 'packages/linked'), { recursive: true });
    symlinkSync(realManifest, join(root, 'packages/linked/package.json'));

    opendirMock.mockImplementation(async (path: string, options?: { bufferSize?: number }) => {
      const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
      return actual.opendir(path, options);
    });

    const offered: string[] = [];
    await walkManifestFilesystem(
      root,
      12,
      () => true,
      (candidate) => {
        offered.push(candidate.packageRoot);
      },
    );

    const sortedOffered = [...offered];
    sortedOffered.sort();
    expect(sortedOffered).toEqual(['packages/app', 'packages/linked']);
  });

  it('observes cancellation at checkpoints during large directory reads', async () => {
    const entries = Array.from({ length: 200 }, (_, index) =>
      fileEntry(`f-${String(index).padStart(3, '0')}.txt`),
    );
    let index = 0;
    const read = vi.fn(() => {
      if (index >= entries.length) return Promise.resolve(null);
      const entry = entries[index];
      index += 1;
      return Promise.resolve(entry ?? null);
    });
    opendirMock.mockResolvedValue(fakeDirectory({ read }));
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 40;
      },
    } as AbortSignal;

    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      () => undefined,
      signal,
    );

    expect(result.cancelled).toBe(true);
    expect(result.metrics.visitedEntries).toBeLessThan(200);
    expect(result.metrics.visitedEntries).toBeGreaterThan(0);
  });

  it('caps a directory that exceeds the retained-entry budget', async () => {
    const entries = Array.from({ length: MAX_MANIFEST_ENTRIES_PER_DIRECTORY + 2 }, (_, index) =>
      fileEntry(`f-${String(index).padStart(5, '0')}.txt`),
    );
    let index = 0;
    const read = vi.fn(() => {
      if (index >= entries.length) return Promise.resolve(null);
      const entry = entries[index];
      index += 1;
      return Promise.resolve(entry ?? null);
    });
    opendirMock.mockResolvedValue(fakeDirectory({ read }));

    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      () => undefined,
    );

    expect(result.capped).toBe(true);
    expect(result.metrics.visitedEntries).toBe(MAX_MANIFEST_ENTRIES_PER_DIRECTORY);
  });
});
