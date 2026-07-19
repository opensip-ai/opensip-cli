import { mkdtempSync, rmSync, writeFileSync, type OpenMode, type PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultHostInstanceIdentity,
  deriveHostIdentity,
  detectHostInstanceIdentity,
  inspectProcessIncarnation,
} from '../host-process-identity.js';

import type * as NodeChildProcess from 'node:child_process';
import type * as NodeFs from 'node:fs';
import type * as NodeOs from 'node:os';

interface HostProbe {
  platform: NodeJS.Platform;
  pathOverrides: Map<string, string>;
  readlinks: Map<string, string | Error>;
  execResult: string | Error;
  closeFailures: number;
}

const hostProbe = vi.hoisted<HostProbe>(() => ({
  platform: 'linux',
  pathOverrides: new Map<string, string>(),
  readlinks: new Map<string, string | Error>(),
  execResult: '',
  closeFailures: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    openSync: ((path: PathLike, flags: OpenMode) => {
      const effectivePath = hostProbe.pathOverrides.get(String(path)) ?? path;
      return actual.openSync(effectivePath, flags);
    }) as typeof actual.openSync,
    closeSync: ((fd: number) => {
      actual.closeSync(fd);
      if (hostProbe.closeFailures > 0) {
        hostProbe.closeFailures -= 1;
        throw new Error('injected close failure');
      }
    }) as typeof actual.closeSync,
    readlinkSync: ((path: PathLike) => {
      const result = hostProbe.readlinks.get(String(path));
      if (result instanceof Error) throw result;
      if (result !== undefined) return result;
      return actual.readlinkSync(path);
    }) as typeof actual.readlinkSync,
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return {
    ...actual,
    platform: () => hostProbe.platform,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    execFileSync: (() => {
      if (hostProbe.execResult instanceof Error) throw hostProbe.execResult;
      return hostProbe.execResult;
    }) as unknown as typeof actual.execFileSync,
  };
});

describe('host process identity probes', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'host-process-identity-'));
    hostProbe.platform = 'linux';
    hostProbe.pathOverrides.clear();
    hostProbe.readlinks.clear();
    hostProbe.execResult = '';
    hostProbe.closeFailures = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture(name: string, contents: string): string {
    const path = join(directory, name);
    writeFileSync(path, contents);
    return path;
  }

  function linuxStat(startTime: string): string {
    return `123 (worker with ) parenthesis) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${startTime}`;
  }

  it('derives a proven Linux host identity from bounded boot and namespace facts', () => {
    const bootPath = fixture('boot-id', ' boot-session-id \n');
    hostProbe.pathOverrides.set('/proc/sys/kernel/random/boot_id', bootPath);
    hostProbe.readlinks.set('/proc/self/ns/pid', 'pid:[4026531836]');

    const detected = detectHostInstanceIdentity();
    expect(detected).toMatch(/^linux-host:[0-9a-f]{32}$/u);
    expect(deriveHostIdentity('build-host', detected)).toMatchObject({
      proven: true,
    });

    const lazyFirst = defaultHostInstanceIdentity();
    hostProbe.pathOverrides.set(
      '/proc/sys/kernel/random/boot_id',
      fixture('replacement-boot-id', 'replacement'),
    );
    expect(defaultHostInstanceIdentity()).toBe(lazyFirst);
  });

  it('degrades malformed or unavailable Linux host facts without throwing', () => {
    hostProbe.readlinks.set('/proc/self/ns/pid', 'pid:[1]');

    hostProbe.pathOverrides.set('/proc/sys/kernel/random/boot_id', directory);
    expect(detectHostInstanceIdentity()).toBeUndefined();

    hostProbe.pathOverrides.set(
      '/proc/sys/kernel/random/boot_id',
      fixture('oversized-boot-id', 'x'.repeat(4097)),
    );
    expect(detectHostInstanceIdentity()).toBeUndefined();

    hostProbe.pathOverrides.set('/proc/sys/kernel/random/boot_id', join(directory, 'missing'));
    expect(detectHostInstanceIdentity()).toBeUndefined();

    hostProbe.pathOverrides.set(
      '/proc/sys/kernel/random/boot_id',
      fixture('valid-boot-id', 'valid-boot'),
    );
    hostProbe.closeFailures = 1;
    expect(detectHostInstanceIdentity()).toMatch(/^linux-host:/u);

    hostProbe.readlinks.set('/proc/self/ns/pid', new Error('unavailable namespace'));
    expect(detectHostInstanceIdentity()).toBeUndefined();
  });

  it('reads a valid Linux process start marker and rejects ambiguous stat records', () => {
    const validPid = 810_001;
    hostProbe.pathOverrides.set(
      `/proc/${validPid}/stat`,
      fixture('valid-stat', linuxStat('98765')),
    );
    expect(inspectProcessIncarnation(validPid)).toMatchObject({
      status: 'present',
    });

    const missingDelimiterPid = 810_002;
    hostProbe.pathOverrides.set(
      `/proc/${missingDelimiterPid}/stat`,
      fixture('missing-delimiter-stat', 'not a proc stat record'),
    );
    expect(inspectProcessIncarnation(missingDelimiterPid)).toEqual({
      status: 'unknown',
    });

    const invalidStartPid = 810_003;
    hostProbe.pathOverrides.set(
      `/proc/${invalidStartPid}/stat`,
      fixture('invalid-start-stat', linuxStat('not-a-number')),
    );
    expect(inspectProcessIncarnation(invalidStartPid)).toEqual({
      status: 'unknown',
    });

    const truncatedPid = 810_004;
    hostProbe.pathOverrides.set(
      `/proc/${truncatedPid}/stat`,
      fixture('truncated-stat', '123 (worker) S 1 2'),
    );
    expect(inspectProcessIncarnation(truncatedPid)).toEqual({
      status: 'unknown',
    });

    const unavailablePid = 810_005;
    hostProbe.pathOverrides.set(`/proc/${unavailablePid}/stat`, directory);
    expect(inspectProcessIncarnation(unavailablePid)).toEqual({
      status: 'unknown',
    });
  });

  it('classifies a missing Linux proc stat file as positive process absence', () => {
    const missingPid = 810_006;
    hostProbe.pathOverrides.set(`/proc/${missingPid}/stat`, join(directory, 'missing-stat'));

    expect(inspectProcessIncarnation(missingPid)).toEqual({ status: 'absent' });
  });

  it('covers Darwin and fallback probes with safety-biased process results', () => {
    hostProbe.platform = 'darwin';
    hostProbe.execResult = 'Mon Jul 14 12:34:56 2025\n';
    expect(detectHostInstanceIdentity()).toMatch(/^darwin-host:[0-9a-f]{32}$/u);
    expect(inspectProcessIncarnation(820_001)).toMatchObject({
      status: 'present',
    });

    hostProbe.execResult = '';
    const liveProbe = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(inspectProcessIncarnation(820_002)).toEqual({ status: 'unknown' });
    expect(liveProbe).toHaveBeenCalledWith(820_002, 0);

    hostProbe.execResult = new Error('ps unavailable');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('missing process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });
    expect(inspectProcessIncarnation(820_003)).toEqual({ status: 'absent' });

    hostProbe.platform = 'freebsd';
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('probe denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });
    expect(inspectProcessIncarnation(820_004)).toEqual({ status: 'unknown' });
    expect(detectHostInstanceIdentity()).toBeUndefined();
    expect(inspectProcessIncarnation(0)).toEqual({ status: 'absent' });
    expect(inspectProcessIncarnation(Number.NaN)).toEqual({ status: 'absent' });
  });

  it('uses a stable unproven identity when no instance fact exists', () => {
    const first = deriveHostIdentity('', undefined);
    const second = deriveHostIdentity('', ' '.repeat(10));

    expect(first).toEqual(second);
    expect(first.proven).toBe(false);
    expect(first.id).toMatch(/^[0-9a-f]{32}$/u);
  });
});
