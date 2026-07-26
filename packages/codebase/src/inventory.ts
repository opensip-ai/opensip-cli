import { realpathSync } from 'node:fs';

import {
  buildProjectInventorySnapshotIdentities,
  projectInventorySnapshotSchema,
} from '@opensip-cli/contracts';
import { createToolError, currentScope, tryCatch } from '@opensip-cli/core';

import { codebaseErrorCatalog } from './errors/codebase-error-catalog.js';
import { deepFreeze } from './freeze.js';
import { boundProjectLanguages, discoverFiles } from './inventory-files.js';
import {
  INVENTORY_CANCELLED_REASON,
  INVENTORY_DEADLINE_REASON,
  INVENTORY_SNAPSHOT_INVALID_REASON,
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
  DEFAULT_INVENTORY_DEADLINE_MS,
  DEFAULT_INVENTORY_LIMITS,
  MAX_FILE_TARGETS,
  MAX_INVENTORY_DEADLINE_MS,
  MAX_INVENTORY_SERIALIZED_BYTES,
  MAX_INVENTORY_FILES,
  MAX_INVENTORY_PACKAGES,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_DEPTH,
  MAX_PACKAGE_SCRIPTS,
} from './types.js';

import type { InventoryLimits, ProjectInventory, ProjectInventoryInput } from './types.js';
import type { ProjectInventorySnapshot } from '@opensip-cli/contracts';
import type { BoundedTargetResolver, ToolError } from '@opensip-cli/core';

const INPUT_INVALID = codebaseErrorCatalog.require('CODEBASE.CODEBASE.INVENTORY_INPUT_INVALID');

/** Build the coded refusal for one unusable caller input. */
function inputInvalid(field: string, condition: string, expected: string): ToolError {
  return createToolError(INPUT_INVALID, `inventory input '${field}' must be ${expected}`, {
    metadata: { condition, field },
  });
}

/**
 * Accept an omitted bound, refuse an unusable one.
 *
 * `undefined` means "no override" and legitimately resolves to the hard maximum. A value
 * that is PRESENT but not a positive finite number cannot be reinterpreted: mapping it to
 * the hard maximum (the previous behaviour) silently widens the very walk the caller asked
 * to narrow, and mapping it to the minimum invents a policy nobody asked for. Refusing at
 * the API boundary destroys no verdict because no scan has started (ruling D7).
 *
 * @throws {ToolError} `CODEBASE.CODEBASE.INVENTORY_INPUT_INVALID` when `value` is present
 * and is not a positive finite number.
 */
function boundedLimit(value: number | undefined, hardMaximum: number, field: string): number {
  if (value === undefined) return hardMaximum;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw inputInvalid(field, 'not-positive-finite', 'a positive finite number');
  }
  return Math.min(Math.floor(value), hardMaximum);
}

/** @throws {ToolError} When any present override is not a positive finite number. */
function resolveLimits(overrides: Partial<InventoryLimits> | undefined): InventoryLimits {
  return Object.freeze({
    files: boundedLimit(overrides?.files, MAX_INVENTORY_FILES, 'files'),
    packages: boundedLimit(overrides?.packages, MAX_INVENTORY_PACKAGES, 'packages'),
    scriptsPerPackage: boundedLimit(
      overrides?.scriptsPerPackage,
      MAX_PACKAGE_SCRIPTS,
      'scriptsPerPackage',
    ),
    targetsPerFile: boundedLimit(overrides?.targetsPerFile, MAX_FILE_TARGETS, 'targetsPerFile'),
    manifestBytes: boundedLimit(overrides?.manifestBytes, MAX_MANIFEST_BYTES, 'manifestBytes'),
    manifestDepth: boundedLimit(overrides?.manifestDepth, MAX_MANIFEST_DEPTH, 'manifestDepth'),
    serializedBytes: boundedLimit(
      overrides?.serializedBytes,
      MAX_INVENTORY_SERIALIZED_BYTES,
      'serializedBytes',
    ),
  });
}

interface InventoryCancellation {
  /** Composed caller + ambient-scope + deadline signal threaded through the whole build. */
  readonly signal: AbortSignal;
  /** The deadline arm alone, so an expiry is never reported as an operator interrupt. */
  readonly deadline: AbortSignal;
  /** Drop the deadline timer once the build is over, whatever its outcome. */
  readonly release: () => void;
}

/**
 * Resolve the one cancellation plane the build runs under.
 *
 * Ruling D5: the substrate DEFAULTS to the host-owned per-invocation root cancel signal
 * rather than requiring every caller to thread one, so an OS interrupt reaches inventory
 * with no per-caller wiring. A caller signal composes with it; it never replaces it.
 *
 * A caller `signal` that is not a real `AbortSignal` is refused rather than dropped:
 * `AbortSignal.any` cannot compose it, and silently continuing would leave a run the
 * caller asked to make cancellable permanently uncancellable.
 *
 * @throws {ToolError} `CODEBASE.CODEBASE.INVENTORY_INPUT_INVALID` when `deadlineMs` is
 * present and is not a positive finite number, or `signal` is not an `AbortSignal`.
 */
function resolveCancellation(input: ProjectInventoryInput): InventoryCancellation {
  const deadlineMs =
    input.deadlineMs === undefined
      ? DEFAULT_INVENTORY_DEADLINE_MS
      : boundedLimit(input.deadlineMs, MAX_INVENTORY_DEADLINE_MS, 'deadlineMs');
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw inputInvalid('signal', 'not-an-abort-signal', 'an AbortSignal');
  }
  // An owned controller rather than `AbortSignal.timeout`, so the timer can be dropped the
  // moment the build ends: a long-lived host (the MCP inventory refresh loop) would
  // otherwise accumulate one pending deadline timer per build for its whole duration.
  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(), deadlineMs);
  timer.unref?.();
  const ambient = currentScope()?.abortSignal;
  const sources = [deadlineController.signal, input.signal, ambient].filter(
    (candidate): candidate is AbortSignal => candidate instanceof AbortSignal,
  );
  return {
    signal: AbortSignal.any(sources),
    deadline: deadlineController.signal,
    release: () => clearTimeout(timer),
  };
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

/**
 * Build one bounded, deterministic, content-free project inventory.
 *
 * Total with respect to the environment: an unreadable root, a hostile host capability, a
 * cancelled run, or a snapshot that fails its own contract all DEGRADE to a coverage
 * verdict carrying bounded reason codes. The only refusals are malformed caller inputs,
 * which are rejected before any scan begins.
 *
 * @throws {ToolError} `CODEBASE.CODEBASE.INVENTORY_INPUT_INVALID` when a supplied
 * `limits` entry or `deadlineMs` is not a positive finite number, or `signal` is not an
 * `AbortSignal`.
 */
export async function buildProjectInventory(
  input: ProjectInventoryInput,
): Promise<ProjectInventory> {
  const limits = resolveLimits(input.limits ?? DEFAULT_INVENTORY_LIMITS);
  const cancellation = resolveCancellation(input);
  try {
    // One resolved input carries the composed signal so every downstream reader observes
    // the same cancellation plane instead of the caller's narrower (or absent) one.
    return await collectProjectInventory(
      { ...input, signal: cancellation.signal },
      limits,
      cancellation,
    );
  } finally {
    cancellation.release();
  }
}

async function collectProjectInventory(
  scan: ProjectInventoryInput,
  limits: InventoryLimits,
  cancellation: InventoryCancellation,
): Promise<ProjectInventory> {
  const initialReasons = new Set<string>();
  /** Fold the deadline arm in before degrading, so an expiry is never read as an interrupt. */
  const degraded = (reasons: Set<string>): ProjectInventory => {
    if (cancellation.deadline.aborted) reasons.add(INVENTORY_DEADLINE_REASON);
    return emptyInventory(scan, reasons);
  };
  const configIdentity = normalizeConfigIdentity(scan.configIdentity, initialReasons);
  const canonicalRoot = tryCatch(() => realpathSync(scan.projectRoot));
  if (!canonicalRoot.ok) {
    initialReasons.add('project-root-unavailable');
    return degraded(initialReasons);
  }
  const projectRoot = canonicalRoot.value;
  if (cancellation.signal.aborted) {
    initialReasons.add(INVENTORY_CANCELLED_REASON);
    return degraded(initialReasons);
  }

  const targetCapability = boundedTargetCapability(scan, initialReasons);
  if (targetCapability.stop) return degraded(initialReasons);
  const boundedResolver = targetCapability.resolver;
  if (boundedResolver !== undefined) {
    const preflightReasons = new Set<string>();
    const ready = await preflightBoundedTargetResolver({
      projectRoot,
      resolver: boundedResolver,
      reasons: preflightReasons,
      signal: cancellation.signal,
    });
    if (!ready) {
      for (const reason of preflightReasons) initialReasons.add(reason);
      return degraded(initialReasons);
    }
  }
  await yieldToEventLoop();
  if (cancellation.signal.aborted) {
    initialReasons.add(INVENTORY_CANCELLED_REASON);
    return degraded(initialReasons);
  }
  const manifests = await discoverManifestFacts(
    projectRoot,
    limits,
    cancellation.signal,
    boundedResolver,
  );
  const packages = packageFacts(manifests.facts);
  const fileDiscovery = await discoverFiles({
    inventoryInput: scan,
    limits,
    manifests: manifests.facts,
    packages,
    projectRoot,
    resolver: boundedResolver,
  });
  const allReasons = new Set([...initialReasons, ...manifests.reasons, ...fileDiscovery.reasons]);
  if (cancellation.deadline.aborted) allReasons.add(INVENTORY_DEADLINE_REASON);
  const languageBoundFiles = boundProjectLanguages(fileDiscovery.files, scan, allReasons);
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
  // Success-path twin of the empty-inventory guard: a snapshot that fails its own contract
  // is not a publishable verdict, but it is also not a reason to throw out of a total
  // substrate. Withdraw the projection and say so in coverage evidence.
  const parsed = projectInventorySnapshotSchema.safeParse({ ...bounded.base, ...identities });
  if (!parsed.success) {
    allReasons.add(INVENTORY_SNAPSHOT_INVALID_REASON);
    return degraded(allReasons);
  }
  const snapshot: ProjectInventorySnapshot = deepFreeze(parsed.data);
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
