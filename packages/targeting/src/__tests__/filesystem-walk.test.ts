import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { opendirMock, statMock, lstatMock, isPathInsideMock } = vi.hoisted(() => ({
  opendirMock: vi.fn(),
  statMock: vi.fn(),
  lstatMock: vi.fn(),
  isPathInsideMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Vitest's typed importOriginal requires a module import type expression inside its hoisted mock factory.
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    opendir: opendirMock,
    stat: statMock,
    lstat: lstatMock,
  };
});

vi.mock('@opensip-cli/core', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Vitest's typed importOriginal requires a module import type expression inside its hoisted mock factory.
  const actual = await importOriginal<typeof import('@opensip-cli/core')>();
  return {
    ...actual,
    isPathInside: isPathInsideMock,
  };
});

import {
  TARGET_WALK_MAX_DEPTH,
  TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY,
  TARGET_WALK_MAX_FRONTIER_ENTRIES,
  TARGET_WALK_MAX_VISITED_DIRECTORIES,
  TARGET_WALK_MAX_VISITED_ENTRIES,
  compareTargetFilesystemEntries,
  walkTargetFilesystem,
} from '../filesystem-walk.js';

import type { Dir, Dirent, Stats } from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';

let root: string;

function entry(
  name: string,
  kind: 'directory' | 'file' | 'symlink' | 'block' | 'character' | 'fifo' | 'socket' | 'unknown',
): Dirent<string> {
  return {
    name,
    isBlockDevice: () => kind === 'block',
    isCharacterDevice: () => kind === 'character',
    isDirectory: () => kind === 'directory',
    isFIFO: () => kind === 'fifo',
    isFile: () => kind === 'file',
    isSocket: () => kind === 'socket',
    isSymbolicLink: () => kind === 'symlink',
  } as Dirent<string>;
}

function fakeDirectory(reads: readonly (Dirent<string> | null | Error)[]): Dir {
  let index = 0;
  return {
    read() {
      if (index >= reads.length) return Promise.resolve(null);
      const next = reads[index++];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    close() {
      return Promise.resolve(undefined);
    },
  } as unknown as Dir;
}

function fileStats(): Stats {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as Stats;
}

function directoryStats(options: { readonly symbolicLink?: boolean } = {}): Stats {
  return {
    isFile: () => false,
    isDirectory: () => options.symbolicLink !== true,
    isSymbolicLink: () => options.symbolicLink === true,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as Stats;
}

function otherStats(
  kind: 'block' | 'character' | 'fifo' | 'socket' | 'symlink' | 'file' | 'directory',
): Stats {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
    isBlockDevice: () => kind === 'block',
    isCharacterDevice: () => kind === 'character',
    isFIFO: () => kind === 'fifo',
    isSocket: () => kind === 'socket',
  } as Stats;
}

function enoent(pathLabel: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: ${pathLabel}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function enotdir(pathLabel: string): NodeJS.ErrnoException {
  const error = new Error(`ENOTDIR: ${pathLabel}`) as NodeJS.ErrnoException;
  error.code = 'ENOTDIR';
  return error;
}

/** Prefix check that works for synthetic mock paths without requiring realpath. */
function pathInsideByPrefix(child: string, parent: string): boolean {
  const normalizedParent = resolvePath(parent);
  const normalizedChild = resolvePath(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + sep);
}

function useRealFs(): void {
  opendirMock.mockImplementation(async (path: string, options?: { bufferSize?: number }) => {
    const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
    return actual.opendir(path, options);
  });
  statMock.mockImplementation(async (path: string) => {
    const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
    return actual.stat(path);
  });
  lstatMock.mockImplementation(async (path: string) => {
    const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
    return actual.lstat(path);
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-target-walk-'));
  opendirMock.mockReset();
  statMock.mockReset();
  lstatMock.mockReset();
  isPathInsideMock.mockReset();
  isPathInsideMock.mockImplementation(pathInsideByPrefix);
  useRealFs();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('compareTargetFilesystemEntries', () => {
  it('orders files before same-name directories via the slash-qualified key', () => {
    const entries = [
      { kind: 'directory' as const, name: 'pkg' },
      { kind: 'file' as const, name: 'pkg' },
      { kind: 'other' as const, name: 'pkg!' },
    ];
    // 'pkg' < 'pkg!' < 'pkg/' in code-point order (! is 0x21, / is 0x2F).
    expect([...entries].sort(compareTargetFilesystemEntries).map((item) => item.name)).toEqual([
      'pkg',
      'pkg!',
      'pkg',
    ]);
    expect(
      compareTargetFilesystemEntries(
        { kind: 'file', name: 'pkg' },
        { kind: 'directory', name: 'pkg' },
      ),
    ).toBeLessThan(0);
  });
});

describe('walkTargetFilesystem (real filesystem)', () => {
  it('enumerates regular files in code-point order and reports metrics', async () => {
    writeFileSync(join(root, 'b.ts'), '');
    writeFileSync(join(root, 'a.ts'), '');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested/c.ts'), '');

    const offered: string[] = [];
    const walk = await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
    });

    expect(offered).toEqual(['a.ts', 'b.ts', 'nested/c.ts']);
    expect(walk).toMatchObject({
      cancelled: false,
      capped: false,
      stoppedByVisitor: false,
    });
    expect(walk.metrics.visitedFiles).toBe(3);
    expect(walk.metrics.visitedDirectories).toBeGreaterThanOrEqual(2);
  });

  it('stops when the visitor returns false', async () => {
    writeFileSync(join(root, 'a.ts'), '');
    writeFileSync(join(root, 'b.ts'), '');
    const offered: string[] = [];

    const walk = await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
      return false;
    });

    expect(offered).toEqual(['a.ts']);
    expect(walk.stoppedByVisitor).toBe(true);
  });

  it('ignores common basenames for files and directory trees', async () => {
    writeFileSync(join(root, 'node_modules'), '');
    writeFileSync(join(root, 'dist'), '');
    writeFileSync(join(root, '.git'), '');
    mkdirSync(join(root, 'dir-node_modules'));
    writeFileSync(join(root, 'dir-node_modules/keep.ts'), '');
    mkdirSync(join(root, 'vendor_node_modules'));
    writeFileSync(join(root, 'vendor_node_modules/keep.ts'), '');
    mkdirSync(join(root, 'nested'));
    mkdirSync(join(root, 'nested/node_modules'));
    writeFileSync(join(root, 'nested/node_modules/x.ts'), '');
    mkdirSync(join(root, 'nested/dist'));
    writeFileSync(join(root, 'nested/dist/x.ts'), '');
    mkdirSync(join(root, 'nested/.git'));
    writeFileSync(join(root, 'nested/.git/x.ts'), '');
    writeFileSync(join(root, 'keep.ts'), '');

    const offered: string[] = [];
    await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
    });

    expect(offered).toEqual(['dir-node_modules/keep.ts', 'keep.ts', 'vendor_node_modules/keep.ts']);
  });

  it('honours an already-aborted signal without offering files', async () => {
    writeFileSync(join(root, 'a.ts'), '');
    const controller = new AbortController();
    controller.abort();

    const visitor = vi.fn();
    const walk = await walkTargetFilesystem(root, visitor, { signal: controller.signal });

    expect(walk).toEqual(
      expect.objectContaining({ cancelled: true, capped: false, stoppedByVisitor: false }),
    );
    expect(visitor).not.toHaveBeenCalled();
  });

  it('never follows directory symlinks', async () => {
    if (platform() === 'win32') return;
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real/value.ts'), '');
    symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir');

    const offered: string[] = [];
    await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
    });

    expect(offered).toEqual(['real/value.ts']);
  });

  it('skips a file that vanishes between directory read and stat, without capping', async () => {
    writeFileSync(join(root, 'a.ts'), '');
    writeFileSync(join(root, 'b.ts'), '');
    writeFileSync(join(root, 'c.ts'), '');
    const offered: string[] = [];

    const walk = await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
      if (relativePath === 'a.ts') rmSync(join(root, 'b.ts'));
    });

    // b.ts vanished before it could be stat'd: it is skipped, not capped, and
    // the walk continues past it to c.ts instead of abandoning the rest of the
    // tree (regression: a per-entry stat failure used to set `capped = true`,
    // which the main loop's `!state.capped` guard treated the same as a
    // genuine TARGET_WALK_MAX_* resource-bound truncation).
    expect(walk.capped).toBe(false);
    expect(offered).toEqual(['a.ts', 'c.ts']);
  });

  it('skips a dangling symlink and continues walking the rest of the tree without capping', async () => {
    if (platform() === 'win32') return;
    writeFileSync(join(root, 'a.ts'), '');
    symlinkSync(join(root, 'missing-target'), join(root, 'm-broken-link'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested/n.ts'), '');
    writeFileSync(join(root, 'z.ts'), '');
    const offered: string[] = [];

    const walk = await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
    });

    // `m-broken-link` sorts between `a.ts` and both `nested/` and `z.ts`;
    // its stat() ENOENT is skipped and the walk still reaches every regular
    // file that sorts after it, in a sibling directory or not.
    expect(offered).toEqual(['a.ts', 'nested/n.ts', 'z.ts']);
    expect(walk.capped).toBe(false);
    expect(walk.cancelled).toBe(false);
  });
});

describe('walkTargetFilesystem (mocked I/O)', () => {
  it('returns an empty complete walk when the root directory is missing', async () => {
    opendirMock.mockRejectedValueOnce(enoent(root));
    const visitor = vi.fn();

    const walk = await walkTargetFilesystem(root, visitor);

    expect(walk).toMatchObject({ cancelled: false, capped: false, stoppedByVisitor: false });
    expect(walk.metrics.visitedDirectories).toBe(1);
    expect(visitor).not.toHaveBeenCalled();
  });

  it('treats ENOTDIR on the root open as a missing root directory', async () => {
    opendirMock.mockRejectedValueOnce(enotdir(root));
    const walk = await walkTargetFilesystem(root, () => undefined);
    expect(walk).toMatchObject({ cancelled: false, capped: false });
  });

  it('rethrows unexpected opendir failures', async () => {
    opendirMock.mockRejectedValueOnce(new Error('EACCES denied'));
    await expect(walkTargetFilesystem(root, () => undefined)).rejects.toThrow(/EACCES/);
  });

  it('caps when a nested directory vanishes before open', async () => {
    opendirMock
      .mockResolvedValueOnce(fakeDirectory([entry('gone', 'directory'), null]))
      .mockRejectedValueOnce(enoent(join(root, 'gone')));
    lstatMock.mockResolvedValueOnce(directoryStats());

    const walk = await walkTargetFilesystem(root, () => undefined);

    // reserveDirectory runs before open; the failed nested open still counts.
    expect(walk).toMatchObject({
      capped: true,
      cancelled: false,
      stoppedByVisitor: false,
      metrics: { visitedDirectories: 2 },
    });
  });

  it('classifies special device nodes as other and skips them', async () => {
    opendirMock.mockResolvedValueOnce(
      fakeDirectory([
        entry('block-dev', 'block'),
        entry('char-dev', 'character'),
        entry('fifo-dev', 'fifo'),
        entry('socket-dev', 'socket'),
        entry('keep.ts', 'file'),
        null,
      ]),
    );
    statMock.mockResolvedValue(fileStats());

    const offered: string[] = [];
    const walk = await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
    });

    expect(offered).toEqual(['keep.ts']);
    expect(walk.capped).toBe(false);
  });

  it('classifies DT_UNKNOWN entries through lstat', async () => {
    opendirMock
      .mockResolvedValueOnce(
        fakeDirectory([
          entry('mystery-dir', 'unknown'),
          entry('mystery-file', 'unknown'),
          entry('mystery-link', 'unknown'),
          entry('mystery-other', 'unknown'),
          null,
        ]),
      )
      .mockResolvedValueOnce(fakeDirectory([null]));
    lstatMock
      .mockResolvedValueOnce(otherStats('directory'))
      .mockResolvedValueOnce(otherStats('file'))
      .mockResolvedValueOnce(otherStats('symlink'))
      .mockResolvedValueOnce(otherStats('socket'))
      .mockResolvedValueOnce(directoryStats());
    statMock.mockResolvedValue(fileStats());

    const offered: string[] = [];
    const walk = await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
    });

    expect(offered).toEqual(['mystery-file', 'mystery-link']);
    expect(walk.capped).toBe(false);
    expect(walk.metrics.visitedDirectories).toBe(2);
  });

  it('caps when DT_UNKNOWN lstat fails', async () => {
    opendirMock.mockResolvedValueOnce(fakeDirectory([entry('vanished', 'unknown'), null]));
    lstatMock.mockRejectedValueOnce(enoent('vanished'));

    const walk = await walkTargetFilesystem(root, () => undefined);

    expect(walk.capped).toBe(true);
    expect(walk.metrics.visitedFiles).toBe(0);
  });

  it('caps when directory lstat fails during entry visit', async () => {
    opendirMock.mockResolvedValueOnce(fakeDirectory([entry('sub', 'directory'), null]));
    lstatMock.mockRejectedValueOnce(enoent('sub'));

    const walk = await walkTargetFilesystem(root, () => undefined);

    expect(walk.capped).toBe(true);
  });

  it('skips file candidates that fail the root-containment check', async () => {
    opendirMock.mockResolvedValueOnce(fakeDirectory([entry('escape.ts', 'symlink'), null]));
    statMock.mockResolvedValueOnce(fileStats());
    isPathInsideMock.mockReturnValue(false);

    const offered: string[] = [];
    const walk = await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
    });

    expect(offered).toEqual([]);
    expect(walk.capped).toBe(false);
  });

  it('stops mid-batch when the abort signal fires after a directory read', async () => {
    const controller = new AbortController();
    const reads: (Dirent<string> | null)[] = [entry('a.ts', 'file'), entry('b.ts', 'file'), null];
    let readCount = 0;
    opendirMock.mockResolvedValueOnce({
      read() {
        const value = reads[readCount++] ?? null;
        if (readCount === 1) controller.abort();
        return Promise.resolve(value);
      },
      close() {
        return Promise.resolve(undefined);
      },
    });

    const walk = await walkTargetFilesystem(root, () => undefined, { signal: controller.signal });

    expect(walk.cancelled).toBe(true);
    expect(walk.metrics.visitedFiles).toBe(0);
  });

  it('cancels after stat when the abort signal fires during file validation', async () => {
    const controller = new AbortController();
    opendirMock.mockResolvedValueOnce(fakeDirectory([entry('a.ts', 'file'), null]));
    statMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(fileStats());
    });

    const visitor = vi.fn();
    const walk = await walkTargetFilesystem(root, visitor, { signal: controller.signal });

    expect(walk.cancelled).toBe(true);
    expect(visitor).not.toHaveBeenCalled();
  });

  it('cancels after lstat when the abort signal fires during directory validation', async () => {
    const controller = new AbortController();
    opendirMock.mockResolvedValueOnce(fakeDirectory([entry('sub', 'directory'), null]));
    lstatMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(directoryStats());
    });

    const walk = await walkTargetFilesystem(root, () => undefined, { signal: controller.signal });

    expect(walk.cancelled).toBe(true);
  });

  it('cancels after lstat when the abort signal fires during DT_UNKNOWN classification', async () => {
    const controller = new AbortController();
    opendirMock.mockResolvedValueOnce(fakeDirectory([entry('mystery', 'unknown'), null]));
    lstatMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(otherStats('file'));
    });

    const walk = await walkTargetFilesystem(root, () => undefined, { signal: controller.signal });

    expect(walk.cancelled).toBe(true);
  });

  it('caps when the per-walk visited directory ceiling is reached', async () => {
    const rootEntries = Array.from({ length: 4096 }, (_, index) =>
      entry(`d${String(index).padStart(4, '0')}`, 'directory'),
    );
    const emptyChildEntries = Array.from({ length: 12 }, (_, index) =>
      entry(`c${String(index).padStart(2, '0')}`, 'directory'),
    );
    const resolvedRoot = resolvePath(root);

    opendirMock.mockImplementation((directoryPath: string) => {
      const normalized = resolvePath(directoryPath);
      if (normalized === resolvedRoot) {
        return Promise.resolve(fakeDirectory([...rootEntries, null]));
      }
      const base = normalized.slice(resolvedRoot.length + 1).replaceAll('\\', '/');
      if (!base.includes('/') && base.startsWith('d')) {
        return Promise.resolve(fakeDirectory([...emptyChildEntries, null]));
      }
      return Promise.resolve(fakeDirectory([null]));
    });
    lstatMock.mockResolvedValue(directoryStats());

    const walk = await walkTargetFilesystem(root, () => undefined);

    expect(walk.capped).toBe(true);
    expect(walk.metrics.visitedDirectories).toBe(TARGET_WALK_MAX_VISITED_DIRECTORIES);
  }, 60_000);

  it('caps when pushing a directory batch would exceed the frontier ceiling', async () => {
    const levels = Math.ceil(
      TARGET_WALK_MAX_FRONTIER_ENTRIES / TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY,
    );
    const resolvedRoot = resolvePath(root);

    opendirMock.mockImplementation((directoryPath: string) => {
      const normalized = resolvePath(directoryPath);
      const relative =
        normalized === resolvedRoot
          ? ''
          : normalized.slice(resolvedRoot.length + 1).replaceAll('\\', '/');
      const depth = relative.length === 0 ? 0 : relative.split('/').length;

      if (depth < levels) {
        const children = Array.from({ length: TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY }, (_, index) =>
          entry(`n${String(index).padStart(4, '0')}`, 'directory'),
        );
        return Promise.resolve(fakeDirectory([...children, null]));
      }
      return Promise.resolve(fakeDirectory([null]));
    });
    lstatMock.mockResolvedValue(directoryStats());

    const walk = await walkTargetFilesystem(root, () => undefined);

    expect(walk.capped).toBe(true);
    expect(walk.metrics.peakFrontierEntries).toBeLessThanOrEqual(TARGET_WALK_MAX_FRONTIER_ENTRIES);
  }, 120_000);

  it('caps when the aggregate visited-entry ceiling is reached', async () => {
    const directoriesNeeded = Math.ceil(
      (TARGET_WALK_MAX_VISITED_ENTRIES + 1) / TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY,
    );
    const rootDirs = Array.from({ length: directoriesNeeded }, (_, index) =>
      entry(`bucket-${String(index).padStart(4, '0')}`, 'directory'),
    );
    const fullBatch = Array.from({ length: TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY }, (_, index) =>
      entry(`f${String(index).padStart(4, '0')}.ts`, 'file'),
    );
    const resolvedRoot = resolvePath(root);

    opendirMock.mockImplementation((directoryPath: string) => {
      if (resolvePath(directoryPath) === resolvedRoot) {
        return Promise.resolve(fakeDirectory([...rootDirs, null]));
      }
      return Promise.resolve(fakeDirectory([...fullBatch, null]));
    });
    lstatMock.mockResolvedValue(directoryStats());
    statMock.mockResolvedValue(fileStats());

    const walk = await walkTargetFilesystem(root, () => undefined);

    expect(walk.capped).toBe(true);
    expect(walk.metrics.visitedEntries).toBe(TARGET_WALK_MAX_VISITED_ENTRIES);
  }, 120_000);

  it('caps when child depth would exceed the maximum', async () => {
    let openCount = 0;
    opendirMock.mockImplementation(() => {
      openCount += 1;
      // Always expose one deeper directory until the depth guard trips.
      return Promise.resolve(fakeDirectory([entry('deep', 'directory'), null]));
    });
    lstatMock.mockResolvedValue(directoryStats());

    const walk = await walkTargetFilesystem(root, () => undefined);

    expect(walk.capped).toBe(true);
    expect(openCount).toBe(TARGET_WALK_MAX_DEPTH + 1);
  });

  it('skips directory symlink targets during visit (lstat reports symlink)', async () => {
    opendirMock.mockResolvedValueOnce(fakeDirectory([entry('linked-dir', 'directory'), null]));
    lstatMock.mockResolvedValueOnce(directoryStats({ symbolicLink: true }));

    const walk = await walkTargetFilesystem(root, () => undefined);

    expect(walk.capped).toBe(false);
    expect(walk.metrics.visitedDirectories).toBe(1);
  });

  it('yields to the event loop at the checkpoint interval without losing work', async () => {
    const entries = Array.from({ length: 130 }, (_, index) =>
      entry(`${String(index).padStart(3, '0')}.ts`, 'file'),
    );
    for (const item of entries) {
      writeFileSync(join(root, item.name), '');
    }
    useRealFs();
    opendirMock.mockResolvedValueOnce(fakeDirectory([...entries, null]));

    const offered: string[] = [];
    const walk = await walkTargetFilesystem(root, ({ relativePath }) => {
      offered.push(relativePath);
    });

    expect(offered).toHaveLength(130);
    expect(walk.capped).toBe(false);
  });

  it('ignores isMissingDirectory for non-object and non-ENOENT codes via root open', async () => {
    opendirMock.mockRejectedValueOnce('string-error');
    await expect(walkTargetFilesystem(root, () => undefined)).rejects.toBe('string-error');

    opendirMock.mockRejectedValueOnce({ message: 'no code' });
    await expect(walkTargetFilesystem(root, () => undefined)).rejects.toEqual({
      message: 'no code',
    });

    opendirMock.mockRejectedValueOnce({ code: 'EPERM' });
    await expect(walkTargetFilesystem(root, () => undefined)).rejects.toEqual({ code: 'EPERM' });
  });
});
