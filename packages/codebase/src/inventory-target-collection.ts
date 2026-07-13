import { toPosixRelative } from '@opensip-cli/core';

import { byCodePoint } from './freeze.js';
import {
  INVENTORY_BATCH_SIZE,
  INVENTORY_CANCELLED_REASON,
  cancelled,
  yieldToEventLoop,
} from './inventory-helpers.js';
import { canonicalFile } from './inventory-structural.js';
import {
  asBoundedTargetMembershipResolver,
  invokeBoundedTargetMembershipResolution,
  invokeBoundedTargetResolution,
} from './target-resolver-bounds.js';

import type { BoundedTarget, PendingFile, TargetFileResolution } from './inventory-file-model.js';
import type { InventoryLimits, ProjectInventoryInput } from './types.js';
import type { BoundedTargetResolution, BoundedTargetResolver } from '@opensip-cli/core';

export interface TargetResolutionContext {
  readonly resolver: BoundedTargetResolver;
  readonly projectRoot: string;
  readonly input: ProjectInventoryInput;
  readonly limits: InventoryLimits;
  readonly pendingByPath: Map<string, PendingFile>;
  readonly reasons: Set<string>;
}

export function targetFileResolution(
  pendingByPath: ReadonlyMap<string, PendingFile>,
  reasons: readonly string[] | ReadonlySet<string>,
  available: boolean,
  signal: AbortSignal | undefined,
): TargetFileResolution {
  const qualifiedReasons = new Set(reasons);
  if (signal?.aborted === true) qualifiedReasons.add(INVENTORY_CANCELLED_REASON);
  return {
    pending: [...pendingByPath.values()].sort((left, right) =>
      byCodePoint(left.relativePath, right.relativePath),
    ),
    reasons: [...qualifiedReasons].sort(byCodePoint),
    available,
  };
}

function addTargetMembership(
  pending: PendingFile,
  target: BoundedTarget,
  limit: number,
  reasons: Set<string>,
): void {
  if (pending.targets.some((candidate) => candidate.name === target.name)) return;
  if (pending.targets.length >= limit) {
    reasons.add('target-membership-cap-reached');
    return;
  }
  pending.targets.push(target);
}

async function resolveOneTarget(
  target: BoundedTarget,
  context: TargetResolutionContext,
): Promise<BoundedTargetResolution | undefined> {
  const resolved = await invokeBoundedTargetResolution(
    () =>
      context.resolver.resolveTargetsBounded([target.name], context.projectRoot, {
        maxResults: context.limits.files,
        signal: context.input.signal,
      }),
    context.limits.files,
    context.reasons,
    {
      failure: 'target-resolution-failed',
      invalid: 'bounded-target-resolution-invalid',
    },
    context.input.signal,
  );
  if (resolved === undefined) return undefined;
  return {
    ...resolved,
    files: [...resolved.files].sort((left, right) =>
      byCodePoint(
        toPosixRelative(context.projectRoot, left),
        toPosixRelative(context.projectRoot, right),
      ),
    ),
  };
}

async function collectTargetMemberships(
  resolved: readonly string[],
  target: BoundedTarget,
  context: TargetResolutionContext,
): Promise<boolean> {
  for (const [index, filePath] of resolved.entries()) {
    if (index > 0 && index % INVENTORY_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
    if (cancelled(context.input.signal, context.reasons)) return false;
    const canonical = canonicalFile(filePath, context.projectRoot, context.input.projectRoot);
    if (canonical === undefined) {
      context.reasons.add('file-outside-root-or-unreadable');
      continue;
    }
    const existing = context.pendingByPath.get(canonical.relativePath);
    if (existing !== undefined) {
      addTargetMembership(existing, target, context.limits.targetsPerFile, context.reasons);
      continue;
    }
    if (context.pendingByPath.size >= context.limits.files) {
      context.reasons.add('file-cap-reached');
      return false;
    }
    context.pendingByPath.set(canonical.relativePath, {
      ...canonical,
      targets: [target],
    });
  }
  return true;
}

async function collectOneTarget(
  target: BoundedTarget,
  context: TargetResolutionContext,
): Promise<boolean> {
  if (cancelled(context.input.signal, context.reasons)) return false;
  const resolved = await resolveOneTarget(target, context);
  if (resolved === undefined) return true;
  if (resolved.capped) context.reasons.add('file-cap-reached');
  if (resolved.cancelled) {
    context.reasons.add(INVENTORY_CANCELLED_REASON);
    return false;
  }
  if (!(await collectTargetMemberships(resolved.files, target, context))) return false;
  if (resolved.capped) return false;
  await yieldToEventLoop();
  return !cancelled(context.input.signal, context.reasons);
}

function collectBatchedMembershipRow(
  membership: { readonly filePath: string; readonly targetNames: readonly string[] },
  targetByName: ReadonlyMap<string, BoundedTarget>,
  context: TargetResolutionContext,
): boolean {
  const canonical = canonicalFile(
    membership.filePath,
    context.projectRoot,
    context.input.projectRoot,
  );
  if (canonical === undefined) {
    context.reasons.add('file-outside-root-or-unreadable');
    return true;
  }
  let pending = context.pendingByPath.get(canonical.relativePath);
  if (pending === undefined) {
    if (context.pendingByPath.size >= context.limits.files) {
      context.reasons.add('file-cap-reached');
      return false;
    }
    pending = { ...canonical, targets: [] };
    context.pendingByPath.set(canonical.relativePath, pending);
  }
  for (const targetName of membership.targetNames) {
    const target = targetByName.get(targetName);
    if (target !== undefined) {
      addTargetMembership(pending, target, context.limits.targetsPerFile, context.reasons);
    }
  }
  return true;
}

async function collectBatchedMembershipRows(
  memberships: readonly { readonly filePath: string; readonly targetNames: readonly string[] }[],
  targetByName: ReadonlyMap<string, BoundedTarget>,
  context: TargetResolutionContext,
): Promise<void> {
  const sorted = [...memberships].sort((left, right) =>
    byCodePoint(
      toPosixRelative(context.projectRoot, left.filePath),
      toPosixRelative(context.projectRoot, right.filePath),
    ),
  );
  for (const [index, membership] of sorted.entries()) {
    if (index > 0 && index % INVENTORY_BATCH_SIZE === 0) await yieldToEventLoop();
    if (cancelled(context.input.signal, context.reasons)) return;
    if (!collectBatchedMembershipRow(membership, targetByName, context)) return;
  }
}

async function collectBatchedTargetMemberships(
  targets: readonly BoundedTarget[],
  context: TargetResolutionContext,
): Promise<boolean> {
  if (cancelled(context.input.signal, context.reasons)) return true;
  const resolver = asBoundedTargetMembershipResolver(context.resolver);
  if (resolver === undefined) {
    context.reasons.add('bounded-target-membership-resolution-unavailable');
    return false;
  }
  if (cancelled(context.input.signal, context.reasons)) return true;
  const targetByName = new Map(targets.map((target) => [target.name, target]));
  const expectedTargetNames = new Set(targetByName.keys());
  const resolved = await invokeBoundedTargetMembershipResolution({
    expectedTargetNames,
    invoke: () =>
      resolver.resolveTargetMembershipsBounded([...expectedTargetNames], context.projectRoot, {
        maxResults: context.limits.files,
        maxTargetsPerFile: context.limits.targetsPerFile,
        signal: context.input.signal,
      }),
    maximumFiles: context.limits.files,
    maximumTargetsPerFile: context.limits.targetsPerFile,
    reasonCodes: {
      failure: 'target-membership-resolution-failed',
      invalid: 'bounded-target-membership-resolution-invalid',
    },
    reasons: context.reasons,
    signal: context.input.signal,
  });
  if (resolved === undefined) return true;
  if (resolved.capped) context.reasons.add('file-cap-reached');
  if (resolved.membershipCapped) context.reasons.add('target-membership-cap-reached');
  if (resolved.cancelled) {
    context.reasons.add(INVENTORY_CANCELLED_REASON);
    return true;
  }
  await collectBatchedMembershipRows(resolved.memberships, targetByName, context);
  return true;
}

export async function collectAllTargets(
  targets: readonly BoundedTarget[],
  context: TargetResolutionContext,
): Promise<boolean> {
  if (targets.length > 1) return collectBatchedTargetMemberships(targets, context);
  // @sequential-ok — targets share one deterministic file/membership budget;
  // parallel resolution would race cap ownership and change retained evidence.
  for (const target of targets) {
    if (!(await collectOneTarget(target, context))) break;
  }
  return true;
}
