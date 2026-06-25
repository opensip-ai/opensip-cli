/**
 * dispatch-fork-core limit-path coverage — RPC flood, failureClass persistence.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SystemError } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { dispatchError } from '../dispatch-fork-core.js';

import { makeDispatchHostCtx } from '../../__tests__/harness/dispatch-host-ctx.js';
import { dispatchExternalToolCommand } from '../dispatch-external-tool-command.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT_WORKER = join(HERE, '../../__tests__/fixtures/dispatch-result-worker.mjs');
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
