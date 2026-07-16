/**
 * dispatch-fork-core limit-path coverage — RPC flood, failureClass persistence.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapToolErrorToExitCode } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  PluginIncompatibleError,
  SystemError,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeDispatchHostCtx } from '../../__tests__/harness/dispatch-host-ctx.js';
import { dispatchExternalToolCommand } from '../dispatch-external-tool-command.js';
import { dispatchError } from '../dispatch-fork-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC_FLOOD_WORKER = join(HERE, 'fixtures/dispatch-rpc-flood-worker.mjs');

const SPEC = {
  toolId: 't',
  toolPackageDir: join(HERE, 'tool'),
  source: 'installed' as const,
  commandName: 'cmd',
  opts: {},
  positionals: [] as readonly string[],
  output: 'command-result' as const,
};

describe('dispatchError', () => {
  it('persists failureClass on SystemError', () => {
    const err = dispatchError({
      spec: SPEC,
      message: 'boom',
      failureClass: 'timeout',
    });
    expect(err).toBeInstanceOf(SystemError);
    expect(err.failureClass).toBe('timeout');
  });

  it('rebuilds a ConfigurationError (→ exit 2) from a config-invalid worker error', () => {
    // The frozen exit-2 contract: a worker-side ConfigurationError (binary-not-found /
    // no-project / baseline-missing) arrives tagged `config-invalid` and the host
    // reconstructs a ConfigurationError — NOT a SystemError (which would be exit 1).
    const err = dispatchError({
      spec: SPEC,
      message: 'no baseline found',
      failureClass: 'config-invalid',
    });
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(mapToolErrorToExitCode(err)).toBe(2);
  });

  it('rebuilds the typed subclass from the canonical code carried over the boundary', () => {
    // A non-config typed throw rides `tool-handler-throw` + its canonical code, so
    // the host restores the exact exit class (NotFound → 3, Network → 4).
    const notFound = dispatchError({
      spec: SPEC,
      message: 'missing',
      failureClass: 'tool-handler-throw',
      code: 'NOT_FOUND',
    });
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect(mapToolErrorToExitCode(notFound)).toBe(3);

    const network = dispatchError({
      spec: SPEC,
      message: 'egress fail',
      failureClass: 'tool-handler-throw',
      code: 'NETWORK_ERROR',
    });
    expect(network).toBeInstanceOf(NetworkError);
    expect(mapToolErrorToExitCode(network)).toBe(4);
  });

  it('preserves a stable detail code separately from the canonical error class', () => {
    const denied = dispatchError({
      spec: SPEC,
      message: 'ambient datastore denied',
      failureClass: 'tool-handler-throw',
      code: 'PLUGIN_INCOMPATIBLE',
      detailCode: 'PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS',
    });
    expect(denied).toBeInstanceOf(PluginIncompatibleError);
    expect(denied.code).toBe('PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS');
    expect(mapToolErrorToExitCode(denied)).toBe(5);
  });

  it('drops an unrecognized worker detail code instead of reflecting it', () => {
    const denied = dispatchError({
      spec: SPEC,
      message: 'worker supplied a forged detail code',
      failureClass: 'tool-handler-throw',
      code: 'PLUGIN_INCOMPATIBLE',
      detailCode: 'PLUGIN.WORKER.FORGED_DETAIL_CODE',
    });
    expect(denied).toBeInstanceOf(PluginIncompatibleError);
    expect(denied.code).toBe('PLUGIN_INCOMPATIBLE');
  });

  it('drops an oversized worker detail code before reconstruction', () => {
    const denied = dispatchError({
      spec: SPEC,
      message: 'worker supplied an oversized detail code',
      failureClass: 'tool-handler-throw',
      code: 'PLUGIN_INCOMPATIBLE',
      detailCode: `PLUGIN.WORKER.${'X'.repeat(256)}`,
    });
    expect(denied).toBeInstanceOf(PluginIncompatibleError);
    expect(denied.code).toBe('PLUGIN_INCOMPATIBLE');
  });

  it('falls through to SystemError (exit 1) for an absent or unrecognized canonical code', () => {
    const unknown = dispatchError({
      spec: SPEC,
      message: 'boom',
      failureClass: 'ipc_error',
      code: 'NOT_A_REAL_CODE',
    });
    expect(unknown).toBeInstanceOf(SystemError);
    expect(mapToolErrorToExitCode(unknown)).toBe(1);
    // No code at all → still SystemError (the pre-existing genuine-fault path).
    expect(
      dispatchError({
        spec: SPEC,
        message: 'boom',
        failureClass: 'exit_nonzero',
      }),
    ).toBeInstanceOf(SystemError);
  });
});

describe('dispatch RPC backpressure', () => {
  afterEach(() => {
    delete process.env.OPENSIP_CLI_WORKER_MAX_TOTAL_RPC;
    delete process.env.OPENSIP_CLI_WORKER_MAX_CONCURRENT_RPC;
  });

  it('rejects rpc_flood when total RPC cap is exceeded', async () => {
    process.env.OPENSIP_CLI_WORKER_MAX_TOTAL_RPC = '1';
    const cap = makeDispatchHostCtx();
    await expect(
      dispatchExternalToolCommand({
        provenance: {
          source: 'installed',
          id: 'rpc-flood-tool',
          stableId: 's',
          version: '0',
          resolvedPath: HERE,
          manifestHash: 'h',
        },
        commandName: 'ext-run',
        opts: { mode: 'rpc-flood' },
        positionals: [],
        ctx: cap.ctx,
        cliScript: RPC_FLOOD_WORKER,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ failureClass: 'rpc_flood' });
  });
});
