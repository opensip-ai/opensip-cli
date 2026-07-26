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
import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import type { DataStoreLockContext } from '@opensip-cli/datastore';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const OPTION_INVALID = hostErrorCatalog.require('CONFIGURATION.HOST.OPTION_INVALID');

const DEFAULT_LOCAL_WAIT_MS = 30_000;
const DEFAULT_CI_WAIT_MS = 5000;
const DEFAULT_STALE_MS = 600_000;
const DEFAULT_HEARTBEAT_MS = 2000;

function parseNonNegativeLockOverride(raw: string, name: string): number {
  // Strict decimal digits only. A bare `Number()` accepts '', '  ', '1e3', '0x1F'
  // as 0/1000/31 — so a set-but-empty CI env var (the common `VAR=${{ maybeUnset }}`
  // pattern) would silently become `0`, and `staleMs = 0` makes every live lock
  // look stale (force-unlinked → mutual exclusion defeated → interleaved datastore
  // /baseline writes). Empty/whitespace is treated as "unset" by the caller; any
  // other non-decimal form is rejected loudly here.
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${name} must be a non-negative integer`, {
      code: OPTION_INVALID.code,
      definition: OPTION_INVALID,
      metadata: { condition: 'state-lock-override' },
    });
  }
  return Number(raw);
}

function isCiEnv(): boolean {
  const ci = hostEnv.get<string | undefined>('CI');
  return ci !== undefined && ci.length > 0 && ci !== '0' && ci.toLowerCase() !== 'false';
}

/** Resolve lock timing policy from host env and interactive/CI context. */
export function resolveStateLockPolicy(input?: { readonly commandName?: string }): StateLockPolicy {
  // Trim + treat empty as unset: a set-but-empty override must fall back to the
  // default, not coerce to 0 (see parseNonNegativeLockOverride).
  const waitOverride = hostEnv.get<string | undefined>('OPENSIP_STATE_LOCK_WAIT_MS')?.trim();
  const staleOverride = hostEnv.get<string | undefined>('OPENSIP_STATE_LOCK_STALE_MS')?.trim();

  const defaultWait = isCiEnv() ? DEFAULT_CI_WAIT_MS : DEFAULT_LOCAL_WAIT_MS;
  const waitMs =
    waitOverride === undefined || waitOverride === ''
      ? defaultWait
      : parseNonNegativeLockOverride(waitOverride, 'OPENSIP_STATE_LOCK_WAIT_MS');
  const staleMs =
    staleOverride === undefined || staleOverride === ''
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
