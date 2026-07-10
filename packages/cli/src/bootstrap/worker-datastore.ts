/**
 * worker-datastore — denied ambient datastore thunk for external-tool workers
 * (ADR-0145).
 *
 * External workers receive a full RunScope for project/config/parse state, but
 * datastore access is host-RPC-only. Calling the ambient thunk (via
 * `cli.scope.datastore()` or `currentScope().datastore()`) fails loud with a
 * typed capability error — a projected context alone is insufficient because
 * external code can import `currentScope()` directly.
 */

import { PluginIncompatibleError, SystemError, type Logger } from '@opensip-cli/core';

import type { DatastoreThunk } from './scope-access.js';

const DENIED_CODE = 'PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS' as const;

/**
 * Build a per-invocation datastore thunk that always denies access.
 * Constructed fresh for each worker `buildPerRunScope` call — never cached on
 * a module singleton or `globalThis`.
 */
export function buildDeniedWorkerDatastoreThunk(logger: Logger): DatastoreThunk {
  // Cast via unknown: the body always throws (never returns DataStore), so TS
  // would otherwise reject the DatastoreThunk callable shape.
  const thunk = (() => {
    logger.warn({
      evt: 'cli.worker.datastore.access_denied',
      module: 'cli:worker-datastore',
      code: DENIED_CODE,
      mode: 'host-rpc-only',
    });
    throw new PluginIncompatibleError(
      'External tool workers cannot open a local project datastore. Use host RPC seams (toolState, baseline, hostPlanes, deliverSignals) for privileged persistence effects.',
      {
        code: DENIED_CODE,
        diagnostic: 'host-rpc-only: ambient datastore denied',
      },
    );
  }) as unknown as DatastoreThunk;
  // Dispose is a no-op: nothing was opened.
  thunk.dispose = (): void => {
    // Intentionally empty — denied thunk never materialises a connection.
  };
  return thunk;
}

/**
 * Pure gate: select ambient datastore mode from the internal command path and
 * the host-injected worker marker. Both must agree; a one-sided marker fails
 * closed so a forged parent env cannot silently switch trust posture.
 *
 * The marker is host-internal and may not be selected by a manifest, project
 * config, command option, or RPC field.
 */
export function resolveDatastoreAccess(
  commandPath: string,
  env: NodeJS.ProcessEnv,
): 'local' | 'host-rpc-only' {
  const isWorkerCommand = commandPath === '__tool-command-worker';
  const isWorkerEnv = env.OPENSIP_CLI_IN_TOOL_WORKER === '1';
  if (isWorkerCommand && isWorkerEnv) return 'host-rpc-only';
  if (!isWorkerCommand && !isWorkerEnv) return 'local';
  throw new SystemError(
    isWorkerCommand
      ? 'Worker command path without OPENSIP_CLI_IN_TOOL_WORKER=1'
      : 'OPENSIP_CLI_IN_TOOL_WORKER=1 without __tool-command-worker command path',
    { code: 'SYSTEM.WORKER.MODE_MISMATCH' },
  );
}
