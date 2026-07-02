/**
 * scope-access — per-run scope + datastore readers.
 *
 * Extracted from `cli-context.ts` so that module stays focused on context
 * ASSEMBLY (live-view registry + `buildToolCliContext`). This module owns the
 * complementary concern: reading the entered `RunScope` and opening the
 * project-local SQLite datastore lazily.
 *
 * After Phase 3 hygiene the ONLY way to obtain the per-run scope is
 * `currentScope()` (entered by the pre-action-hook, or explicit `runWithScope`
 * in tests). There are no holder fallbacks. Non-action paths (report, errors)
 * that need scope must ensure entry or restructure to run inside an entered
 * action.
 */

import {
  ConfigurationError,
  type Logger,
  type ProjectContext,
  type RunScope,
  SystemError,
  currentScope,
  logger as defaultLogger,
  resolveEphemeralProjectPaths,
  resolveProjectPaths,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';

import { buildDatastoreLockContext } from './state-lock-policy.js';

/**
 * Strict reader: the only way to obtain the per-run scope is `currentScope()`
 * (entered by pre-action-hook or explicit runWithScope in tests). All previous
 * holder fallbacks were removed.
 *
 * @throws {SystemError} (`SYSTEM.SCOPE.NOT_ENTERED`) When accessed before the
 *   pre-action-hook constructed and entered the scope.
 */
export function readScope(): RunScope {
  const bound = currentScope();
  if (!bound) {
    throw new SystemError(
      'CLI scope accessed before pre-action-hook constructed and entered it (enterScope + ALS). ' +
        'All production paths (tool actions, host commands, report/error seams) must run inside ' +
        'an entered RunScope. See host-planes-scope-seams-hygiene plan Phase 3 and currentScope().',
      { code: 'SYSTEM.SCOPE.NOT_ENTERED' },
    );
  }
  return bound;
}

/**
 * Read the current project root. Convenience for non-tool bootstrap
 * helpers (e.g. `maybeOpenReport`) that need the project root but
 * don't carry a ToolCliContext.
 *
 * @throws {SystemError} (`SYSTEM.BOOTSTRAP.PROJECT_UNSET`) When accessed before
 *   the pre-action-hook resolved the context.
 */
export function getCurrentProjectRoot(): string {
  const project = readScope().projectContext;
  if (!project) {
    throw new SystemError(
      'getCurrentProjectRoot() called before pre-action-hook resolved the context.',
      { code: 'SYSTEM.BOOTSTRAP.PROJECT_UNSET' },
    );
  }
  return project.projectRoot;
}

/**
 * A lazy datastore accessor (callable) that also exposes a `dispose()` to close
 * the cached connection on scope teardown. Still assignable to the kernel's
 * `DataStoreThunk` (`() => unknown`) — `dispose` is additive.
 */
export interface DatastoreThunk {
  (): DataStore;
  /**
   * Close the cached connection (no-op if it was never opened). An arrow-type
   * property, not a method, so it can be passed straight to `scope.onDispose`
   * (no unbound-method footgun) while still being assignable on construction.
   */
  dispose: () => void;
}

/**
 * Build a closure-based datastore thunk for the given project.
 * Caches the open DataStore on first access. The pre-action-hook
 * wires the result into `RunScope.datastore` so tools and CLI
 * commands reach the same instance.
 *
 * @throws {SystemError} (`SYSTEM.BOOTSTRAP.DATASTORE_OUTSIDE_PROJECT`) When the
 *   returned thunk is invoked outside a runtime-backed project scope — callers
 *   must check the command scope first or handle the throw as a "no project
 *   found" error.
 */
export function buildDatastoreThunk(
  project: ProjectContext,
  log: Logger = defaultLogger,
  commandName?: string,
): DatastoreThunk {
  let cached: DataStore | undefined;
  const thunk = (() => {
    if (cached) return cached;
    if (project.scope !== 'project' && project.scope !== 'ephemeral') {
      throw new SystemError(
        'Datastore accessed in a non-project context. The action body should have ' +
          'errored earlier with "No OpenSIP CLI project found" before touching this.',
        { code: 'SYSTEM.BOOTSTRAP.DATASTORE_OUTSIDE_PROJECT' },
      );
    }
    const runtime =
      project.scope === 'ephemeral'
        ? resolveEphemeralProjectPaths(project.projectRoot)
        : resolveProjectPaths(project.projectRoot);
    const path = `${runtime.runtimeDir}/datastore.sqlite`;
    cached = DataStoreFactory.open({
      backend: 'sqlite',
      path,
      lock: buildDatastoreLockContext(log, {
        cwd: project.projectRoot,
        commandName,
      }),
    });
    log.info({
      evt: 'cli.datastore.opened',
      module: 'cli:context',
      path,
    });
    return cached;
  }) as DatastoreThunk;
  // Close the cached connection on scope teardown (registered via
  // `scope.onDispose`). Closing checkpoints + truncates the WAL; without this the
  // connection (and its growing -wal sidecar) leaked for the process lifetime.
  thunk.dispose = (): void => {
    if (!cached) return;
    cached.close();
    cached = undefined;
    log.info({ evt: 'cli.datastore.closed', module: 'cli:context' });
  };
  return thunk;
}

/**
 * Open (or return cached) project-local SQLite DataStore via the
 * scope's datastore thunk. Shared between tool action bodies and
 * the host commands (e.g. `sessions`, in `host-subcommand-groups.ts`) so
 * both paths are equally lazy.
 *
 * @throws {SystemError} When called outside a project scope — see
 *   `buildDatastoreThunk`'s contract.
 */
export function getOrOpenDatastore(_log: Logger = defaultLogger): DataStore {
  const thunk = readScope().datastore;
  return thunk() as DataStore;
}

/**
 * Project-scoped datastore accessor for the host-owned planes (baseline,
 * toolState, hostPlanes). Converts the internal DATASTORE_OUTSIDE_PROJECT
 * SystemError into a clear ConfigurationError so callers of the documented
 * ToolCliContext seams get a user-actionable error (exit 2) instead of an
 * internal SYSTEM.* code.
 *
 * @throws {ConfigurationError} When called outside a project scope (no open
 *   datastore); other datastore-open failures propagate unchanged.
 */
export function getProjectDatastore(): DataStore {
  try {
    return getOrOpenDatastore();
  } catch (error) {
    if (
      error instanceof SystemError &&
      error.code === 'SYSTEM.BOOTSTRAP.DATASTORE_OUTSIDE_PROJECT'
    ) {
      throw new ConfigurationError(
        'This operation requires an OpenSIP CLI project (an opensip-cli.config.yml with a targets: block or similar). ' +
          'Run from within a project directory, or pass --cwd to an initialized project.',
        { code: 'CONFIGURATION.REQUIRES_PROJECT' },
      );
    }
    throw error;
  }
}

/** How a datastore resolver should behave when scope or project context is absent. */
export type DatastoreResolverMode = 'strict' | 'project-seam' | 'best-effort';

/**
 * Unified lazy datastore accessor for host planes and the run plane.
 *
 * - `strict` — throws when outside a project scope (via `getOrOpenDatastore`).
 * - `project-seam` — maps outside-project to `ConfigurationError` for documented seams.
 * - `best-effort` — returns `undefined` when scope or datastore is unavailable.
 */
export function createDatastoreResolver(
  mode: 'strict' | 'project-seam',
  logger?: Logger,
): () => DataStore;
export function createDatastoreResolver(
  mode: 'best-effort',
  logger?: Logger,
): () => DataStore | undefined;
export function createDatastoreResolver(
  mode: DatastoreResolverMode,
  logger: Logger = defaultLogger,
): () => DataStore | undefined {
  switch (mode) {
    case 'strict': {
      return () => getOrOpenDatastore(logger);
    }
    case 'project-seam': {
      return () => getProjectDatastore();
    }
    case 'best-effort': {
      return () => {
        try {
          const thunk = readScope().datastore;
          return thunk ? (thunk() as DataStore) : undefined;
        } catch (error) {
          logger.debug({
            evt: 'cli.context.datastore_unavailable',
            module: 'cli:context',
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      };
    }
  }
}
