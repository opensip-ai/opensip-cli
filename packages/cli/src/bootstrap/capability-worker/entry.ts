import { readFileSync } from 'node:fs';

import {
  currentScope,
  defineCommand,
  IpcPayloadTooLargeError,
  normalizeFailure,
  PluginIncompatibleError,
  sendWorkerIpcMessageAndDrain,
  startWorkerHeartbeat,
  startWorkerCancellationControl,
  toOperatorFailureProjection,
  toWorkerFailureWire,
  WORKER_FAILURE_WIRE_VERSION,
  type CommandSpec,
  type WorkerMessage,
} from '@opensip-cli/core';

import { type CliCommandsContext } from '../../commands/shared.js';
import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

import { installCapabilityWorkerGuards } from './guards.js';

import type { CapabilityWorkerErrorPayload, CapabilityWorkerSpec } from './types.js';

const NO_ISOLATION_BRIDGE = hostErrorCatalog.require('CLI.CAPABILITY_WORKER.NO_ISOLATION_BRIDGE');

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
    throw new PluginIncompatibleError(
      `capability worker: no isolation bridge for domain '${spec.domainId}' on tool '${spec.ownerToolId}'`,
      {
        code: NO_ISOLATION_BRIDGE.code,
        definition: NO_ISOLATION_BRIDGE,
        metadata: {
          condition: 'worker-bridge-missing',
          domainId: spec.domainId,
          ownerToolId: spec.ownerToolId,
        },
        diagnostic: `no isolation bridge for ${spec.domainId}`,
      },
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

/**
 * Emit a bounded operator projection of a worker fault to stderr.
 *
 * Best-effort by construction: a diagnostic must never be able to replace the failure it is
 * describing, so every step is guarded and a failure here is simply silence.
 */
function writeWorkerOperatorDetail(error: unknown): void {
  try {
    const projection = toOperatorFailureProjection(normalizeFailure(error));
    // Each part is narrowed to a string before joining: the projection is typed, but a hostile
    // or cross-version value reaching `join` unchecked would stringify as '[object Object]',
    // which is worse than the empty diagnostic this exists to replace.
    const parts: string[] = [projection.code, projection.message, projection.operatorDetail].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    process.stderr.write(`${parts.join(' | ').slice(0, 2000)}\n`);
  } catch {
    // @swallow-ok A diagnostic must not fail the failure path it exists to explain.
  }
}

export async function executeCapabilityWorker(specPath: string): Promise<void> {
  const stopHeartbeat = startWorkerHeartbeat();
  const stopCancellationControl = startWorkerCancellationControl();
  try {
    await send({
      kind: 'result',
      value: await runCapabilityWorker(readSpec(specPath)),
    });
  } catch (error) {
    // Write the OPERATOR projection to this worker's stderr before wiring the failure home.
    //
    // The wire carries the MACHINE projection, and for a `redacted` definition that projection
    // deliberately replaces the message with "The operation failed." — correct for a machine
    // sink, catastrophic as the only channel. An unclassified worker fault therefore reached
    // the host with no message, no cause and no operator detail: `capability pack X: The
    // operation failed.` was the entire diagnostic.
    //
    // `stderrTail` is the channel that already exists for this: the supervisor captures it,
    // bounds it, and attaches it to the error it raises. It was simply never written to. This
    // does not widen what crosses the IPC boundary (ADR-0146) — stderr is captured by the
    // parent, not echoed onward, and the operator projection is redacted at construction.
    writeWorkerOperatorDetail(error);
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
    stopCancellationControl();
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
