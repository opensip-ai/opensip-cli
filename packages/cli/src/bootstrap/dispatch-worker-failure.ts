/** Parent-side reconstruction for failures received from a tool-command worker. */

import {
  ConfigurationError,
  currentScope,
  SystemError,
  toolErrorFromWorkerFailureWire,
  type ToolError,
} from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import { BOOTSTRAP_MODULE } from './constants.js';

import type { ToolCommandWorkerSpec } from './tool-command-dispatch-types.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const DISPATCH_FAILED = hostErrorCatalog.require('CLI.HOST.DISPATCH_FAILED');

const MAX_WORKER_DETAIL_CODE_LENGTH = 128;
const ALLOWED_WORKER_DETAIL_CODES = new Set(['PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS']);

function allowlistedWorkerDetailCode(detailCode: string | undefined): string | undefined {
  if (
    detailCode === undefined ||
    detailCode.length > MAX_WORKER_DETAIL_CODE_LENGTH ||
    !ALLOWED_WORKER_DETAIL_CODES.has(detailCode)
  ) {
    return undefined;
  }
  return detailCode;
}

function specLabel(spec: ToolCommandWorkerSpec): string {
  /* v8 ignore next -- worker admission requires commandName or hook. */
  return spec.commandName ?? spec.hook ?? 'unknown';
}

export interface DispatchWorkerErrorMessage {
  readonly message: string;
  readonly failureClass?: string;
  readonly code?: string;
  readonly detailCode?: string;
  readonly failure?: Readonly<Record<string, unknown>>;
  readonly failureWireVersion?: number;
}

export interface DispatchErrorInput {
  readonly spec: ToolCommandWorkerSpec;
  readonly message: string;
  readonly failureClass: string;
  readonly stderrTail?: string;
  readonly code?: string;
  readonly detailCode?: string;
  readonly failure?: Readonly<Record<string, unknown>>;
  readonly failureWireVersion?: number;
}

/** Reconstruct a definition-backed failure received across the worker boundary. */
export function dispatchError({
  spec,
  message,
  failureClass,
  stderrTail,
  code,
  detailCode,
  failure,
  failureWireVersion,
}: DispatchErrorInput): ToolError {
  const label = specLabel(spec);
  const safeDetailCode = allowlistedWorkerDetailCode(detailCode);
  currentScope()?.logger.error({
    evt: 'cli.tool.dispatch_failed',
    module: BOOTSTRAP_MODULE,
    toolId: spec.toolId,
    command: label,
    failureClass,
  });
  if (failureClass === 'config-invalid') {
    return new ConfigurationError(message, {
      code: 'CONFIGURATION_ERROR',
      failureClass,
      stderrTail,
    });
  }
  const rebuilt = toolErrorFromWorkerFailureWire({
    message,
    failureClass,
    stderrTail,
    expectedOwnerId: spec.toolId,
    ...(code === undefined ? {} : { code }),
    ...(safeDetailCode === undefined ? {} : { detailCode: safeDetailCode }),
    ...(failure === undefined ? {} : { failure }),
    ...(failureWireVersion === undefined ? {} : { failureWireVersion }),
  });
  if (rebuilt !== undefined) return rebuilt;
  return new SystemError(`external tool '${spec.toolId}' ${label} failed: ${message}`, {
    code: DISPATCH_FAILED.code,
    definition: DISPATCH_FAILED,
    metadata: { condition: 'worker-failed' },
    failureClass,
    stderrTail,
  });
}

/** Convert a worker error message into a logged, structured failure. */
export function workerErrorToToolError(
  spec: ToolCommandWorkerSpec,
  msg: DispatchWorkerErrorMessage,
  stderrTail?: string,
): ToolError {
  return dispatchError({
    spec,
    message: msg.message,
    failureClass: msg.failureClass ?? 'ipc_error',
    stderrTail,
    code: msg.code,
    detailCode: msg.detailCode,
    failure: msg.failure,
    failureWireVersion: msg.failureWireVersion,
  });
}
