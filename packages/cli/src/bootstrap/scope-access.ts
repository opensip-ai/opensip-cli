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
  resolveProjectPaths,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';

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
 * Build a closure-based datastore thunk for the given project.
 * Caches the open DataStore on first access. The pre-action-hook
 * wires the result into `RunScope.datastore` so tools and CLI
 * commands reach the same instance.
 *
 * @throws {SystemError} (`SYSTEM.BOOTSTRAP.DATASTORE_OUTSIDE_PROJECT`) When the
 *   returned thunk is invoked outside a project scope — callers must check
 *   `project.scope === 'project'` first or handle the throw as a "no project
 *   found" error.
 */
export function buildDatastoreThunk(
  project: ProjectContext,
  log: Logger = defaultLogger,
): () => DataStore {
  let cached: DataStore | undefined;
  return () => {
    if (cached) return cached;
    if (project.scope !== 'project') {
      throw new SystemError(
        'Datastore accessed in a non-project context. The action body should have ' +
          'errored earlier with "No OpenSIP CLI project found" before touching this.',
        { code: 'SYSTEM.BOOTSTRAP.DATASTORE_OUTSIDE_PROJECT' },
      );
    }
    const path = `${resolveProjectPaths(project.projectRoot).runtimeDir}/datastore.sqlite`;
    cached = DataStoreFactory.open({ backend: 'sqlite', path });
    log.info({
      evt: 'cli.datastore.opened',
      module: 'cli:context',
      path,
    });
    return cached;
  };
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
