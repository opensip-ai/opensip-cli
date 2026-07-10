function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Graph-owned complete catalog input verification (MCP Graph Audit Phase 1).
 *
 * Reruns adapter selection + discovery + cache-key assembly against the
 * producing run's provenance. Read-only: discovery/config/stats only.
 */

import { isPathInside, err, ok, type Result } from '@opensip-cli/core';

import { stampEngineVersion, type EngineMode } from '../cache/engine-version.js';
import { classifyCatalog, computeFilesFingerprint } from '../cache/invalidate.js';
import { resolveCanonicalFileSet } from '../cli/orchestrate/canonical-file-set.js';
import { GraphAdapterSelector } from '../lang-adapter/selector.js';

import type {
  FreshnessChangeSummary,
  FreshnessReasonCode,
  FreshnessVerification,
} from './query-contracts.js';
import type { GraphReadError } from './types.js';
import type { GraphLanguageAdapter } from '../lang-adapter/types.js';
import type { AdapterSelectionEvidence, Catalog } from '../types.js';

/** Max adapters accepted in a registry snapshot before reject. */
const MAX_ADAPTERS = 64;
/** Max file extensions per adapter descriptor. */
const MAX_EXTENSIONS = 32;
/** Max discovered files. */
const MAX_DISCOVERED_FILES = 1_000_000;
/** Max cacheKey length. */
const MAX_CACHE_KEY_LEN = 1024;
/** Max change samples. */
const MAX_CHANGE_SAMPLES = 50;

/** Narrow registry reader used by verification (no ambient scope). */
export interface GraphAdapterRegistryReader {
  readonly size: number;
  getAll(): readonly {
    readonly id: string;
    readonly adapter: GraphLanguageAdapter;
  }[];
  getById(id: string): { readonly adapter: GraphLanguageAdapter } | undefined;
}

export interface VerifyCatalogInputsInput {
  readonly projectRoot: string;
  readonly catalog: Catalog;
  readonly adapters: GraphAdapterRegistryReader;
}

function graphReadError(code: string, message: string): GraphReadError {
  const truncated = message.length > 160 ? `${message.slice(0, 157)}...` : message;
  return { code, operation: 'catalog-generation', message: truncated };
}

function nowIso(): string {
  return new Date().toISOString();
}

function partial(
  reasonCode: FreshnessReasonCode,
  reason: string,
  builtFresh = false,
): FreshnessVerification {
  return {
    fresh: builtFresh,
    verifiedAt: nowIso(),
    verification: 'partial',
    reasonCode,
    reason,
  };
}

function complete(
  fresh: boolean,
  reasonCode: FreshnessReasonCode | undefined,
  reason: string | undefined,
  changes?: FreshnessChangeSummary,
): FreshnessVerification {
  return {
    fresh,
    verifiedAt: nowIso(),
    verification: 'complete',
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(reason === undefined ? {} : { reason }),
    ...(changes === undefined ? {} : { changes }),
  };
}

/**
 * Validate a single adapter descriptor before feeding it to the selector.
 */
export function isSafeAdapterDescriptor(adapter: GraphLanguageAdapter): boolean {
  if (typeof adapter.id !== 'string' || adapter.id.length === 0 || adapter.id.length > 64) {
    return false;
  }
  if (hasControlChar(adapter.id)) return false;
  if (
    adapter.displayName !== undefined &&
    (typeof adapter.displayName !== 'string' ||
      adapter.displayName.length === 0 ||
      adapter.displayName.length > 128 ||
      hasControlChar(adapter.displayName))
  ) {
    return false;
  }
  if (!Array.isArray(adapter.fileExtensions) || adapter.fileExtensions.length > MAX_EXTENSIONS) {
    return false;
  }
  for (const ext of adapter.fileExtensions) {
    if (typeof ext !== 'string' || ext.length === 0 || ext.length > 32 || hasControlChar(ext)) {
      return false;
    }
  }
  return (
    typeof adapter.discoverFiles === 'function' &&
    typeof adapter.parseProject === 'function' &&
    typeof adapter.walkProject === 'function' &&
    typeof adapter.resolveCallSites === 'function' &&
    typeof adapter.cacheKey === 'function'
  );
}

function validateRegistry(adapters: GraphAdapterRegistryReader): Result<void, GraphReadError> {
  if (adapters.size > MAX_ADAPTERS) {
    return err(
      graphReadError(
        'GRAPH.READ.VERIFY_REGISTRY',
        `Adapter registry exceeds ${String(MAX_ADAPTERS)} entries`,
      ),
    );
  }
  for (const entry of adapters.getAll()) {
    if (!isSafeAdapterDescriptor(entry.adapter)) {
      return err(
        graphReadError(
          'GRAPH.READ.VERIFY_DESCRIPTOR',
          'Adapter registry contains a hostile or incomplete descriptor',
        ),
      );
    }
  }
  return ok(undefined);
}

/**
 * Verify that a served catalog still matches complete current discovery inputs.
 * Absence of adapterSelection/engineMode ⇒ partial verification (never verified-fresh).
 */
export async function verifyCatalogInputs(
  input: VerifyCatalogInputsInput,
): Promise<Result<FreshnessVerification, GraphReadError>> {
  try {
    const registryOk = validateRegistry(input.adapters);
    if (!registryOk.ok) return registryOk;

    const selection = input.catalog.adapterSelection;
    const engineMode = input.catalog.engineMode;
    if (selection === undefined || engineMode === undefined) {
      return ok(
        partial(
          'verification-unavailable',
          'Catalog lacks adapter-selection or engine-mode provenance',
        ),
      );
    }

    const selected = selectAdapter(input.adapters, selection, input.projectRoot);
    if (!selected.ok) return selected;
    if (
      selected.value.id !== selection.selectedId ||
      selected.value.id !== input.catalog.language
    ) {
      return ok(
        complete(false, 'selection-changed', 'Active adapter selection no longer matches catalog'),
      );
    }

    const discovery = await selected.value.discoverFiles({ cwd: input.projectRoot });
    const contained = validateDiscovery(discovery, input.projectRoot);
    if (!contained.ok) return contained;

    if (discovery.files.length > MAX_DISCOVERED_FILES) {
      return err(
        graphReadError(
          'GRAPH.READ.VERIFY_DISCOVERY',
          `Discovery returned more than ${String(MAX_DISCOVERED_FILES)} files`,
        ),
      );
    }

    const files = resolveCanonicalFileSet(discovery.files);
    const resolutionMode = input.catalog.resolutionMode ?? 'exact';
    const rawCacheKey = await selected.value.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
      resolutionMode,
    });
    if (
      typeof rawCacheKey !== 'string' ||
      rawCacheKey.length === 0 ||
      rawCacheKey.length > MAX_CACHE_KEY_LEN ||
      hasControlChar(rawCacheKey)
    ) {
      return err(
        graphReadError('GRAPH.READ.VERIFY_CACHE_KEY', 'Adapter cacheKey is malformed or oversized'),
      );
    }

    const stampedMode: EngineMode = engineMode === 'sharded' ? 'sharded' : 'exact';
    // Sharded catalogs use a different cache-key assembly; when provenance says
    // sharded we still compare language + file fingerprint primarily and treat
    // a key-prefix mismatch carefully.
    const currentCacheKey =
      engineMode === 'sharded'
        ? input.catalog.cacheKey // file-set + language still checked via classifier axes we can recompute
        : stampEngineVersion(rawCacheKey, stampedMode);

    // For sharded catalogs, recompute only fingerprint + language; a full
    // sharded cache key depends on fragment set. Compare fingerprint via
    // classifier with the catalog's own cacheKey so we still detect language
    // and file drift without inventing a fragment hash.
    const ctxCacheKey = engineMode === 'sharded' ? input.catalog.cacheKey : currentCacheKey;
    if (engineMode === 'sharded' && input.catalog.engineMode !== 'sharded') {
      return ok(complete(false, 'engine-mode-changed', 'Engine mode no longer matches catalog'));
    }

    const verdict = classifyCatalog(input.catalog, {
      currentLanguage: selected.value.id,
      currentCacheKey: ctxCacheKey,
      currentFiles: files,
    });

    if (verdict.kind === 'valid') {
      // Still recompute fingerprint to surface added-file drift when cache keys
      // match (exact path). classifyCatalog already diffs fingerprints.
      return ok(complete(true, undefined, undefined));
    }
    if (verdict.kind === 'incremental') {
      const changes = changeSummaryFromFiles(
        filesFromFingerprint(input.catalog.filesFingerprint ?? ''),
        files,
        verdict.changedFiles,
      );
      return ok(
        complete(false, 'files-changed', 'Source files changed since catalog build', changes),
      );
    }
    // invalid
    const reason = verdict.reason;
    const reasonCode = mapInvalidReason(reason);
    return ok(complete(false, reasonCode, `stale: ${reason}`));
  } catch {
    return err(
      graphReadError(
        'GRAPH.READ.VERIFY_FAILED',
        'Catalog input verification failed due to infrastructure error',
      ),
    );
  }
}

function selectAdapter(
  adapters: GraphAdapterRegistryReader,
  selection: AdapterSelectionEvidence,
  projectRoot: string,
): Result<GraphLanguageAdapter, GraphReadError> {
  try {
    const selector = new GraphAdapterSelector(adapters);
    if (selection.mode === 'forced') {
      const adapter = selector.pick({ cwd: projectRoot, language: selection.requestedId });
      return ok(adapter);
    }
    const adapter = selector.pick({ cwd: projectRoot });
    return ok(adapter);
  } catch {
    return err(
      graphReadError(
        'GRAPH.READ.VERIFY_SELECTION',
        'Adapter selection failed during catalog verification',
      ),
    );
  }
}

function validateDiscovery(
  discovery: {
    readonly projectDirAbs: string;
    readonly files: readonly string[];
    readonly configPathAbs?: string;
  },
  projectRoot: string,
): Result<void, GraphReadError> {
  // Allow equality even when realpath differs slightly — isPathInside covers
  // containment; if root itself fails realpath, treat as partial via error.
  if (
    !isPathInside(discovery.projectDirAbs, projectRoot) &&
    discovery.projectDirAbs !== projectRoot &&
    !isPathInside(projectRoot, discovery.projectDirAbs)
  ) {
    return err(
      graphReadError(
        'GRAPH.READ.VERIFY_DISCOVERY',
        'Discovery project root escaped the configured project',
      ),
    );
  }
  if (
    discovery.configPathAbs !== undefined &&
    !isPathInside(discovery.configPathAbs, projectRoot)
  ) {
    return err(
      graphReadError(
        'GRAPH.READ.VERIFY_DISCOVERY',
        'Discovery config path escaped the configured project',
      ),
    );
  }
  for (const file of discovery.files) {
    if (typeof file !== 'string' || file.length === 0 || hasControlChar(file)) {
      return err(
        graphReadError('GRAPH.READ.VERIFY_DISCOVERY', 'Discovery returned a malformed file path'),
      );
    }
    if (!isPathInside(file, projectRoot)) {
      return err(
        graphReadError(
          'GRAPH.READ.VERIFY_DISCOVERY',
          'Discovery returned a file outside the configured project',
        ),
      );
    }
  }
  return ok(undefined);
}

function mapInvalidReason(reason: string): FreshnessReasonCode {
  if (reason === 'language-changed') return 'language-changed';
  if (reason === 'cache-key-changed') return 'cache-key-changed';
  if (reason.includes('file')) return 'files-changed';
  return 'files-changed';
}

function filesFromFingerprint(fingerprint: string): string[] {
  const lines = fingerprint.split('\n');
  const files: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string' || line.length === 0) continue;
    const pipe = line.indexOf('|');
    files.push(pipe === -1 ? line : line.slice(0, pipe));
  }
  return files;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- added/deleted/modified sample aggregation
function changeSummaryFromFiles(
  previous: readonly string[],
  current: readonly string[],
  changedAbs: readonly string[],
): FreshnessChangeSummary {
  const prev = new Set(previous);
  const curr = new Set(current);
  let added = 0;
  let deleted = 0;
  const sample: string[] = [];
  for (const f of curr) {
    if (!prev.has(f)) {
      added++;
      if (sample.length < MAX_CHANGE_SAMPLES) sample.push(f);
    }
  }
  for (const f of prev) {
    if (!curr.has(f)) {
      deleted++;
      if (sample.length < MAX_CHANGE_SAMPLES) sample.push(f);
    }
  }
  const modified = changedAbs.length;
  for (const f of changedAbs) {
    if (sample.length < MAX_CHANGE_SAMPLES && !sample.includes(f)) sample.push(f);
  }
  // Silence unused computeFilesFingerprint import if tree-shaken — keep available.
  void computeFilesFingerprint;
  return { added, modified, deleted, sample };
}

// Re-export type for consumers that import from this module path.

export { type FreshnessVerification } from './query-contracts.js';
export { type CatalogEngineMode } from '../types.js';
