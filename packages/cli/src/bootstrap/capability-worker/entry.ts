import { readFileSync } from 'node:fs';

import {
  currentScope,
  defineCommand,
  IpcPayloadTooLargeError,
  sendWorkerIpcMessageAndDrain,
  startWorkerHeartbeat,
  toWorkerFailureWire,
  WORKER_FAILURE_WIRE_VERSION,
  type CommandSpec,
  type WorkerMessage,
} from '@opensip-cli/core';

import { type CliCommandsContext } from '../../commands/shared.js';

import { installCapabilityWorkerGuards } from './guards.js';

import type { CapabilityWorkerErrorPayload, CapabilityWorkerSpec } from './types.js';

type CapabilityWorkerMessage = WorkerMessage<never, unknown>;

/**
 * Terminal IPC send — drains before the worker process exits so the parent
 * does not race `exit` ahead of `message` (Linux under load).
 */
async function send(msg: CapabilityWorkerMessage): Promise<void> {
  try {
    await sendWorkerIpcMessageAndDrain(msg);
  } catch (error) {
    if (error instanceof IpcPayloadTooLargeError) {
      await sendWorkerIpcMessageAndDrain({
        kind: 'error',
        message: error.message,
        failureClass: 'payload_too_large',
      } satisfies CapabilityWorkerErrorPayload & { kind: 'error' });
      return;
    }
    throw error;
  }
}

function readSpec(specPath: string): CapabilityWorkerSpec {
  return JSON.parse(readFileSync(specPath, 'utf8')) as CapabilityWorkerSpec;
}

/**
 * Execute one worker request through the owning tool's isolation bridge.
 *
 * @throws {Error} when the owning tool has no bridge for the requested domain.
 */
async function runCapabilityWorker(spec: CapabilityWorkerSpec): Promise<unknown> {
  installCapabilityWorkerGuards({
    cwd: process.cwd(),
    packageDir: spec.pkg.packageDir,
    resourceDecision: spec.resourceDecision,
  });
  const tools = currentScope()?.tools;
  const tool =
    tools?.get(spec.ownerToolId) ??
    tools
      ?.list()
      .find(
        (candidate) =>
          candidate.metadata.id === spec.ownerToolId ||
          candidate.metadata.name === spec.ownerToolId,
      );
  const bridge = tool?.extensionPoints?.capabilityIsolationBridges?.[spec.domainId];
  if (bridge === undefined) {
    throw new Error(
      `capability worker: no isolation bridge for domain '${spec.domainId}' on tool '${spec.ownerToolId}'`,
    );
  }
  return await bridge.runInWorker({
    domainId: spec.domainId,
    descriptor: spec.descriptor,
    pkg: spec.pkg,
    resourceDecision: spec.resourceDecision,
    request: spec.request,
  });
}

export async function executeCapabilityWorker(specPath: string): Promise<void> {
  const stopHeartbeat = startWorkerHeartbeat();
  try {
    await send({
      kind: 'result',
      value: await runCapabilityWorker(readSpec(specPath)),
    });
  } catch (error) {
    const wire = toWorkerFailureWire(error);
    await send({
      kind: 'error',
      message: wire.message,
      ...(wire.failureClass === undefined ? {} : { failureClass: wire.failureClass }),
      ...(wire.code === undefined ? {} : { code: wire.code }),
      ...(wire.detailCode === undefined ? {} : { detailCode: wire.detailCode }),
      ...(wire.failure === undefined
        ? {}
        : { failure: wire.failure, failureWireVersion: WORKER_FAILURE_WIRE_VERSION }),
    });
  } finally {
    stopHeartbeat();
    // Give the parent event loop a beat to receive the drained IPC message
    // before this process exits. Without this, Linux under load can still
    // surface exit before message despite sendWorkerIpcMessageAndDrain.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export const capabilityWorkerCommandSpec: CommandSpec<unknown, CliCommandsContext> = defineCommand<
  unknown,
  CliCommandsContext
>({
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/bootstrap/capability-worker/entry.ts',
    declaration: 'capabilityWorkerCommandSpec',
  },
  name: '__capability-pack-worker',
  visibility: 'internal',
  description:
    '[internal] Run one capability-pack operation in a resource-bounded worker (forked by the capability isolation supervisor)',
  commonFlags: ['cwd'],
  options: [
    {
      flag: '--config',
      value: '<path>',
      description: 'Resolved project config inherited from the parent run',
    },
  ],
  args: [
    {
      name: 'specPath',
      description: 'Path to the JSON capability worker spec file',
    },
  ],
  scope: 'project',
  noInit: true,
  output: 'raw-stream',
  rawStreamReason: 'worker-ipc',
  handler: async (rawOpts): Promise<void> => {
    const specPath = (rawOpts as { _args?: readonly string[] })._args?.[0] ?? '';
    await executeCapabilityWorker(specPath);
  },
});
