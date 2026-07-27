import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isPathInside, toPosixRelative, tryCatch } from '@opensip-cli/core';

import { byCodePoint, deepFreeze } from './freeze.js';
import {
  CONTROL_CHARACTER,
  INVENTORY_BATCH_SIZE,
  INVENTORY_CANCELLED_REASON,
  MANIFEST_VISITOR_FAILED_REASON,
  cancelled,
  yieldToEventLoop,
} from './inventory-helpers.js';
import { readPackageManifestFacts } from './manifest-facts.js';
import { walkManifestFilesystem } from './manifest-filesystem-walk.js';
import { pnpmWorkspacePatterns } from './pnpm-workspace.js';
import { applyBoundedGlobalExcludes } from './target-resolver-bounds.js';
import { MAX_INVENTORY_PACKAGES, MAX_WORKSPACE_PATTERNS } from './types.js';
import { compileWorkspacePatterns } from './workspace-patterns.js';

import type {
  InventoryLimits,
  PackageManifestFacts,
  PackageManifestFailureReason,
} from './types.js';
import type { CompiledWorkspacePatterns } from './workspace-patterns.js';
import type { PackageFact } from '@opensip-cli/contracts';
import type { BoundedTargetResolver } from '@opensip-cli/core';

export interface ManifestDiscovery {
  readonly facts: readonly PackageManifestFacts[];
  readonly reasons: readonly string[];
}

interface ManifestRootDiscovery {
  readonly roots: readonly {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly manifestPath: string;
    readonly canonicalManifestPath: string;
  }[];
  readonly reasons: readonly string[];
  readonly workspacePatterns: readonly string[];
}

function manifestReason(reason: PackageManifestFailureReason): string {
  switch (reason) {
    case 'cancelled': {
      return INVENTORY_CANCELLED_REASON;
    }
    case 'too-large': {
      return 'manifest-too-large';
    }
    case 'outside-root': {
      return 'manifest-outside-root';
    }
    case 'path-invalid': {
      return 'manifest-path-invalid';
    }
    case 'parse-failed': {
      return 'manifest-parse-failed';
    }
    case 'invalid-shape':
    case 'invalid-input': {
      return 'manifest-invalid';
    }
    case 'read-failed': {
      return 'manifest-read-failed';
    }
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

type ManifestRoot = ManifestRootDiscovery['roots'][number];

function manifestRootSort(left: ManifestRoot, right: ManifestRoot): number {
  if (left.relativePath === '.') return right.relativePath === '.' ? 0 : -1;
  if (right.relativePath === '.') return 1;
  return byCodePoint(left.relativePath, right.relativePath);
}

function canonicalManifestRoot(
  manifestPath: string,
  projectRoot: string,
  reasons: Set<string>,
): ManifestRoot | undefined {
  if (!isPathInside(manifestPath, projectRoot)) {
    reasons.add('manifest-outside-root');
    return undefined;
  }
  const canonical = tryCatch(() => ({
    packageRoot: realpathSync(dirname(manifestPath)),
    canonicalManifestPath: realpathSync(manifestPath),
  }));
  if (!canonical.ok) {
    reasons.add('manifest-read-failed');
    return undefined;
  }
  const { packageRoot, canonicalManifestPath } = canonical.value;
  if (
    !isPathInside(packageRoot, projectRoot) ||
    !isPathInside(canonicalManifestPath, projectRoot)
  ) {
    reasons.add('manifest-outside-root');
    return undefined;
  }
  const relativePath = toPosixRelative(projectRoot, packageRoot) || '.';
  if (
    relativePath.length > 1024 ||
    CONTROL_CHARACTER.test(relativePath) ||
    (relativePath !== '.' &&
      relativePath.split('/').some((part) => part.length === 0 || part === '.' || part === '..'))
  ) {
    reasons.add('manifest-path-invalid');
    return undefined;
  }
  return { absolutePath: packageRoot, relativePath, manifestPath, canonicalManifestPath };
}

function retainManifestRoots(
  selected: Map<string, ManifestRoot>,
  candidates: readonly ManifestRoot[],
  maximum: number,
  reasons: Set<string>,
): void {
  for (const candidate of candidates) {
    if (selected.has(candidate.relativePath)) continue;
    if (selected.size < maximum) {
      selected.set(candidate.relativePath, candidate);
      continue;
    }
    reasons.add('package-cap-reached');
    const ordered = [...selected.values()].sort(manifestRootSort);
    const last = ordered.at(-1);
    if (last !== undefined && manifestRootSort(candidate, last) < 0) {
      selected.delete(last.relativePath);
      selected.set(candidate.relativePath, candidate);
    }
  }
}

async function applyManifestGlobalExcludes(
  projectRoot: string,
  candidates: readonly ManifestRoot[],
  resolver: BoundedTargetResolver | undefined,
  reasons: Set<string>,
  signal: AbortSignal | undefined,
): Promise<readonly ManifestRoot[]> {
  if (resolver === undefined || candidates.length === 0) return candidates;
  const filtered = await applyBoundedGlobalExcludes({
    files: candidates.map((candidate) => candidate.manifestPath),
    maximumFiles: candidates.length,
    projectRoot,
    reasons,
    resolver,
    ...(signal === undefined ? {} : { signal }),
  });
  const allowed = new Set<string>();
  for (const filePath of filtered) {
    const canonical = tryCatch(() => realpathSync(filePath));
    if (!canonical.ok) {
      reasons.add('manifest-read-failed');
      continue;
    }
    if (isPathInside(canonical.value, projectRoot)) allowed.add(canonical.value);
  }
  return candidates.filter((candidate) => allowed.has(candidate.canonicalManifestPath));
}

interface ManifestScanState {
  readonly selected: Map<string, ManifestRoot>;
  readonly reasons: Set<string>;
  batch: ManifestRoot[];
  visited: number;
}

async function flushManifestBatch(input: {
  readonly projectRoot: string;
  readonly resolver: BoundedTargetResolver | undefined;
  readonly signal: AbortSignal | undefined;
  readonly maximum: number;
  readonly state: ManifestScanState;
}): Promise<void> {
  const allowed = await applyManifestGlobalExcludes(
    input.projectRoot,
    input.state.batch,
    input.resolver,
    input.state.reasons,
    input.signal,
  );
  retainManifestRoots(input.state.selected, allowed, input.maximum, input.state.reasons);
  input.state.batch = [];
}

async function scanWorkspaceManifests(input: {
  readonly compiledPatterns: CompiledWorkspacePatterns;
  readonly projectRoot: string;
  readonly limits: InventoryLimits;
  readonly signal: AbortSignal | undefined;
  readonly resolver: BoundedTargetResolver | undefined;
  readonly maximum: number;
  readonly visitLimit: number;
  readonly state: ManifestScanState;
}): Promise<void> {
  if (!input.compiledPatterns.hasPositivePatterns) return;
  const walk = await walkManifestFilesystem(
    input.projectRoot,
    input.limits.manifestDepth,
    (relativeDirectory) => input.compiledPatterns.couldMatchDescendant(relativeDirectory),
    async ({ manifestPath, packageRoot }) => {
      if (cancelled(input.signal, input.state.reasons)) return false;
      input.state.visited += 1;
      if (input.state.visited > input.visitLimit) {
        input.state.reasons.add('package-discovery-cap-reached');
        return false;
      }
      if (!input.compiledPatterns.matches(packageRoot)) return;
      const candidate = canonicalManifestRoot(manifestPath, input.projectRoot, input.state.reasons);
      if (candidate !== undefined && candidate.relativePath !== '.') {
        input.state.batch.push(candidate);
      }
      if (input.state.batch.length < INVENTORY_BATCH_SIZE) return;
      await flushManifestBatch(input);
      await yieldToEventLoop();
      return !cancelled(input.signal, input.state.reasons);
    },
    input.signal,
  );
  if (walk.cancelled) input.state.reasons.add(INVENTORY_CANCELLED_REASON);
  if (walk.capped || (walk.stoppedByVisitor && !walk.cancelled)) {
    input.state.reasons.add('package-discovery-cap-reached');
  }
  if (walk.readFailed) input.state.reasons.add('manifest-read-failed');
  // A visitor throw stops the walk the same way a cap does, but it is not a cap: without
  // its own reason code an internal fault would be published as ordinary bounded
  // truncation and nobody would ever look for the bug.
  if (walk.visitorFailed) input.state.reasons.add(MANIFEST_VISITOR_FAILED_REASON);
}

interface DiscoverManifestRootsInput {
  readonly projectRoot: string;
  readonly limits: InventoryLimits;
  readonly signal: AbortSignal | undefined;
  readonly resolver: BoundedTargetResolver | undefined;
  readonly workspacePatterns: readonly string[];
  readonly maximum: number;
}

async function discoverManifestRoots(
  input: DiscoverManifestRootsInput,
): Promise<ManifestRootDiscovery> {
  const { projectRoot, limits, signal, resolver, workspacePatterns, maximum } = input;
  const state: ManifestScanState = {
    selected: new Map<string, ManifestRoot>(),
    reasons: new Set<string>(),
    batch: [],
    visited: 0,
  };
  const visitLimit = Math.min(
    MAX_INVENTORY_PACKAGES * 4,
    Math.max(INVENTORY_BATCH_SIZE, maximum * 4),
  );
  const compiledPatterns = compileWorkspacePatterns(workspacePatterns);
  for (const reason of compiledPatterns.reasonCodes) state.reasons.add(reason);
  if (maximum === 0 && compiledPatterns.hasPositivePatterns) {
    state.reasons.add('package-cap-reached');
  } else if (maximum > 0) {
    await scanWorkspaceManifests({
      compiledPatterns,
      projectRoot,
      limits,
      signal,
      resolver,
      maximum,
      visitLimit,
      state,
    });
    if (cancelled(signal, state.reasons)) state.batch = [];
    else await flushManifestBatch({ projectRoot, resolver, signal, maximum, state });
  }
  return {
    roots: [...state.selected.values()].sort(manifestRootSort),
    reasons: [...state.reasons].sort(byCodePoint),
    workspacePatterns: compiledPatterns.patterns,
  };
}

interface CollectManifestFactInput {
  readonly root: ManifestRoot;
  readonly projectRoot: string;
  readonly limits: InventoryLimits;
  readonly signal: AbortSignal | undefined;
  readonly facts: PackageManifestFacts[];
  readonly reasons: Set<string>;
}

function collectManifestFact(input: CollectManifestFactInput): void {
  const { root, projectRoot, limits, signal, facts, reasons } = input;
  const result = readPackageManifestFacts({
    packageRoot: root.absolutePath,
    projectRoot,
    maxBytes: limits.manifestBytes,
    maxScripts: limits.scriptsPerPackage,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!result.ok) {
    reasons.add(manifestReason(result.reason));
    return;
  }
  facts.push(result.facts);
  for (const reason of result.facts.reasonCodes) reasons.add(reason);
}

export async function discoverManifestFacts(
  projectRoot: string,
  limits: InventoryLimits,
  signal: AbortSignal | undefined,
  resolver: BoundedTargetResolver | undefined,
): Promise<ManifestDiscovery> {
  const reasons = new Set<string>();
  const facts: PackageManifestFacts[] = [];
  const rootManifestPath = join(projectRoot, 'package.json');
  if (existsSync(rootManifestPath)) {
    const root = canonicalManifestRoot(rootManifestPath, projectRoot, reasons);
    const allowed =
      root === undefined
        ? []
        : await applyManifestGlobalExcludes(projectRoot, [root], resolver, reasons, signal);
    if (allowed[0] !== undefined) {
      collectManifestFact({ root: allowed[0], projectRoot, limits, signal, facts, reasons });
    }
  }
  const rootFact = facts.find((fact) => fact.root === '.');
  const combinedWorkspacePatterns = [
    ...new Set([
      ...(rootFact?.workspacePatterns ?? []),
      ...pnpmWorkspacePatterns(projectRoot, limits.manifestBytes, reasons),
    ]),
  ].sort(byCodePoint);
  if (combinedWorkspacePatterns.length > MAX_WORKSPACE_PATTERNS) {
    reasons.add('manifest-workspace-cap-reached');
  }
  const workspacePatterns = combinedWorkspacePatterns.slice(0, MAX_WORKSPACE_PATTERNS);
  const discovery = await discoverManifestRoots({
    projectRoot,
    limits,
    signal,
    resolver,
    workspacePatterns,
    maximum: Math.max(0, limits.packages - facts.length),
  });
  for (const reason of discovery.reasons) reasons.add(reason);
  if (
    rootFact !== undefined &&
    (discovery.workspacePatterns.length !== rootFact.workspacePatterns.length ||
      discovery.workspacePatterns.some(
        (pattern, index) => pattern !== rootFact.workspacePatterns[index],
      ))
  ) {
    facts[facts.indexOf(rootFact)] = deepFreeze({
      ...rootFact,
      workspacePatterns: discovery.workspacePatterns,
    });
  }
  for (const [index, root] of discovery.roots.entries()) {
    if (index > 0 && index % INVENTORY_BATCH_SIZE === 0) await yieldToEventLoop();
    if (cancelled(signal, reasons)) break;
    collectManifestFact({ root, projectRoot, limits, signal, facts, reasons });
  }
  facts.sort(
    (left, right) => byCodePoint(left.root, right.root) || byCodePoint(left.name, right.name),
  );
  const packageNames = new Set<string>();
  const uniqueFacts = facts.filter((fact) => {
    if (packageNames.has(fact.name)) {
      reasons.add('package-name-duplicate');
      return false;
    }
    packageNames.add(fact.name);
    return true;
  });
  return deepFreeze({ facts: uniqueFacts, reasons: [...reasons].sort(byCodePoint) });
}

export function packageFacts(manifests: readonly PackageManifestFacts[]): readonly PackageFact[] {
  return manifests.map((manifest) =>
    deepFreeze({
      name: manifest.name,
      root: manifest.root,
      private: manifest.private,
      exports: [...manifest.exports],
      bins: [...manifest.bins],
      verificationCommands: [...manifest.verificationCommands],
      provenance: [deepFreeze({ source: 'manifest', detail: 'package.json' })],
    }),
  );
}
