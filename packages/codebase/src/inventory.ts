import { realpathSync } from 'node:fs';

import {
  buildProjectInventorySnapshotIdentities,
  projectInventorySnapshotSchema,
} from '@opensip-cli/contracts';
import { tryCatch } from '@opensip-cli/core';

import { deepFreeze } from './freeze.js';
import { boundProjectLanguages, discoverFiles } from './inventory-files.js';
import {
  INVENTORY_CANCELLED_REASON,
  normalizeConfigIdentity,
  yieldToEventLoop,
} from './inventory-helpers.js';
import { discoverManifestFacts, packageFacts } from './inventory-manifests.js';
import { emptyInventory, enforceSerializedBudget } from './inventory-snapshot.js';
import {
  asBoundedTargetResolver,
  preflightBoundedTargetResolver,
} from './target-resolver-bounds.js';
import {
  DEFAULT_INVENTORY_LIMITS,
  MAX_FILE_TARGETS,
  MAX_INVENTORY_SERIALIZED_BYTES,
  MAX_INVENTORY_FILES,
  MAX_INVENTORY_PACKAGES,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_DEPTH,
  MAX_PACKAGE_SCRIPTS,
} from './types.js';

import type { InventoryLimits, ProjectInventory, ProjectInventoryInput } from './types.js';
import type { ProjectInventorySnapshot } from '@opensip-cli/contracts';
import type { BoundedTargetResolver } from '@opensip-cli/core';

function boundedLimit(value: number | undefined, hardMaximum: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return hardMaximum;
  return Math.min(Math.floor(value), hardMaximum);
}

function resolveLimits(overrides: Partial<InventoryLimits> | undefined): InventoryLimits {
  return Object.freeze({
    files: boundedLimit(overrides?.files, MAX_INVENTORY_FILES),
    packages: boundedLimit(overrides?.packages, MAX_INVENTORY_PACKAGES),
    scriptsPerPackage: boundedLimit(overrides?.scriptsPerPackage, MAX_PACKAGE_SCRIPTS),
    targetsPerFile: boundedLimit(overrides?.targetsPerFile, MAX_FILE_TARGETS),
    manifestBytes: boundedLimit(overrides?.manifestBytes, MAX_MANIFEST_BYTES),
    manifestDepth: boundedLimit(overrides?.manifestDepth, MAX_MANIFEST_DEPTH),
    serializedBytes: boundedLimit(overrides?.serializedBytes, MAX_INVENTORY_SERIALIZED_BYTES),
  });
}

function boundedTargetCapability(
  input: ProjectInventoryInput,
  reasons: Set<string>,
): { readonly resolver?: BoundedTargetResolver; readonly stop: boolean } {
  if (input.targets === undefined) return { stop: false };
  const resolver = asBoundedTargetResolver(input.targets);
  const cancelled = input.signal?.aborted === true;
  if (cancelled) reasons.add(INVENTORY_CANCELLED_REASON);
  if (resolver === undefined) reasons.add('bounded-target-resolution-unavailable');
  return {
    ...(resolver === undefined ? {} : { resolver }),
    stop: cancelled || resolver === undefined,
  };
}

/** Build one bounded, deterministic, content-free project inventory. */
export async function buildProjectInventory(
  input: ProjectInventoryInput,
): Promise<ProjectInventory> {
  const initialReasons = new Set<string>();
  const configIdentity = normalizeConfigIdentity(input.configIdentity, initialReasons);
  const canonicalRoot = tryCatch(() => realpathSync(input.projectRoot));
  if (!canonicalRoot.ok) {
    initialReasons.add('project-root-unavailable');
    return emptyInventory(input, initialReasons);
  }
  const projectRoot = canonicalRoot.value;
  if (input.signal?.aborted) {
    initialReasons.add(INVENTORY_CANCELLED_REASON);
    return emptyInventory(input, initialReasons);
  }

  const limits = resolveLimits(input.limits ?? DEFAULT_INVENTORY_LIMITS);
  const targetCapability = boundedTargetCapability(input, initialReasons);
  if (targetCapability.stop) return emptyInventory(input, initialReasons);
  const boundedResolver = targetCapability.resolver;
  if (boundedResolver !== undefined) {
    const preflightReasons = new Set<string>();
    const ready = await preflightBoundedTargetResolver({
      projectRoot,
      resolver: boundedResolver,
      reasons: preflightReasons,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!ready) {
      for (const reason of preflightReasons) initialReasons.add(reason);
      return emptyInventory(input, initialReasons);
    }
  }
  await yieldToEventLoop();
  if (input.signal?.aborted) {
    initialReasons.add(INVENTORY_CANCELLED_REASON);
    return emptyInventory(input, initialReasons);
  }
  const manifests = await discoverManifestFacts(projectRoot, limits, input.signal, boundedResolver);
  const packages = packageFacts(manifests.facts);
  const fileDiscovery = await discoverFiles({
    inventoryInput: input,
    limits,
    manifests: manifests.facts,
    packages,
    projectRoot,
    resolver: boundedResolver,
  });
  const allReasons = new Set([...initialReasons, ...manifests.reasons, ...fileDiscovery.reasons]);
  const languageBoundFiles = boundProjectLanguages(fileDiscovery.files, input, allReasons);
  const bounded = enforceSerializedBudget({
    configIdentity,
    manifests: manifests.facts,
    packages,
    files: languageBoundFiles,
    available: fileDiscovery.available,
    reasons: allReasons,
    maximumBytes: Math.max(4096, limits.serializedBytes),
  });
  const identities = buildProjectInventorySnapshotIdentities(bounded.base);
  const snapshot: ProjectInventorySnapshot = deepFreeze(
    projectInventorySnapshotSchema.parse({
      ...bounded.base,
      ...identities,
    }),
  );
  const retainedRoots = new Set(bounded.packages.map((pkg) => pkg.root));
  const manifestByRoot = new Map(
    manifests.facts
      .filter((manifest) => retainedRoots.has(manifest.root))
      .map((manifest) => [manifest.root, manifest]),
  );
  return Object.freeze({
    snapshot,
    fileByPath: new Map(snapshot.files.map((file) => [file.path, file])),
    packageByRoot: new Map(snapshot.packages.map((pkg) => [pkg.root, pkg])),
    manifestByRoot,
  });
}
