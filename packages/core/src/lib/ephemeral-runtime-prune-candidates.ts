/**
 * Fail-closed candidate discovery and revalidation for ephemeral cache pruning.
 *
 * This module grants no deletion authority unless marker identity, project
 * presence, directory identity, and bounded enumeration all remain stable.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, opendirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  parseEphemeralMarker,
  type EphemeralMarker,
  type EphemeralMarkerReadResult,
} from './ephemeral-runtime-marker.js';
import { projectCoordinationKey } from './paths.js';
import { readAnchoredRecord } from './runtime-lease.js';

import type { BigIntStats } from 'node:fs';

export const CACHE_KEY_PATTERN = /^[a-f0-9]{24}$/u;
export const PRUNE_PASS_BUDGET_MS = 1000;
const MAX_PRUNE_SCAN_ENTRIES = 1024;
const CACHE_PERMISSION_POSTURE = 'owner-controlled' as const;

export interface PruneDeadline {
  readonly expiresAt: number;
  readonly monotonicNow: () => number;
}

export function remainingBudget(deadline: PruneDeadline, cap: number): number {
  return Math.max(0, Math.min(cap, Math.floor(deadline.expiresAt - deadline.monotonicNow())));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissingFsError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Enumerate cache-entry directories through a hard entry cap.
 *
 * `undefined` means the scan could not prove a complete view.
 */
export function listPruneEntries(root: string): string[] | undefined {
  let directory;
  try {
    directory = opendirSync(root);
  } catch (error) {
    return isMissingFsError(error) ? [] : undefined;
  }
  const entries: string[] = [];
  let inspected = 0;
  let complete = true;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      inspected += 1;
      if (inspected > MAX_PRUNE_SCAN_ENTRIES) {
        complete = false;
        break;
      }
      if (entry.isDirectory()) entries.push(entry.name);
    }
  } catch {
    // @swallow-ok the flag IS the surfaced degradation — an incomplete listing returns `undefined`, and prune treats that as "do not prune" rather than "nothing to prune"
    complete = false;
  }
  try {
    directory.closeSync();
  } catch {
    // @swallow-ok same: a close failure makes the listing untrustworthy, and the caller must not prune on it
    complete = false;
  }
  return complete ? entries : undefined;
}

export type PruneVerdict = 'orphaned' | 'stale' | 'keep';
type ProjectPresence = 'present' | 'absent' | 'uncertain';

function inspectProjectPresence(projectDir: string): ProjectPresence {
  try {
    const stat = lstatSync(projectDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'uncertain';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'uncertain';
  }
  try {
    realpathSync(projectDir);
    return 'present';
  } catch {
    return 'uncertain';
  }
}

function classifyEntry(
  projectPresence: Exclude<ProjectPresence, 'uncertain'>,
  usedAt: number,
  now: number,
  maxAgeMs: number,
): PruneVerdict {
  if (projectPresence === 'absent') return 'orphaned';
  if (now - usedAt > maxAgeMs) return 'stale';
  return 'keep';
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface PruneCandidate {
  readonly key: string;
  readonly entryDir: string;
  readonly projectDir: string;
  readonly coordinationKey: string;
  readonly usedAt: number;
  readonly markerSha256: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly verdict: PruneVerdict;
}

function directoryIdentity(stat: BigIntStats): DirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function expectedCurrentCacheKey(marker: EphemeralMarker): string {
  if (marker.identityStrength === 'path-only') return marker.canonicalRootDigest.slice(0, 24);
  return sha256(
    `opensip-ephemeral-cache-v2\0${marker.canonicalRootDigest}\0${marker.generationDigest}`,
  ).slice(0, 24);
}

function markerCoordinationProof(
  key: string,
  marker: EphemeralMarkerReadResult,
): { readonly projectDir: string; readonly coordinationKey: string } | undefined {
  if (marker.status === 'current') {
    if (sha256(marker.marker.projectDir) !== marker.marker.canonicalRootDigest) return;
    const coordinationKey = marker.marker.canonicalRootDigest.slice(0, 24);
    if (
      key !== expectedCurrentCacheKey(marker.marker) ||
      projectCoordinationKey(marker.marker.projectDir) !== coordinationKey
    ) {
      return;
    }
    return { projectDir: marker.marker.projectDir, coordinationKey };
  }
  if (marker.status !== 'legacy') return;
  const coordinationKey = projectCoordinationKey(marker.marker.projectDir);
  if (key !== coordinationKey) return;
  return { projectDir: marker.marker.projectDir, coordinationKey };
}

export function inspectPruneCandidate(
  root: string,
  key: string,
  now: number,
  maxAgeMs: number,
): PruneCandidate | undefined {
  if (!CACHE_KEY_PATTERN.test(key)) return;
  const entryDir = join(root, key);
  try {
    const before = lstatSync(entryDir, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return;
    const observed = readAnchoredRecord({
      trustedAnchorDir: root,
      parentDir: entryDir,
      basename: EPHEMERAL_MARKER_FILE,
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: CACHE_PERMISSION_POSTURE,
    });
    if (observed.status !== 'present') return;
    const marker = parseEphemeralMarker(observed.content);
    if (marker.status !== 'current' && marker.status !== 'legacy') return;
    const proof = markerCoordinationProof(key, marker);
    if (proof === undefined) return;
    const projectPresence = inspectProjectPresence(proof.projectDir);
    if (projectPresence === 'uncertain') return;
    const after = lstatSync(entryDir, { bigint: true });
    const beforeIdentity = directoryIdentity(before);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameDirectoryIdentity(beforeIdentity, directoryIdentity(after))
    ) {
      return;
    }
    const usedAt = Date.parse(marker.marker.lastUsedAt);
    return {
      key,
      entryDir,
      ...proof,
      usedAt,
      markerSha256: observed.sha256,
      directoryIdentity: beforeIdentity,
      verdict: classifyEntry(projectPresence, usedAt, now, maxAgeMs),
    };
  } catch {
    // @swallow-ok Candidate inspection is fail-closed; an unprovable entry receives no deletion authority.
    return;
  }
}

export function sameCandidateSnapshot(left: PruneCandidate, right: PruneCandidate): boolean {
  return (
    left.key === right.key &&
    left.projectDir === right.projectDir &&
    left.coordinationKey === right.coordinationKey &&
    left.usedAt === right.usedAt &&
    left.markerSha256 === right.markerSha256 &&
    sameDirectoryIdentity(left.directoryIdentity, right.directoryIdentity)
  );
}

export function compareCandidatesByAge(left: PruneCandidate, right: PruneCandidate): number {
  return left.usedAt - right.usedAt || left.key.localeCompare(right.key);
}

export function revalidateOverflowCandidate(
  root: string,
  candidate: PruneCandidate,
  keep: number,
  now: number,
  maxAgeMs: number,
  deadline: PruneDeadline,
): PruneCandidate | undefined {
  const keys = listPruneEntries(root);
  if (keys === undefined || keys.length <= keep) return;
  const currentCandidates: PruneCandidate[] = [];
  for (const key of keys) {
    if (remainingBudget(deadline, PRUNE_PASS_BUDGET_MS) <= 0) return;
    const current = inspectPruneCandidate(root, key, now, maxAgeMs);
    if (current === undefined) return;
    currentCandidates.push(current);
  }
  currentCandidates.sort(compareCandidatesByAge);
  const oldest = currentCandidates.slice(0, keys.length - keep);
  const current = oldest.find((entry) => entry.key === candidate.key);
  if (current === undefined || !sameCandidateSnapshot(candidate, current)) return;
  return current;
}

export function removeRevalidatedCandidate(candidate: PruneCandidate): boolean {
  try {
    const immediatelyBefore = lstatSync(candidate.entryDir, { bigint: true });
    if (
      !immediatelyBefore.isDirectory() ||
      immediatelyBefore.isSymbolicLink() ||
      !sameDirectoryIdentity(candidate.directoryIdentity, directoryIdentity(immediatelyBefore))
    ) {
      return false;
    }
    rmSync(candidate.entryDir, { recursive: true });
    return !existsSync(candidate.entryDir);
  } catch {
    // @swallow-ok Failed revalidation preserves the cache entry instead of granting deletion authority.
    return false;
  }
}
