import { toPosixRelative, tryCatch } from '@opensip-cli/core';

import { byCodePoint } from './freeze.js';
import {
  compareBoundedTargets,
  type BoundedTarget,
  type PendingFile,
  type TargetFileResolution,
} from './inventory-file-model.js';
import {
  CONTROL_CHARACTER,
  INVENTORY_BATCH_SIZE,
  cancelled,
  yieldToEventLoop,
} from './inventory-helpers.js';
import { canonicalFile } from './inventory-structural.js';
import { MAX_FILE_LANGUAGES, MAX_TARGET_NAME } from './types.js';

import type { InventoryLimits, ProjectInventoryInput } from './types.js';
import type { TargetResolver, TargetView } from '@opensip-cli/core';

function boundedTarget(target: TargetView, reasons: Set<string>): BoundedTarget | undefined {
  const name = target.config.name;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_TARGET_NAME ||
    CONTROL_CHARACTER.test(name)
  ) {
    reasons.add('target-name-invalid');
    return undefined;
  }
  const languages = new Set<string>();
  for (const language of target.config.languages ?? []) {
    if (
      typeof language !== 'string' ||
      language.length === 0 ||
      language.length > MAX_TARGET_NAME ||
      CONTROL_CHARACTER.test(language)
    ) {
      reasons.add('target-language-invalid');
      continue;
    }
    languages.add(language);
  }
  const sortedLanguages = [...languages].sort(byCodePoint);
  if (sortedLanguages.length > MAX_FILE_LANGUAGES) {
    reasons.add('file-language-cap-reached');
  }
  return {
    view: target,
    name,
    languages: sortedLanguages.slice(0, MAX_FILE_LANGUAGES),
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

function resolveOneTarget(
  resolver: TargetResolver,
  target: BoundedTarget,
  projectRoot: string,
  reasons: Set<string>,
): readonly string[] | undefined {
  const resolved = tryCatch(() => {
    const targetFiles = resolver.resolveTargets([target.name], projectRoot);
    const filtered = resolver.applyGlobalExcludes(targetFiles, projectRoot);
    return [...filtered].sort((left, right) =>
      byCodePoint(toPosixRelative(projectRoot, left), toPosixRelative(projectRoot, right)),
    );
  });
  if (!resolved.ok) {
    reasons.add('target-resolution-failed');
    return undefined;
  }
  return resolved.value;
}

async function collectTargetMemberships(
  resolved: readonly string[],
  target: BoundedTarget,
  projectRoot: string,
  input: ProjectInventoryInput,
  limits: InventoryLimits,
  pendingByPath: Map<string, PendingFile>,
  reasons: Set<string>,
): Promise<boolean> {
  for (const [index, filePath] of resolved.entries()) {
    if (index > 0 && index % INVENTORY_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
    if (cancelled(input.signal, reasons)) return false;
    const canonical = canonicalFile(filePath, projectRoot, input.projectRoot);
    if (canonical === undefined) {
      reasons.add('file-outside-root-or-unreadable');
      continue;
    }
    const existing = pendingByPath.get(canonical.relativePath);
    if (existing !== undefined) {
      addTargetMembership(existing, target, limits.targetsPerFile, reasons);
      continue;
    }
    if (pendingByPath.size >= limits.files) {
      reasons.add('file-cap-reached');
      return false;
    }
    pendingByPath.set(canonical.relativePath, {
      ...canonical,
      targets: [target],
    });
  }
  return true;
}

export async function resolveTargetFiles(
  projectRoot: string,
  input: ProjectInventoryInput,
  limits: InventoryLimits,
  structural: readonly PendingFile[],
): Promise<TargetFileResolution> {
  const pendingByPath = new Map(
    structural.map((candidate) => [
      candidate.relativePath,
      { ...candidate, targets: [...candidate.targets] },
    ]),
  );
  const resolver = input.targets;
  if (resolver === undefined) {
    return {
      pending: [...pendingByPath.values()],
      reasons: ['targets-unavailable'],
      available: false,
    };
  }
  const reasons = new Set<string>();
  const targetViews = tryCatch(() => resolver.getAll());
  if (!targetViews.ok) {
    return {
      pending: [...pendingByPath.values()],
      reasons: ['target-resolution-failed'],
      available: false,
    };
  }
  const targets = targetViews.value
    .map((target) => boundedTarget(target, reasons))
    .filter((target): target is BoundedTarget => target !== undefined)
    .sort(compareBoundedTargets);
  if (targets.length === 0) {
    return {
      pending: [...pendingByPath.values()],
      reasons: reasons.size === 0 ? ['targets-empty'] : [...reasons].sort(byCodePoint),
      available: false,
    };
  }

  for (const target of targets) {
    if (cancelled(input.signal, reasons)) break;
    const resolved = resolveOneTarget(resolver, target, projectRoot, reasons);
    if (resolved === undefined) continue;
    if (
      !(await collectTargetMemberships(
        resolved,
        target,
        projectRoot,
        input,
        limits,
        pendingByPath,
        reasons,
      ))
    )
      break;
    await yieldToEventLoop();
    if (cancelled(input.signal, reasons)) break;
  }
  return {
    pending: [...pendingByPath.values()].sort((left, right) =>
      byCodePoint(left.relativePath, right.relativePath),
    ),
    reasons: [...reasons].sort(byCodePoint),
    available: true,
  };
}
