import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { opendirMock } = vi.hoisted(() => ({ opendirMock: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Vitest's typed importOriginal requires a module import type expression inside its hoisted mock factory.
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, opendir: opendirMock };
});

import { walkManifestFilesystem } from './manifest-filesystem-walk.js';

import type { Dir, Dirent } from 'node:fs';

let root: string;

function directoryEntry(name: string): Dirent<string> {
  return {
    name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => true,
    isFIFO: () => false,
    isFile: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as Dirent<string>;
}

function fakeDirectory(input: {
  readonly close: () => Promise<void>;
  readonly read: () => Promise<Dirent<string> | null>;
}): Dir {
  return input as unknown as Dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-manifest-walk-errors-'));
  opendirMock.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('manifest filesystem I/O failures', () => {
  it('discards an incomplete directory batch when read rejects', async () => {
    const read = vi
      .fn<() => Promise<Dirent<string> | null>>()
      .mockResolvedValueOnce(directoryEntry('unprocessed'))
      .mockRejectedValueOnce(new Error('simulated read failure'));
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    opendirMock.mockResolvedValue(fakeDirectory({ read, close }));
    const visitor = vi.fn();

    const result = await walkManifestFilesystem(root, 12, () => true, visitor);

    expect(result).toMatchObject({
      cancelled: false,
      capped: true,
      readFailed: true,
      stoppedByVisitor: false,
      metrics: { visitedDirectories: 1, visitedEntries: 1 },
    });
    expect(opendirMock).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
    expect(visitor).not.toHaveBeenCalled();
  });

  it('stops before processing a complete batch when close rejects', async () => {
    const read = vi
      .fn<() => Promise<Dirent<string> | null>>()
      .mockResolvedValueOnce(directoryEntry('unprocessed'))
      .mockResolvedValueOnce(null);
    const close = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('close failure'));
    opendirMock.mockResolvedValue(fakeDirectory({ read, close }));
    const visitor = vi.fn();

    const result = await walkManifestFilesystem(root, 12, () => true, visitor);

    expect(result).toMatchObject({
      cancelled: false,
      capped: true,
      readFailed: true,
      stoppedByVisitor: false,
      metrics: { visitedDirectories: 1, visitedEntries: 1 },
    });
    expect(opendirMock).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
    expect(visitor).not.toHaveBeenCalled();
  });
});
