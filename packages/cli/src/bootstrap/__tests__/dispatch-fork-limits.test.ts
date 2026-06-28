/**
 * dispatch-fork-core limit-path coverage — RPC flood, failureClass persistence.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapToolErrorToExitCode } from '@opensip-cli/contracts';
import { ConfigurationError, NetworkError, NotFoundError, SystemError } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeDispatchHostCtx } from '../../__tests__/harness/dispatch-host-ctx.js';
import { dispatchExternalToolCommand } from '../dispatch-external-tool-command.js';
import { dispatchError } from '../dispatch-fork-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC_FLOOD_WORKER = join(HERE, 'fixtures/dispatch-rpc-flood-worker.mjs');

const SPEC = {
  toolId: 't',
  commandName: 'cmd',
  opts: {},
  positionals: [] as readonly string[],
  output: 'command-result' as const,
};

describe('dispatchError', () => {
  it('persists failureClass on SystemError', () => {
    const err = dispatchError(SPEC, 'boom', 'timeout');
    expect(err).toBeInstanceOf(SystemError);
    expect(err.failureClass).toBe('timeout');
  });

  it('rebuilds a ConfigurationError (→ exit 2) from a config-invalid worker error', () => {
    // The frozen exit-2 contract: a worker-side ConfigurationError (binary-not-found /
    // no-project / baseline-missing) arrives tagged `config-invalid` and the host
    // reconstructs a ConfigurationError — NOT a SystemError (which would be exit 1).
    const err = dispatchError(SPEC, 'no baseline found', 'config-invalid');
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(mapToolErrorToExitCode(err)).toBe(2);
  });

  it('rebuilds the typed subclass from the canonical code carried over the boundary', () => {
    // A non-config typed throw rides `tool-handler-throw` + its canonical code, so
    // the host restores the exact exit class (NotFound → 3, Network → 4).
    const notFound = dispatchError(SPEC, 'missing', 'tool-handler-throw', undefined, 'NOT_FOUND');
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect(mapToolErrorToExitCode(notFound)).toBe(3);

    const network = dispatchError(
      SPEC,
      'egress fail',
      'tool-handler-throw',
      undefined,
      'NETWORK_ERROR',
    );
    expect(network).toBeInstanceOf(NetworkError);
    expect(mapToolErrorToExitCode(network)).toBe(4);
  });

  it('falls through to SystemError (exit 1) for an absent or unrecognized canonical code', () => {
    const unknown = dispatchError(SPEC, 'boom', 'ipc_error', undefined, 'NOT_A_REAL_CODE');
    expect(unknown).toBeInstanceOf(SystemError);
    expect(mapToolErrorToExitCode(unknown)).toBe(1);
    // No code at all → still SystemError (the pre-existing genuine-fault path).
    expect(dispatchError(SPEC, 'boom', 'exit_nonzero')).toBeInstanceOf(SystemError);
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
