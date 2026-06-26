/**
 * state-lock-policy — resolves datastore/artifact write-lock timing from host env.
 *
 * Local interactive runs wait longer and recover stale locks; CI/non-interactive
 * runs fail fast by default. All overrides flow through {@link hostEnv}.
 */

import { basename } from 'node:path';

import {
  ConfigurationError,
  currentScope,
  type FileLockEvent,
  type Logger,
  type StateLockPolicy,
} from '@opensip-cli/core';

import { hostEnv } from '../env/host-env-specs.js';

import type { DataStoreLockContext } from '@opensip-cli/datastore';

const DEFAULT_LOCAL_WAIT_MS = 30_000;
const DEFAULT_CI_WAIT_MS = 5000;
const DEFAULT_STALE_MS = 600_000;
const DEFAULT_HEARTBEAT_MS = 2000;

function parseNonNegativeLockOverride(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(`${name} must be a non-negative integer`, {
      code: 'CONFIGURATION.STATE_LOCK.INVALID_OVERRIDE',
    });
  }
  return value;
}

function isCiEnv(): boolean {
  const ci = hostEnv.get<string | undefined>('CI');
  return ci !== undefined && ci.length > 0 && ci !== '0' && ci.toLowerCase() !== 'false';
}

/** Resolve lock timing policy from host env and interactive/CI context. */
export function resolveStateLockPolicy(input?: { readonly commandName?: string }): StateLockPolicy {
  const waitOverride = hostEnv.get<string | undefined>('OPENSIP_STATE_LOCK_WAIT_MS');
  const staleOverride = hostEnv.get<string | undefined>('OPENSIP_STATE_LOCK_STALE_MS');

  const defaultWait = isCiEnv() ? DEFAULT_CI_WAIT_MS : DEFAULT_LOCAL_WAIT_MS;
  const waitMs =
    waitOverride === undefined
      ? defaultWait
      : parseNonNegativeLockOverride(waitOverride, 'OPENSIP_STATE_LOCK_WAIT_MS');
  const staleMs =
    staleOverride === undefined
      ? DEFAULT_STALE_MS
      : parseNonNegativeLockOverride(staleOverride, 'OPENSIP_STATE_LOCK_STALE_MS');

  void input?.commandName;
  return {
    waitMs,
    staleMs,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
  };
}

/** Map generic lock events to logger + RunDiagnostics (phase `persist`). */
const LOCK_EVENT_LOGGER_NAMES: Record<FileLockEvent['kind'], string> = {
  'acquire.start': 'state.lock.acquire.start',
  'acquire.wait': 'state.lock.acquire.wait',
  'acquire.complete': 'state.lock.acquire.complete',
  'acquire.timeout': 'state.lock.acquire.timeout',
  'stale.recovered': 'state.lock.stale.recovered',
};

export function createStateLockEventBridge(logger: Logger): (event: FileLockEvent) => void {
  return (event) => {
    const loggerEvt = LOCK_EVENT_LOGGER_NAMES[event.kind];

    logger.info({
      evt: loggerEvt,
      module: 'cli:state-lock',
      resource: event.resource,
      operation: event.operation,
      waitMs: event.waitMs,
      ownerPid: event.ownerPid,
      ownerHostname: event.ownerHostname,
    });

    const scope = currentScope();
    scope?.diagnostics?.event(
      'persist',
      event.kind === 'acquire.timeout' ? 'warn' : 'info',
      loggerEvt,
      {
        resource: event.resource,
        operation: event.operation,
        waitMs: event.waitMs,
        ownerPid: event.ownerPid,
        ownerHostname: event.ownerHostname,
      },
    );
  };
}

/** Build datastore lock context for {@link DataStoreFactory.open}. */
export function buildDatastoreLockContext(
  logger: Logger,
  input?: { readonly commandName?: string; readonly cwd?: string },
): DataStoreLockContext {
  const scope = currentScope();
  return {
    policy: resolveStateLockPolicy(input),
    runId: scope?.runId,
    command: input?.commandName,
    cwdBasename: input?.cwd ? basename(input.cwd) : basename(process.cwd()),
    onLockEvent: createStateLockEventBridge(logger),
  };
}
