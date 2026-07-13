import { byCodePoint, deepFreeze } from './freeze.js';

import type { FactProvenance, FileRole } from '@opensip-cli/contracts';
import type { TargetView } from '@opensip-cli/core';

/** Closed role labels and provenance evidence derived for one inventory file. */
export interface FileRoleClassification {
  readonly roles: readonly FileRole[];
  readonly provenance: readonly FactProvenance[];
}

/** One bounded, pre-tokenized target projection used by inventory classification. */
export interface FileRoleTargetProjection {
  readonly name: string;
  readonly roles: readonly FileRole[];
  readonly literalConventionPaths: readonly string[];
}

interface FileRoleTargetProjectionInput {
  readonly name: string;
  readonly tags: readonly string[];
  readonly concerns: readonly string[];
  readonly hasLanguage: boolean;
  readonly conventionPaths: readonly string[];
}

const ROLE_TOKENS: Readonly<Record<Exclude<FileRole, 'unknown'>, ReadonlySet<string>>> = {
  production: new Set([
    'api',
    'app',
    'backend',
    'client',
    'frontend',
    'lib',
    'library',
    'prod',
    'production',
    'server',
    'source',
    'src',
  ]),
  test: new Set(['e2e', 'integration', 'spec', 'test', 'tests', 'testing']),
  configuration: new Set(['config', 'configuration', 'tooling']),
  documentation: new Set(['doc', 'docs', 'documentation']),
  generated: new Set(['codegen', 'generated']),
  build: new Set(['build', 'compile', 'packaging']),
};

function splitTokens(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function addRolesForTokens(tokens: readonly string[], roles: Set<FileRole>): void {
  for (const [role, expected] of Object.entries(ROLE_TOKENS) as readonly [
    Exclude<FileRole, 'unknown'>,
    ReadonlySet<string>,
  ][]) {
    if (tokens.some((token) => expected.has(token))) roles.add(role);
  }
}

function literalConventionPath(pattern: string): string | undefined {
  if (/[?*{}[\]]/u.test(pattern)) return undefined;
  return pattern.replace(/^\.\//u, '');
}

/** Exhaustive label projection keeps the closed role vocabulary reviewable. */
function roleLabel(role: FileRole): FileRole {
  switch (role) {
    case 'production':
    case 'test':
    case 'configuration':
    case 'documentation':
    case 'generated':
    case 'build':
    case 'unknown': {
      return role;
    }
    default: {
      const unreachable: never = role;
      return unreachable;
    }
  }
}

/**
 * Build the compact role evidence inventory carries for one target.
 *
 * Callers on bounded paths must validate the supplied array and string limits
 * before invoking this projection. No raw target metadata is retained.
 */
export function buildFileRoleTargetProjection(
  input: FileRoleTargetProjectionInput,
): FileRoleTargetProjection {
  const roles = new Set<FileRole>();
  for (const value of [input.name, ...input.tags, ...input.concerns]) {
    addRolesForTokens(splitTokens(value), roles);
  }
  if (roles.size === 0 && input.hasLanguage) roles.add('production');
  const literalConventionPaths = [
    ...new Set(
      input.conventionPaths
        .map(literalConventionPath)
        .filter((path): path is string => path !== undefined),
    ),
  ].sort(byCodePoint);
  return deepFreeze({
    name: input.name,
    roles: [...roles].map(roleLabel).sort(byCodePoint),
    literalConventionPaths,
  });
}

function hasLiteralConventionPath(paths: readonly string[], relativePath: string): boolean {
  let lower = 0;
  let upper = paths.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = paths[middle];
    if (candidate === undefined) return false;
    const comparison = byCodePoint(candidate, relativePath);
    if (comparison === 0) return true;
    if (comparison < 0) lower = middle + 1;
    else upper = middle - 1;
  }
  return false;
}

/** Classify one file from already bounded, pre-tokenized target evidence. */
export function classifyProjectedFileRoles(
  relativePath: string,
  targets: readonly FileRoleTargetProjection[],
): FileRoleClassification {
  const roles = new Set<FileRole>();
  const provenance = new Map<string, FactProvenance>();
  for (const target of targets) {
    for (const role of target.roles) roles.add(role);
    provenance.set(
      `target:${target.name}`,
      deepFreeze({ source: 'target', detail: `target:${target.name}` }),
    );
    if (hasLiteralConventionPath(target.literalConventionPaths, relativePath)) {
      roles.add('production');
      provenance.set(
        `convention:${target.name}`,
        deepFreeze({
          source: 'convention',
          detail: `target-convention:${target.name}`,
        }),
      );
    }
  }
  if (roles.size === 0) {
    roles.add('unknown');
    provenance.set('unknown', deepFreeze({ source: 'filesystem', detail: 'role-unclassified' }));
  } else {
    roles.delete('unknown');
  }
  return deepFreeze({
    roles: [...roles].map(roleLabel).sort(byCodePoint),
    provenance: [...provenance.values()].sort((left, right) =>
      byCodePoint(`${left.source}:${left.detail}`, `${right.source}:${right.detail}`),
    ),
  });
}

function conventionPaths(target: TargetView): readonly string[] {
  const conventions = target.config.conventions;
  return [
    ...(conventions?.entrypoints ?? []),
    ...(conventions?.alwaysUsed ?? []),
    ...(conventions?.usedExports?.map((entry) => entry.file) ?? []),
  ];
}

/**
 * Classify a file only from target metadata and explicit target conventions.
 * File-name/path heuristics are intentionally absent: an unlabelled file is
 * `unknown`, not guessed to be source or test code.
 */
export function classifyFileRoles(
  relativePath: string,
  targets: readonly TargetView[],
): FileRoleClassification {
  return classifyProjectedFileRoles(
    relativePath,
    targets.map((target) =>
      buildFileRoleTargetProjection({
        name: target.config.name,
        tags: target.config.tags ?? [],
        concerns: target.config.concerns ?? [],
        hasLanguage: (target.config.languages?.length ?? 0) > 0,
        conventionPaths: conventionPaths(target),
      }),
    ),
  );
}
