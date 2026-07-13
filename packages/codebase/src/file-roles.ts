import { byCodePoint, deepFreeze } from './freeze.js';

import type { FactProvenance, FileRole } from '@opensip-cli/contracts';
import type { TargetView } from '@opensip-cli/core';

/** Closed role labels and provenance evidence derived for one inventory file. */
export interface FileRoleClassification {
  readonly roles: readonly FileRole[];
  readonly provenance: readonly FactProvenance[];
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

function literalConventionMatches(relativePath: string, pattern: string): boolean {
  return !/[?*{}[\]]/u.test(pattern) && pattern.replace(/^\.\//u, '') === relativePath;
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
 * Classify a file only from target metadata and explicit target conventions.
 * File-name/path heuristics are intentionally absent: an unlabelled file is
 * `unknown`, not guessed to be source or test code.
 */
export function classifyFileRoles(
  relativePath: string,
  targets: readonly TargetView[],
): FileRoleClassification {
  const roles = new Set<FileRole>();
  const provenance = new Map<string, FactProvenance>();
  for (const target of targets) {
    const { config } = target;
    const metadata = [config.name, ...(config.tags ?? []), ...(config.concerns ?? [])];
    const targetRoles = new Set<FileRole>();
    addRolesForTokens(metadata.flatMap(splitTokens), targetRoles);
    if (targetRoles.size === 0 && (config.languages?.length ?? 0) > 0) {
      targetRoles.add('production');
    }
    for (const role of targetRoles) roles.add(role);
    provenance.set(
      `target:${config.name}`,
      deepFreeze({ source: 'target', detail: `target:${config.name}` }),
    );

    const conventions = config.conventions;
    const conventionPaths = [
      ...(conventions?.entrypoints ?? []),
      ...(conventions?.alwaysUsed ?? []),
      ...(conventions?.usedExports?.map((entry) => entry.file) ?? []),
    ];
    if (conventionPaths.some((pattern) => literalConventionMatches(relativePath, pattern))) {
      roles.add('production');
      provenance.set(
        `convention:${config.name}`,
        deepFreeze({
          source: 'convention',
          detail: `target-convention:${config.name}`,
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
