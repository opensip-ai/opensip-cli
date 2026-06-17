// @fitness-ignore-file toctou-race-condition -- cache check + populate is synchronous (sync file I/O + Map.set); no async gap, safe in single-threaded Node.js
// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (signaler entries listed in opensip-cli.config.yml)
/**
 * @fileoverview Load and cache opensip-cli.config.yml
 *
 * Reads the signalers config file (path resolved via config-resolution),
 * validates with Zod, and returns a frozen SignalersConfig. Throws when
 * the config file is missing — silent no-op would mask a broken scan.
 */

import {
  PROJECT_CONFIG_FILENAME,
  ValidationError,
  currentScope,
  readYamlFileOrThrow,
  resolveProjectConfigPath,
  logger,
} from '@opensip-cli/core';

import { SignalersConfigSchema } from './schema.js';

import type { SignalersConfig } from './types.js';

/**
 * Recursively freeze every nested object so the `DeepReadonly` claim
 * on `SignalersConfig` is honoured at runtime, not just at the type
 * level. The previous implementation aliased `structuredClone` under
 * the name `deepFreeze` — it copied without freezing, so the
 * `SignalersConfig` readonly type was a lie at runtime. Audit-round-2
 * Finding E.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** TTL for cached signalers config entries in milliseconds (30 seconds) */
const SIGNALERS_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  config: SignalersConfig;
  cachedAt: number;
  filePath: string;
}

/** Cache keyed by resolved absolute file path, not rootDir — avoids
 *  stale hits when the same rootDir resolves to different files over
 *  time (e.g. --config flag changes between invocations in tests). */
const cache = new Map<string, CacheEntry>();

/** Per-document memo for the scope-first path: one projection per validated
 *  document object (the host builds one document per run, so this is a
 *  per-run cache with no TTL/invalidation concerns — the key IS the run's
 *  document identity). */
const scopeDocumentCache = new WeakMap<object, SignalersConfig>();

/**
 * Validate an already-parsed config document and project it into the frozen
 * `SignalersConfig` shape. Shared by the scope-first and file-read paths —
 * the fitness-specific projection/validation lives here exactly once.
 *
 * @throws {ValidationError} When the document fails fitness's schema.
 */
function projectSignalersConfig(parsed: unknown, sourceLabel: string): SignalersConfig {
  const result = SignalersConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message} (expected: ${i.code})`)
      .join('\n');
    // @fitness-ignore-next-line result-pattern-consistency -- user config error surfaced as a thrown ValidationError (mapped to an exit code by the loader's caller); a malformed signalers config is fail-loud at load time, not an expected-failure Result flow.
    throw new ValidationError(`${sourceLabel} validation failed:\n${issues}`, {
      operation: 'load',
      loader: 'signalers',
      filePath: sourceLabel,
      code: 'ERRORS.SIGNALERS.VALIDATION_FAILED',
    });
  }

  const data = result.data;

  logger.info({
    evt: 'core.signalers.config.loaded',
    module: 'core:signalers',
    file: sourceLabel,
    hasFitness: data.fitness !== undefined,
    hasSimulation: data.simulation !== undefined,
    targetCount: Object.keys(data.targets).length,
  });

  // `data` is typed `z.infer<typeof SignalersConfigSchema>` (mutable).
  // After deepFreeze it's structurally read-only end-to-end; the single
  // cast adds the `DeepReadonly` wrapper that defines `SignalersConfig`.
  return deepFreeze(data);
}

/**
 * Load and validate opensip-cli.config.yml from the given root directory.
 *
 * SCOPE-FIRST (ADR-0023 one-reader): when the current `RunScope` carries the
 * host-validated config document (`scope.configDocument`, attached by the CLI
 * pre-action hook after its single `readYamlFile`), this loader projects the
 * fitness shape from THAT document — no second file read, no chance of the
 * tool resolving a different file than the host did. The file-read fallback
 * below serves scope-less callers only (programmatic use, unit tests).
 *
 * Fallback resolution: --config (explicit) → package.json#opensip-cli.configPath
 * → <rootDir>/opensip-cli.config.yml. See resolveProjectConfigPath().
 * Results are cached per resolved file path.
 *
 * @param rootDir - Absolute path to the project root directory
 * @param explicitPath - Optional config path from --config CLI flag
 * @throws {ValidationError} When no config is found, YAML is invalid, or
 *   schema validation fails. Intentionally loud: a missing config means
 *   the scan would otherwise silently produce zero findings.
 */
export function loadSignalersConfig(rootDir: string, explicitPath?: string): SignalersConfig {
  const scope = currentScope();
  const scopeDocument = scope?.configDocument;
  if (scopeDocument !== undefined) {
    const memo = scopeDocumentCache.get(scopeDocument);
    if (memo) return memo;
    const config = projectSignalersConfig(
      scopeDocument,
      scope?.projectContext?.configPath ?? PROJECT_CONFIG_FILENAME,
    );
    scopeDocumentCache.set(scopeDocument, config);
    return config;
  }
  if (scope !== undefined) {
    throw new ValidationError(
      `${PROJECT_CONFIG_FILENAME}: current RunScope has no validated configDocument; ` +
        'refusing a second config-file read from a scoped fitness run.',
      {
        operation: 'load',
        loader: 'signalers',
        code: 'ERRORS.SIGNALERS.SCOPE_CONFIG_MISSING',
      },
    );
  }

  const filePath = resolveProjectConfigPath(rootDir, explicitPath);

  const cached = cache.get(filePath);
  if (cached && Date.now() - cached.cachedAt < SIGNALERS_CACHE_TTL_MS) {
    return cached.config;
  }

  // Strict YAML read + parse via the shared core helper (audit-round-2
  // Finding F). Raises `SystemError` if the file is larger than the
  // default 10 MB cap, `ValidationError` for missing / unreadable /
  // malformed YAML — same shape this loader used to throw inline.
  const parsed = readYamlFileOrThrow(filePath, { loader: 'signalers' });

  const frozen = projectSignalersConfig(parsed, filePath);
  cache.set(filePath, { config: frozen, cachedAt: Date.now(), filePath });
  return frozen;
}
