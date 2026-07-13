import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isPathInside, toPosixRelative, tryCatch } from '@opensip-cli/core';
import { globIterate } from 'glob';
import { minimatch } from 'minimatch';

import { byCodePoint, deepFreeze } from './freeze.js';
import {
  CONTROL_CHARACTER,
  INVENTORY_BATCH_SIZE,
  INVENTORY_CANCELLED_REASON,
  cancelled,
  yieldToEventLoop,
} from './inventory-helpers.js';
import { readPackageManifestFacts } from './manifest-facts.js';
import { pnpmWorkspacePatterns } from './pnpm-workspace.js';
import { MAX_INVENTORY_PACKAGES } from './types.js';

import type {
  InventoryLimits,
  PackageManifestFacts,
  PackageManifestFailureReason,
} from './types.js';
import type { PackageFact } from '@opensip-cli/contracts';
import type { TargetResolver } from '@opensip-cli/core';

const MANIFEST_IGNORE = [
  '**/.git/**',
  '**/.opensip-cli/**',
  '**/coverage/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/opensip-cli/.runtime/**',
];
const MAX_WORKSPACE_PATTERNS = 128;

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

function applyManifestGlobalExcludes(
  projectRoot: string,
  candidates: readonly ManifestRoot[],
  resolver: TargetResolver | undefined,
  reasons: Set<string>,
): readonly ManifestRoot[] {
  if (resolver === undefined || candidates.length === 0) return candidates;
  const filtered = tryCatch(() =>
    resolver.applyGlobalExcludes(
      candidates.map((candidate) => candidate.manifestPath),
      projectRoot,
    ),
  );
  if (!filtered.ok) {
    reasons.add('global-exclude-filter-failed');
    return [];
  }
  const allowed = new Set<string>();
  for (const filePath of filtered.value) {
    const canonical = tryCatch(() => realpathSync(filePath));
    if (!canonical.ok) {
      reasons.add('manifest-read-failed');
      continue;
    }
    if (isPathInside(canonical.value, projectRoot)) allowed.add(canonical.value);
  }
  return candidates.filter((candidate) => allowed.has(candidate.canonicalManifestPath));
}

function workspaceMember(path: string, patterns: readonly string[]): boolean {
  const positives = patterns.filter((pattern) => !pattern.startsWith('!'));
  const negatives = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));
  return (
    positives.some((pattern) => minimatch(path, pattern, { dot: false })) &&
    !negatives.some((pattern) => minimatch(path, pattern, { dot: false }))
  );
}

function workspaceManifestGlob(pattern: string): string {
  return `${pattern.replace(/\/+$/u, '')}/package.json`;
}

interface ManifestScanState {
  readonly selected: Map<string, ManifestRoot>;
  readonly reasons: Set<string>;
  batch: ManifestRoot[];
  visited: number;
}

function flushManifestBatch(input: {
  readonly projectRoot: string;
  readonly resolver: TargetResolver | undefined;
  readonly maximum: number;
  readonly state: ManifestScanState;
}): void {
  const allowed = applyManifestGlobalExcludes(
    input.projectRoot,
    input.state.batch,
    input.resolver,
    input.state.reasons,
  );
  retainManifestRoots(input.state.selected, allowed, input.maximum, input.state.reasons);
  input.state.batch = [];
}

async function scanWorkspacePattern(input: {
  readonly pattern: string;
  readonly projectRoot: string;
  readonly limits: InventoryLimits;
  readonly signal: AbortSignal | undefined;
  readonly resolver: TargetResolver | undefined;
  readonly workspacePatterns: readonly string[];
  readonly maximum: number;
  readonly visitLimit: number;
  readonly state: ManifestScanState;
}): Promise<boolean> {
  for await (const manifestPath of globIterate(workspaceManifestGlob(input.pattern), {
    cwd: input.projectRoot,
    absolute: true,
    nodir: true,
    follow: false,
    maxDepth: input.limits.manifestDepth,
    ignore: MANIFEST_IGNORE,
  })) {
    if (cancelled(input.signal, input.state.reasons)) return false;
    input.state.visited += 1;
    if (input.state.visited > input.visitLimit) {
      input.state.reasons.add('package-discovery-cap-reached');
      return false;
    }
    const candidate = canonicalManifestRoot(manifestPath, input.projectRoot, input.state.reasons);
    if (
      candidate !== undefined &&
      candidate.relativePath !== '.' &&
      workspaceMember(candidate.relativePath, input.workspacePatterns)
    ) {
      input.state.batch.push(candidate);
    }
    if (input.state.batch.length < INVENTORY_BATCH_SIZE) continue;
    flushManifestBatch(input);
    await yieldToEventLoop();
    if (cancelled(input.signal, input.state.reasons)) return false;
  }
  return true;
}

async function discoverManifestRoots(
  projectRoot: string,
  limits: InventoryLimits,
  signal: AbortSignal | undefined,
  resolver: TargetResolver | undefined,
  workspacePatterns: readonly string[],
  maximum: number,
): Promise<ManifestRootDiscovery> {
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
  const positivePatterns = workspacePatterns
    .filter((pattern) => !pattern.startsWith('!'))
    .sort(byCodePoint);
  // @sequential-ok — At most 128 sorted workspace patterns mutate one shared
  // retained-prefix budget and cancellation state. Parallel scans would make
  // package caps and cancellation timing nondeterministic.
  for (const pattern of positivePatterns) {
    const completed = await scanWorkspacePattern({
      pattern,
      projectRoot,
      limits,
      signal,
      resolver,
      workspacePatterns,
      maximum,
      visitLimit,
      state,
    });
    if (!completed) break;
  }
  flushManifestBatch({ projectRoot, resolver, maximum, state });
  return {
    roots: [...state.selected.values()].sort(manifestRootSort),
    reasons: [...state.reasons].sort(byCodePoint),
  };
}

function collectManifestFact(
  root: ManifestRoot,
  projectRoot: string,
  limits: InventoryLimits,
  signal: AbortSignal | undefined,
  facts: PackageManifestFacts[],
  reasons: Set<string>,
): void {
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
  resolver: TargetResolver | undefined,
): Promise<ManifestDiscovery> {
  const reasons = new Set<string>();
  const facts: PackageManifestFacts[] = [];
  const rootManifestPath = join(projectRoot, 'package.json');
  if (existsSync(rootManifestPath)) {
    const root = canonicalManifestRoot(rootManifestPath, projectRoot, reasons);
    const allowed =
      root === undefined ? [] : applyManifestGlobalExcludes(projectRoot, [root], resolver, reasons);
    if (allowed[0] !== undefined) {
      collectManifestFact(allowed[0], projectRoot, limits, signal, facts, reasons);
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
  if (rootFact !== undefined && workspacePatterns.length !== rootFact.workspacePatterns.length) {
    facts[facts.indexOf(rootFact)] = deepFreeze({ ...rootFact, workspacePatterns });
  }
  const discovery = await discoverManifestRoots(
    projectRoot,
    limits,
    signal,
    resolver,
    workspacePatterns,
    Math.max(0, limits.packages - facts.length),
  );
  for (const reason of discovery.reasons) reasons.add(reason);
  for (const [index, root] of discovery.roots.entries()) {
    if (index > 0 && index % INVENTORY_BATCH_SIZE === 0) await yieldToEventLoop();
    if (cancelled(signal, reasons)) break;
    collectManifestFact(root, projectRoot, limits, signal, facts, reasons);
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
