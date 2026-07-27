/**
 * worker-datastore — denied ambient datastore thunk for isolated workers
 * (ADR-0145).
 *
 * Isolated workers receive a full RunScope for project/config/parse state, but
 * datastore access is host-RPC-only. Calling the ambient thunk (via
 * `cli.scope.datastore()` or `currentScope().datastore()`) fails loud with a
 * typed capability error — a projected context alone is insufficient because
 * external code can import `currentScope()` directly.
 */

import { PluginIncompatibleError, SystemError, type Logger } from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import type { DatastoreThunk } from './scope-access.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const WIRING_INVALID = hostErrorCatalog.require('CLI.HOST.WIRING_INVALID');

const DENIED_CODE = 'PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS' as const;

/** Startup trust posture derived from the exact internal command/marker pair. */
export type ToolRuntimeExecutionMode = 'host' | 'external-tool-worker' | 'capability-pack-worker';

const EXTERNAL_TOOL_WORKER_COMMAND = '__tool-command-worker';
const CAPABILITY_PACK_WORKER_COMMAND = '__capability-pack-worker';

function workerModeFor(commandPath: string): Exclude<ToolRuntimeExecutionMode, 'host'> | undefined {
  if (commandPath === EXTERNAL_TOOL_WORKER_COMMAND) return 'external-tool-worker';
  if (commandPath === CAPABILITY_PACK_WORKER_COMMAND) return 'capability-pack-worker';
  return undefined;
}

function resolveExecutionMode(
  commandPath: string,
  env: NodeJS.ProcessEnv,
): ToolRuntimeExecutionMode {
  const workerMode = workerModeFor(commandPath);
  const isWorkerEnv = env.OPENSIP_CLI_IN_TOOL_WORKER === '1';
  if (workerMode === undefined) {
    if (isWorkerEnv) {
      throw new SystemError(
        'OPENSIP_CLI_IN_TOOL_WORKER=1 without an authorized internal worker command path',
        {
          code: WIRING_INVALID.code,
          definition: WIRING_INVALID,
          metadata: { condition: 'worker-mode-mismatch' },
        },
      );
    }
    return 'host';
  }
  if (isWorkerEnv) return workerMode;
  throw new SystemError('Worker command path without OPENSIP_CLI_IN_TOOL_WORKER=1', {
    code: WIRING_INVALID.code,
    definition: WIRING_INVALID,
    metadata: { condition: 'worker-mode-mismatch' },
  });
}

/**
 * Resolve worker posture before startup discovery can import any external runtime.
 * The supervisor always places the internal command first in argv; any other argv
 * shape is a host invocation and therefore cannot pair with the worker marker.
 */
export function resolveStartupExecutionMode(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ToolRuntimeExecutionMode {
  return resolveExecutionMode(argv[0] ?? '', env);
}

/**
 * Build a per-invocation datastore thunk that always denies access.
 * Constructed fresh for each worker `buildPerRunScope` call — never cached on
 * a module singleton or `globalThis`.
 */
export function buildDeniedWorkerDatastoreThunk(logger: Logger): DatastoreThunk {
  /**
   * @throws {PluginIncompatibleError} Always; isolated workers have no ambient
   *   datastore capability.
   */
  function denyDatastoreAccess(): never {
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
  }
  // Cast via unknown: the callable always throws (never returns DataStore), so
  // TS would otherwise reject the DatastoreThunk shape.
  const thunk = denyDatastoreAccess as unknown as DatastoreThunk;
  thunk.current = () => void 0;
  // Dispose is a no-op: nothing was opened.
  thunk.dispose = () =>
    // Denied thunk never materialises a connection.
    ({ checkpointed: true, closed: true });
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
  return resolveExecutionMode(commandPath, env) === 'host' ? 'local' : 'host-rpc-only';
}
