/**
 * @fileoverview Proven local host/process incarnation facts for cooperative locks.
 *
 * Hostnames and PIDs are reusable labels. These helpers expose only bounded,
 * hashed identities derived from platform boot and process-start facts. Unknown
 * platforms or ambiguous probes deliberately return unproven/unknown results.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import { platform } from 'node:os';

const MAX_IDENTITY_FACT_BYTES = 4096;
const IDENTITY_HEX_LENGTH = 32;

function boundedIdentityFact(value: string | undefined): string | undefined {
  const normalized = value?.trim().normalize('NFC');
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > MAX_IDENTITY_FACT_BYTES
  ) {
    return undefined;
  }
  return normalized;
}

function digestIdentity(kind: string, value: string): string {
  return `${kind}:${createHash('sha256').update(value).digest('hex').slice(0, IDENTITY_HEX_LENGTH)}`;
}

function digestProcessIdentity(value: string): string {
  // A compact 96-bit marker keeps the eight-entry runtime writer queue within
  // its fixed 4 KiB record bound even when every other field is maximal.
  return `p${createHash('sha256').update(value).digest('base64url').slice(0, 16)}`;
}

interface BoundedIdentityFileOptions {
  /**
   * Preserve ENOENT for callers where a missing file is positive evidence.
   * Other probe failures remain safety-biased and degrade to `undefined`.
   */
  readonly rethrowMissing?: boolean;
}

function readBoundedIdentityFile(
  path: string,
  options: BoundedIdentityFileOptions = {},
): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IDENTITY_FACT_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_IDENTITY_FACT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return bytesRead > MAX_IDENTITY_FACT_BYTES ? undefined : buffer.toString('utf8', 0, bytesRead);
  } catch (error) {
    if (options.rethrowMissing === true && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw error;
    }
    // @swallow-ok Host identity probing is read-only and degrades to an explicitly unproven identity.
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // @swallow-ok Identity discovery is read-only and degrades to unproven.
      }
    }
  }
}

export interface DerivedHostIdentity {
  readonly id: string;
  readonly proven: boolean;
}

export function deriveHostIdentity(
  hostnameValue: string,
  hostInstanceIdentity: string | undefined,
): DerivedHostIdentity {
  const safeHostname = hostnameValue.normalize('NFC') || 'unknown-host';
  const instanceIdentity = boundedIdentityFact(hostInstanceIdentity);
  const proven = instanceIdentity !== undefined;
  const material = proven ? `proven:${instanceIdentity}` : `unproven:${safeHostname}`;
  return {
    id: createHash('sha256').update(material).digest('hex').slice(0, IDENTITY_HEX_LENGTH),
    proven,
  };
}

export function detectHostInstanceIdentity(): string | undefined {
  try {
    if (platform() === 'linux') {
      const bootId = boundedIdentityFact(
        readBoundedIdentityFile('/proc/sys/kernel/random/boot_id'),
      );
      const pidNamespace = boundedIdentityFact(readlinkSync('/proc/self/ns/pid'));
      if (bootId === undefined || pidNamespace === undefined) return undefined;
      return digestIdentity('linux-host', `${bootId}:${pidNamespace}`);
    }
    if (platform() === 'darwin') {
      const bootSessionUuid = boundedIdentityFact(
        execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
          encoding: 'utf8',
          maxBuffer: MAX_IDENTITY_FACT_BYTES,
          timeout: 1000,
        }),
      );
      return bootSessionUuid === undefined
        ? undefined
        : digestIdentity('darwin-host', bootSessionUuid);
    }
  } catch {
    // @swallow-ok Missing platform identity facts deliberately degrade to unproven.
    return undefined;
  }
  return undefined;
}

function lazyHostInstanceIdentity(): () => string | undefined {
  let resolved = false;
  let identity: string | undefined;
  return () => {
    if (!resolved) {
      identity = detectHostInstanceIdentity();
      resolved = true;
    }
    return identity;
  };
}

export const defaultHostInstanceIdentity = lazyHostInstanceIdentity();

export type ProcessIncarnationInspection =
  | {
      readonly status: 'present';
      readonly identity: string;
    }
  | {
      readonly status: 'absent';
    }
  | {
      readonly status: 'unknown';
    };

export interface SafetyBiasedProcessInspector {
  /**
   * Return a short-lived cached positive/unknown observation when available.
   * Absence is never cached because it may authorize destructive stale cleanup.
   */
  readonly inspect: (pid: number) => ProcessIncarnationInspection;
  /** Always invoke the underlying probe. Use immediately before stale cleanup. */
  readonly inspectFresh: (pid: number) => ProcessIncarnationInspection;
}

export interface SafetyBiasedProcessInspectorOptions {
  readonly inspect: (pid: number) => ProcessIncarnationInspection;
  readonly monotonicNow: () => number;
  readonly ttlMs: number;
  /** Maximum retained positive/unknown observations. Defaults to 256. */
  readonly maxEntries?: number;
}

/**
 * Bound repeated live-process probes without turning a cached result into
 * deletion authority. Positive and unknown observations may delay reclamation;
 * an absent observation is always fresh and never retained.
 */
export function createSafetyBiasedProcessInspector({
  inspect,
  monotonicNow,
  ttlMs,
  maxEntries = 256,
}: SafetyBiasedProcessInspectorOptions): SafetyBiasedProcessInspector {
  const boundedTtlMs = Number.isFinite(ttlMs) ? Math.max(0, Math.floor(ttlMs)) : 0;
  const boundedMaxEntries = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 256;
  const cache = new Map<
    number,
    {
      readonly inspection: Exclude<ProcessIncarnationInspection, { readonly status: 'absent' }>;
      readonly expiresAt: number;
    }
  >();

  const inspectFresh = (pid: number): ProcessIncarnationInspection => {
    const inspection = inspect(pid);
    if (inspection.status === 'absent') {
      cache.delete(pid);
    } else {
      cache.delete(pid);
      cache.set(pid, {
        inspection,
        expiresAt: monotonicNow() + boundedTtlMs,
      });
      while (cache.size > boundedMaxEntries) {
        const oldestPid = cache.keys().next().value;
        if (oldestPid === undefined) break;
        cache.delete(oldestPid);
      }
    }
    return inspection;
  };

  return Object.freeze({
    inspect: (pid: number): ProcessIncarnationInspection => {
      const now = monotonicNow();
      const cached = cache.get(pid);
      if (cached !== undefined && now < cached.expiresAt) {
        return cached.inspection;
      }
      return inspectFresh(pid);
    },
    inspectFresh,
  });
}

function processProbeAfterFailure(pid: number): ProcessIncarnationInspection {
  try {
    process.kill(pid, 0);
    return { status: 'unknown' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? { status: 'absent' }
      : { status: 'unknown' };
  }
}

function linuxProcessIncarnation(pid: number): ProcessIncarnationInspection {
  try {
    const raw = readBoundedIdentityFile(`/proc/${pid}/stat`, {
      rethrowMissing: true,
    });
    if (raw === undefined) return { status: 'unknown' };
    const commandEnd = raw.lastIndexOf(')');
    if (commandEnd < 0) return { status: 'unknown' };
    // Fields after the parenthesized command begin with field 3 (state).
    // Process start time is field 22, therefore index 19 in this suffix.
    const startTime = raw
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u)[19];
    if (startTime === undefined || !/^\d+$/u.test(startTime)) {
      return { status: 'unknown' };
    }
    return {
      status: 'present',
      identity: digestProcessIdentity(`linux:${startTime}`),
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unknown' };
  }
}

function darwinProcessIncarnation(pid: number): ProcessIncarnationInspection {
  try {
    const started = boundedIdentityFact(
      execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { LC_ALL: 'C', TZ: 'UTC' },
        maxBuffer: MAX_IDENTITY_FACT_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }),
    );
    return started === undefined
      ? processProbeAfterFailure(pid)
      : {
          status: 'present',
          identity: digestProcessIdentity(`darwin:${started}`),
        };
  } catch {
    return processProbeAfterFailure(pid);
  }
}

function inspectProcessIncarnationUncached(pid: number): ProcessIncarnationInspection {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'absent' };
  if (platform() === 'linux') return linuxProcessIncarnation(pid);
  if (platform() === 'darwin') return darwinProcessIncarnation(pid);
  return processProbeAfterFailure(pid);
}

const ownPid = process.pid;
let ownProcessIncarnation: ProcessIncarnationInspection | undefined;

export function inspectProcessIncarnation(pid: number): ProcessIncarnationInspection {
  if (pid !== ownPid) return inspectProcessIncarnationUncached(pid);
  ownProcessIncarnation ??= inspectProcessIncarnationUncached(pid);
  return ownProcessIncarnation;
}
