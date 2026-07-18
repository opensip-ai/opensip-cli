import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { projectCoordinationKey } from '@opensip-cli/core';

import {
  runtimePromotionPathSnapshot,
  sameRuntimePromotionPathSnapshot,
  type RuntimePromotionPathSnapshot,
} from './runtime-promotion-path-snapshot.js';
import { RuntimePromotionPreflightError } from './runtime-promotion-preflight-error.js';

import type { RuntimeExclusiveLease, RuntimeExclusivePosture } from '@opensip-cli/core';

const CHANGED_AFTER_PREFLIGHT = 'changed-after-preflight' as const;

interface RuntimePromotionFreshProjectRootToken {
  readonly projectRoot: string;
  readonly coordinationKey: string;
  readonly projectRootSnapshot: RuntimePromotionPathSnapshot;
  readonly destinationParentDir: string;
  readonly destinationParent: RuntimePromotionPathSnapshot;
}

/**
 * Attempt-local project-root identity. It deliberately stays out of the
 * path-stable journal and ignores directory timestamps that owned child
 * mutations legitimately change.
 */
export interface RuntimePromotionProjectRootAuthority {
  readonly version: 1;
  readonly projectRoot: string;
  readonly coordinationKey: string;
  readonly leasePosture: Extract<RuntimeExclusivePosture, 'normal' | 'init-recovery'>;
  readonly identity: {
    readonly dev: string;
    readonly ino: string;
    readonly uid: string;
    readonly mode: string;
  };
  /**
   * Attempt-local identity for a destination parent that existed at authority
   * capture time. A null binding deliberately permits the operation-owned
   * absent -> created transition; created parents are instead bound by their
   * journal-derived owner marker.
   */
  readonly destinationParent: {
    readonly path: string;
    readonly identity: {
      readonly dev: string;
      readonly ino: string;
      readonly uid: string;
      readonly mode: string;
    };
  } | null;
}

function assertLease(
  lease: RuntimeExclusiveLease,
  coordinationKey: string,
  posture: RuntimePromotionProjectRootAuthority['leasePosture'],
): void {
  if (
    lease.kind !== 'runtime-exclusive' ||
    lease.posture !== posture ||
    lease.coordinationKey !== coordinationKey
  ) {
    throw new RuntimePromotionPreflightError('lease-mismatch');
  }
}

function projectRootAuthorityIdentity(
  snapshot: RuntimePromotionPathSnapshot,
): RuntimePromotionProjectRootAuthority['identity'] | undefined {
  if (snapshot.presence !== 'directory' || snapshot.identity === undefined) return undefined;
  return {
    dev: snapshot.identity.dev,
    ino: snapshot.identity.ino,
    uid: snapshot.identity.uid,
    mode: snapshot.identity.mode,
  };
}

function sameProjectRootAuthority(
  expected: RuntimePromotionProjectRootAuthority,
  observed: RuntimePromotionPathSnapshot,
): boolean {
  return sameAuthorityIdentity(expected.identity, observed);
}

function sameAuthorityIdentity(
  expected: RuntimePromotionProjectRootAuthority['identity'],
  observed: RuntimePromotionPathSnapshot,
): boolean {
  const identity = projectRootAuthorityIdentity(observed);
  return (
    identity?.dev === expected.dev &&
    identity.ino === expected.ino &&
    identity.uid === expected.uid &&
    identity.mode === expected.mode
  );
}

function destinationParentAuthority(
  projectRoot: string,
  snapshot: RuntimePromotionPathSnapshot,
): RuntimePromotionProjectRootAuthority['destinationParent'] {
  if (snapshot.presence === 'absent') return null;
  const identity = projectRootAuthorityIdentity(snapshot);
  if (identity === undefined) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  return {
    path: join(projectRoot, 'opensip-cli'),
    identity,
  };
}

function canonicalProjectRootUnchanged(projectRoot: string, coordinationKey: string): boolean {
  try {
    const canonical = realpathSync(projectRoot);
    return canonical === projectRoot && projectCoordinationKey(canonical) === coordinationKey;
  } catch {
    return false;
  }
}

/** Bind a current exact root after the caller has validated its operation context. */
export function captureRuntimePromotionProjectRootAuthority(input: {
  readonly lease: RuntimeExclusiveLease;
  readonly projectRoot: string;
  readonly expectedPosture: RuntimePromotionProjectRootAuthority['leasePosture'];
}): RuntimePromotionProjectRootAuthority {
  assertLease(input.lease, input.lease.coordinationKey, input.expectedPosture);
  let canonical: string;
  try {
    canonical = realpathSync(input.projectRoot);
  } catch {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  const snapshot = runtimePromotionPathSnapshot(canonical);
  const identity = projectRootAuthorityIdentity(snapshot);
  if (
    identity === undefined ||
    canonical !== input.projectRoot ||
    projectCoordinationKey(canonical) !== input.lease.coordinationKey
  ) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  const destinationParent = destinationParentAuthority(
    canonical,
    runtimePromotionPathSnapshot(join(canonical, 'opensip-cli')),
  );
  return Object.freeze({
    version: 1,
    projectRoot: canonical,
    coordinationKey: input.lease.coordinationKey,
    leasePosture: input.expectedPosture,
    identity,
    destinationParent,
  });
}

/**
 * Bind a recovery attempt without accidentally promoting an operation-created
 * destination parent into attempt-local preexisting authority.
 */
export function captureRuntimePromotionRecoveryProjectRootAuthority(input: {
  readonly lease: RuntimeExclusiveLease;
  readonly projectRoot: string;
  readonly destinationParentPreexisting: boolean;
}): RuntimePromotionProjectRootAuthority {
  const authority = captureRuntimePromotionProjectRootAuthority({
    lease: input.lease,
    projectRoot: input.projectRoot,
    expectedPosture: 'init-recovery',
  });
  if (input.destinationParentPreexisting && authority.destinationParent === null) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  if (input.destinationParentPreexisting || authority.destinationParent === null) {
    return authority;
  }
  return Object.freeze({
    ...authority,
    destinationParent: null,
  });
}

/**
 * Capture the exact root selected by fresh preflight for this in-memory
 * attempt. Recovery must bind a new authority after validating its journal.
 */
export function bindRuntimePromotionFreshProjectRootAuthority(input: {
  readonly lease: RuntimeExclusiveLease;
  readonly token: RuntimePromotionFreshProjectRootToken;
}): RuntimePromotionProjectRootAuthority {
  assertLease(input.lease, input.token.coordinationKey, 'normal');
  const identity = projectRootAuthorityIdentity(input.token.projectRootSnapshot);
  if (
    identity === undefined ||
    !canonicalProjectRootUnchanged(input.token.projectRoot, input.token.coordinationKey) ||
    !sameRuntimePromotionPathSnapshot(
      input.token.projectRootSnapshot,
      runtimePromotionPathSnapshot(input.token.projectRoot),
    ) ||
    input.token.destinationParentDir !== join(input.token.projectRoot, 'opensip-cli')
  ) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  const authority = captureRuntimePromotionProjectRootAuthority({
    lease: input.lease,
    projectRoot: input.token.projectRoot,
    expectedPosture: 'normal',
  });
  if (!sameProjectRootAuthority(authority, input.token.projectRootSnapshot)) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  if (
    !sameRuntimePromotionPathSnapshot(
      input.token.destinationParent,
      runtimePromotionPathSnapshot(input.token.destinationParentDir),
    ) ||
    (authority.destinationParent === null
      ? input.token.destinationParent.presence !== 'absent'
      : !sameAuthorityIdentity(authority.destinationParent.identity, input.token.destinationParent))
  ) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  return authority;
}

/**
 * Reassert attempt-local root authority at every root-dependent boundary.
 * dev/ino/uid/mode are stable while owned descendants may change timestamps.
 */
export function assertRuntimePromotionProjectRootAuthority(input: {
  readonly lease: RuntimeExclusiveLease;
  readonly authority: RuntimePromotionProjectRootAuthority;
}): void {
  assertLease(input.lease, input.authority.coordinationKey, input.authority.leasePosture);
  if (
    !canonicalProjectRootUnchanged(input.authority.projectRoot, input.authority.coordinationKey) ||
    !sameProjectRootAuthority(
      input.authority,
      runtimePromotionPathSnapshot(input.authority.projectRoot),
    )
  ) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  if (
    input.authority.destinationParent !== null &&
    !sameAuthorityIdentity(
      input.authority.destinationParent.identity,
      runtimePromotionPathSnapshot(input.authority.destinationParent.path),
    )
  ) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
}

/**
 * Reassert the exact fresh-attempt root before entering a root-dependent
 * phase. The authored and filesystem layers then pin that same identity for
 * the duration of their individual calls.
 */
export function assertFreshRuntimePromotionProjectRoot(operation: {
  readonly dependencies: {
    readonly assertProjectRootAuthority: (input: {
      readonly lease: RuntimeExclusiveLease;
      readonly authority: RuntimePromotionProjectRootAuthority;
    }) => void;
  };
  readonly lease: RuntimeExclusiveLease;
  readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
}): void {
  operation.dependencies.assertProjectRootAuthority({
    lease: operation.lease,
    authority: operation.projectRootAuthority,
  });
}
