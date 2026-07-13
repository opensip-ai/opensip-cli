import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { isPathInside, toPosixRelative, tryCatch } from '@opensip-cli/core';

import { byCodePoint } from './freeze.js';
import { CONTROL_CHARACTER } from './inventory-helpers.js';
import { applyBoundedGlobalExcludes } from './target-resolver-bounds.js';

import type { PendingFile, StructuralFileDiscovery } from './inventory-file-model.js';
import type { InventoryLimits, PackageManifestFacts, ProjectInventoryInput } from './types.js';
import type { FactProvenance, FileRole } from '@opensip-cli/contracts';
import type { BoundedTargetResolver } from '@opensip-cli/core';

const ROOT_STRUCTURAL_MARKERS: readonly {
  readonly path: string;
  readonly roles: readonly FileRole[];
  readonly provenance: FactProvenance;
}[] = [
  {
    path: 'opensip-cli.config.yml',
    roles: ['configuration'],
    provenance: { source: 'convention', detail: 'opensip-config' },
  },
  {
    path: 'pnpm-lock.yaml',
    roles: ['build', 'configuration'],
    provenance: { source: 'convention', detail: 'project-lockfile' },
  },
  {
    path: 'pnpm-workspace.yaml',
    roles: ['configuration'],
    provenance: { source: 'convention', detail: 'workspace-manifest' },
  },
];

export function canonicalFile(
  filePath: string,
  projectRoot: string,
  lexicalProjectRoot = projectRoot,
): { readonly absolutePath: string; readonly relativePath: string } | undefined {
  const lexicallyInside = (child: string, parent: string): boolean => {
    const fromParent = relative(resolve(parent), resolve(child));
    return (
      fromParent === '' ||
      (!isAbsolute(fromParent) && fromParent !== '..' && !fromParent.startsWith('../'))
    );
  };
  let identityRoot: string | undefined;
  if (lexicallyInside(filePath, projectRoot)) identityRoot = projectRoot;
  else if (lexicallyInside(filePath, lexicalProjectRoot)) identityRoot = lexicalProjectRoot;
  if (identityRoot === undefined) return undefined;
  const canonical = tryCatch(() => realpathSync(filePath));
  if (!canonical.ok) return undefined;
  const absolutePath = canonical.value;
  if (!isPathInside(absolutePath, projectRoot)) return undefined;
  // Realpath is the containment/stat authority, but the configured lexical path
  // is the stable file identity shared with graph and agent requests. Retaining
  // it keeps an in-root symlink addressable without admitting symlink escapes.
  const relativePath = toPosixRelative(identityRoot, filePath);
  if (
    relativePath.length === 0 ||
    relativePath.length > 1024 ||
    CONTROL_CHARACTER.test(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith('../')
  ) {
    return undefined;
  }
  return { absolutePath, relativePath };
}

function addStructuralCandidate(
  candidates: Map<string, PendingFile>,
  canonical: { readonly absolutePath: string; readonly relativePath: string },
  roles: readonly FileRole[],
  provenance: FactProvenance,
): void {
  candidates.set(canonical.relativePath, {
    ...canonical,
    targets: [],
    structuralRoles: [...roles].sort(byCodePoint),
    structuralProvenance: [provenance],
  });
}

function collectManifestStructuralFiles(
  projectRoot: string,
  manifests: readonly PackageManifestFacts[],
  candidates: Map<string, PendingFile>,
  reasons: Set<string>,
): void {
  for (const manifest of manifests) {
    const manifestPath = join(
      projectRoot,
      manifest.root === '.' ? '' : manifest.root,
      'package.json',
    );
    const canonical = canonicalFile(manifestPath, projectRoot);
    if (canonical === undefined) {
      reasons.add('file-outside-root-or-unreadable');
      continue;
    }
    addStructuralCandidate(candidates, canonical, ['configuration'], {
      source: 'manifest',
      detail: 'package.json',
    });
  }
}

function collectRootStructuralMarkers(
  projectRoot: string,
  candidates: Map<string, PendingFile>,
  reasons: Set<string>,
): void {
  for (const marker of ROOT_STRUCTURAL_MARKERS) {
    const markerPath = join(projectRoot, marker.path);
    if (!existsSync(markerPath)) continue;
    const canonical = canonicalFile(markerPath, projectRoot);
    if (canonical === undefined) {
      reasons.add('file-outside-root-or-unreadable');
      continue;
    }
    addStructuralCandidate(candidates, canonical, marker.roles, marker.provenance);
  }
}

interface StructuralGlobalExcludeInput {
  readonly candidates: ReadonlyMap<string, PendingFile>;
  readonly pending: readonly PendingFile[];
  readonly projectRoot: string;
  readonly reasons: Set<string>;
  readonly resolver: BoundedTargetResolver | undefined;
  readonly signal: AbortSignal | undefined;
}

async function applyStructuralGlobalExcludes(
  input: StructuralGlobalExcludeInput,
): Promise<readonly PendingFile[]> {
  const { candidates, pending, projectRoot, reasons, resolver, signal } = input;
  if (resolver === undefined || pending.length === 0) return pending;
  const retained = await applyBoundedGlobalExcludes({
    files: pending.map((candidate) => candidate.absolutePath),
    maximumFiles: pending.length,
    projectRoot,
    reasons,
    resolver,
    ...(signal === undefined ? {} : { signal }),
  });
  const allowed = new Set<string>();
  for (const filePath of retained) {
    const canonical = canonicalFile(filePath, projectRoot);
    if (canonical !== undefined && candidates.has(canonical.relativePath)) {
      allowed.add(canonical.relativePath);
    }
  }
  return pending.filter((candidate) => allowed.has(candidate.relativePath));
}

export async function discoverStructuralFiles(
  projectRoot: string,
  manifests: readonly PackageManifestFacts[],
  input: ProjectInventoryInput,
  limits: InventoryLimits,
  resolver: BoundedTargetResolver | undefined,
): Promise<StructuralFileDiscovery> {
  const reasons = new Set<string>();
  const candidates = new Map<string, PendingFile>();
  collectManifestStructuralFiles(projectRoot, manifests, candidates, reasons);
  collectRootStructuralMarkers(projectRoot, candidates, reasons);
  const sorted = [...candidates.values()].sort((left, right) =>
    byCodePoint(left.relativePath, right.relativePath),
  );
  const pending = await applyStructuralGlobalExcludes({
    candidates,
    pending: sorted,
    projectRoot,
    reasons,
    resolver,
    signal: input.signal,
  });
  if (pending.length > limits.files) reasons.add('file-cap-reached');
  return {
    pending: pending.slice(0, limits.files),
    reasons: [...reasons].sort(byCodePoint),
  };
}
