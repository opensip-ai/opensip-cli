import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_MARKER_VERSION,
  isValidEphemeralTimestamp,
  parseEphemeralMarker,
  readEphemeralMarker,
} from '../ephemeral-runtime-marker.js';

import type * as NodeFs from 'node:fs';

type MarkerScenario =
  | 'normal'
  | 'entry-not-directory'
  | 'entry-error'
  | 'marker-error'
  | 'descriptor-not-file'
  | 'descriptor-oversize'
  | 'read-overflow'
  | 'read-error'
  | 'open-error'
  | 'close-error';

interface MarkerProbe {
  scenario: MarkerScenario;
  raw: string;
  closeCalls: number;
}

const markerProbe = vi.hoisted<MarkerProbe>(() => ({
  scenario: 'normal',
  raw: JSON.stringify({
    projectDir: '/project',
    lastUsedAt: '2026-07-19T12:00:00.000Z',
  }),
  closeCalls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const stats = (kind: 'directory' | 'file', size = 0): NodeFs.Stats =>
    ({
      isDirectory: () => kind === 'directory',
      isFile: () => kind === 'file',
      size,
    }) as NodeFs.Stats;
  const fsError = (code: string): NodeJS.ErrnoException => {
    const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };
  return {
    ...actual,
    lstatSync: ((path: NodeFs.PathLike) => {
      const markerPath = String(path).endsWith('/project.json');
      if (!markerPath && markerProbe.scenario === 'entry-error') throw fsError('EACCES');
      if (markerPath && markerProbe.scenario === 'marker-error') throw fsError('EACCES');
      if (!markerPath) {
        return stats(markerProbe.scenario === 'entry-not-directory' ? 'file' : 'directory');
      }
      return stats('file', Buffer.byteLength(markerProbe.raw));
    }) as typeof actual.lstatSync,
    openSync: (() => {
      if (markerProbe.scenario === 'open-error') throw fsError('EIO');
      return 91;
    }) as typeof actual.openSync,
    fstatSync: (() => {
      if (markerProbe.scenario === 'descriptor-not-file') return stats('directory');
      if (markerProbe.scenario === 'descriptor-oversize') {
        return stats('file', EPHEMERAL_MARKER_MAX_BYTES + 1);
      }
      return stats('file', Buffer.byteLength(markerProbe.raw));
    }) as unknown as typeof actual.fstatSync,
    readSync: ((_fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (markerProbe.scenario === 'read-error') throw fsError('EIO');
      const source =
        markerProbe.scenario === 'read-overflow'
          ? Buffer.alloc(EPHEMERAL_MARKER_MAX_BYTES + 1, 'x')
          : Buffer.from(markerProbe.raw);
      const count = Math.min(length, Math.max(0, source.length - position));
      if (count > 0) source.copy(buffer, offset, position, position + count);
      return count;
    }) as typeof actual.readSync,
    closeSync: (() => {
      markerProbe.closeCalls += 1;
      if (markerProbe.scenario === 'close-error') throw fsError('EIO');
    }) as typeof actual.closeSync,
  };
});

describe('ephemeral marker descriptor guards', () => {
  beforeEach(() => {
    markerProbe.scenario = 'normal';
    markerProbe.raw = JSON.stringify({
      projectDir: '/project',
      lastUsedAt: '2026-07-19T12:00:00.000Z',
    });
    markerProbe.closeCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid timestamp and marker projections', () => {
    expect(isValidEphemeralTimestamp(123)).toBe(false);
    expect(
      parseEphemeralMarker(
        JSON.stringify({
          version: EPHEMERAL_MARKER_VERSION,
          projectDir: '',
          canonicalRootDigest: 'a'.repeat(64),
          identityStrength: 'path-only',
          lastUsedAt: '2026-07-19T12:00:00.000Z',
        }),
      ),
    ).toEqual({ status: 'invalid', reason: 'malformed' });
    expect(parseEphemeralMarker('{}')).toEqual({
      status: 'invalid',
      reason: 'malformed',
    });
  });

  it.each<MarkerScenario>(['entry-not-directory', 'entry-error', 'marker-error'])(
    'fails closed during %s preflight',
    (scenario) => {
      markerProbe.scenario = scenario;

      expect(readEphemeralMarker('/entry')).toEqual({
        status: 'invalid',
        reason: 'unreadable',
      });
    },
  );

  it.each([
    ['descriptor-not-file', 'unreadable'],
    ['descriptor-oversize', 'oversize'],
    ['read-overflow', 'oversize'],
    ['read-error', 'unreadable'],
    ['open-error', 'unreadable'],
  ] as const)('fails closed for a %s descriptor transition', (scenario, reason) => {
    markerProbe.scenario = scenario;

    expect(readEphemeralMarker('/entry')).toEqual({
      status: 'invalid',
      reason,
    });
    if (scenario !== 'open-error') expect(markerProbe.closeCalls).toBe(1);
  });

  it('preserves a valid bounded result when descriptor close fails', () => {
    markerProbe.scenario = 'close-error';

    expect(readEphemeralMarker('/entry')).toEqual({
      status: 'legacy',
      marker: {
        projectDir: '/project',
        lastUsedAt: '2026-07-19T12:00:00.000Z',
      },
    });
    expect(markerProbe.closeCalls).toBe(1);
  });
});
