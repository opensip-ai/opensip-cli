import { compareBoundedTargets } from './inventory-file-model.js';
import { collectAllTargets, targetFileResolution } from './inventory-target-collection.js';
import { projectBoundedTargets } from './inventory-target-metadata.js';

import type { PendingFile, TargetFileResolution } from './inventory-file-model.js';
import type { InventoryLimits, ProjectInventoryInput } from './types.js';
import type { BoundedTargetResolver } from '@opensip-cli/core';

export async function resolveTargetFiles(
  projectRoot: string,
  input: ProjectInventoryInput,
  limits: InventoryLimits,
  structural: readonly PendingFile[],
  boundedResolver: BoundedTargetResolver | undefined,
): Promise<TargetFileResolution> {
  const pendingByPath = new Map(
    structural.map((candidate) => [
      candidate.relativePath,
      { ...candidate, targets: [...candidate.targets] },
    ]),
  );
  if (input.targets === undefined) {
    return targetFileResolution(pendingByPath, ['targets-unavailable'], false, input.signal);
  }
  if (boundedResolver === undefined) {
    return targetFileResolution(
      pendingByPath,
      ['bounded-target-resolution-unavailable'],
      false,
      input.signal,
    );
  }
  const reasons = new Set<string>();
  const fatalReasons = new Set<string>();
  const projection = projectBoundedTargets(boundedResolver, reasons, fatalReasons);
  if (projection.status === 'invalid') {
    return targetFileResolution(pendingByPath, ['target-metadata-invalid'], false, input.signal);
  }
  if (projection.status === 'capped') {
    return targetFileResolution(pendingByPath, ['target-count-cap-reached'], false, input.signal);
  }
  const targets = projection.targets;
  targets.sort(compareBoundedTargets);
  if (fatalReasons.size > 0) {
    return targetFileResolution(
      pendingByPath,
      new Set([...reasons, ...fatalReasons]),
      false,
      input.signal,
    );
  }
  if (targets.length === 0) {
    return targetFileResolution(
      pendingByPath,
      reasons.size === 0 ? ['targets-empty'] : reasons,
      false,
      input.signal,
    );
  }

  const available = await collectAllTargets(targets, {
    resolver: boundedResolver,
    projectRoot,
    input,
    limits,
    pendingByPath,
    reasons,
  });
  return targetFileResolution(pendingByPath, reasons, available, input.signal);
}
