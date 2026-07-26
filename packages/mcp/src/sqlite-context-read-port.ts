/** SQLite/session-store backed exact task-context replay adapter. */

import { realpathSync } from 'node:fs';

import { buildTaskContextFileScope } from '@opensip-cli/contracts';
import { err, ok, type Result } from '@opensip-cli/core';
import { readTaskContextRun } from '@opensip-cli/session-store';

import { readError, type McpReadError, type McpReadReason } from './mcp-error.js';

import type { CodebaseReadPort } from './codebase-read-port.js';
import type {
  ContextReadPort,
  ContextRunMetadata,
  ContextRunReference,
  ContextStatusDto,
} from './context-read-port.js';
import type { ContextPointerStatus, GraphReadPort } from './graph-read-port.js';
import type {
  RunStepReference,
  StoredRun,
  TaskContextFileScope,
  TaskContextManifest,
} from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

export interface SqliteContextReadPortDeps {
  readonly store: DataStore;
  readonly projectRoot: string;
  readonly graph: GraphReadPort;
  readonly codebase: CodebaseReadPort;
  readonly log?: (
    event: string,
    fields: Readonly<Record<string, string | number | boolean | undefined>>,
  ) => void;
}

const RERUN_CONTEXT = 'Run opensip suite run agent-context --json to capture current context.';
const RERUN_EXPLICIT_CONTEXT =
  'Run opensip suite run agent-context with the same explicit --files set and --json to capture current context.';

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function runMetadata(run: StoredRun): ContextRunMetadata {
  return {
    id: run.id,
    name: run.name,
    source: run.source,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    aggregate: {
      steps: run.aggregate.steps,
      passed: run.aggregate.passed,
      failed: run.aggregate.failed,
      faulted: run.aggregate.faulted,
      errors: run.aggregate.errors,
      warnings: run.aggregate.warnings,
    },
    ...(run.cliVersion === undefined ? {} : { cliVersion: run.cliVersion }),
  };
}

function stepReference(step: {
  readonly id: string;
  readonly runId: string;
  readonly logicalStepKey: string;
  readonly ordinal: number;
  readonly attempt: number;
}): RunStepReference {
  return {
    runId: step.runId,
    stepId: step.id,
    logicalStepKey: step.logicalStepKey,
    ordinal: step.ordinal,
    attempt: step.attempt,
  };
}

function boundedActions(actions: readonly string[]): readonly string[] {
  return [...new Set(actions)].slice(0, 16);
}

function rerunAction(requested: TaskContextFileScope | undefined): string {
  return requested?.mode === 'explicit' ? RERUN_EXPLICIT_CONTEXT : RERUN_CONTEXT;
}

function sameFileScope(left: TaskContextFileScope, right: TaskContextFileScope): boolean {
  return (
    left.mode === right.mode &&
    left.fileCount === right.fileCount &&
    left.filesIdentity === right.filesIdentity
  );
}

function fileScopeStatus(
  requested: TaskContextFileScope | undefined,
  recorded: TaskContextFileScope | undefined,
): ContextStatusDto['fileScope'] {
  if (requested === undefined) {
    return {
      status: 'not-requested',
      ...(recorded === undefined ? {} : { recorded }),
    };
  }
  return {
    status: recorded !== undefined && sameFileScope(requested, recorded) ? 'matched' : 'mismatched',
    requested,
    ...(recorded === undefined ? {} : { recorded }),
  };
}

function requestedFileScope(
  ref: ContextRunReference | undefined,
): Result<TaskContextFileScope | undefined, McpReadError> {
  try {
    return ok(ref?.files === undefined ? undefined : buildTaskContextFileScope(ref.files));
  } catch {
    return err(
      readError(
        'invalid-context-files',
        'Task-context files must be a bounded set of project-relative paths.',
      ),
    );
  }
}

async function readPointerStatuses(
  graph: GraphReadPort,
  planes: TaskContextManifest['planes'],
  signal: AbortSignal | undefined,
): Promise<Result<readonly ContextPointerStatus[], McpReadError>> {
  const statuses: ContextPointerStatus[] = [];
  for (const plane of planes) {
    if (plane.pointer === undefined) continue;
    if (aborted(signal)) {
      return err(readError('cancelled', 'Task-context replay was cancelled.'));
    }
    const status = await graph.contextPointerStatus(plane.pointer, signal, {
      forceFresh: true,
    });
    if (!status.ok) return status;
    statuses.push(status.value);
  }
  return ok(statuses);
}

function replacePointerStatus(
  statuses: readonly ContextPointerStatus[],
  replacement: ContextPointerStatus,
): readonly ContextPointerStatus[] {
  return statuses.map((status) =>
    status.pointer.kind === replacement.pointer.kind && status.pointer.id === replacement.pointer.id
      ? replacement
      : status,
  );
}

/**
 * An exact inventory snapshot can still exist after the checkout has changed.
 * Verify its metadata identity against a fresh bounded inventory read, while
 * preserving the recorded pointer and never exposing or rebinding to the newer
 * identity.
 */
async function verifyCurrentInventory(
  codebase: CodebaseReadPort,
  manifest: TaskContextManifest,
  statuses: readonly ContextPointerStatus[],
  signal: AbortSignal | undefined,
): Promise<Result<readonly ContextPointerStatus[], McpReadError>> {
  const recorded = statuses.find(
    (status) => status.pointer.kind === 'inventory' && status.status === 'available',
  );
  if (recorded === undefined) return ok(statuses);

  const current = await codebase.inventoryStatus(signal, { forceFresh: true });
  if (!current.ok) {
    if (current.error.code === 'cancelled') return current;
    return ok(
      replacePointerStatus(statuses, {
        pointer: recorded.pointer,
        status: 'stale',
        reasonCodes: ['inventory-freshness-verification-failed'],
      }),
    );
  }

  const recordedIdentity = manifest.inventoryIdentity ?? recorded.pointer.id;
  const reasons: string[] = [];
  if (recorded.pointer.id !== recordedIdentity) {
    reasons.push('inventory-pointer-identity-mismatch');
  }
  if (current.value.identity !== recordedIdentity) {
    reasons.push('inventory-snapshot-not-current');
  }
  if (current.value.freshness.verification === 'missing') {
    reasons.push('inventory-freshness-unavailable');
  } else if (
    current.value.freshness.verification !== 'complete' ||
    !current.value.freshness.fresh
  ) {
    reasons.push('inventory-freshness-incomplete');
  }
  if (reasons.length === 0) return ok(statuses);

  return ok(
    replacePointerStatus(statuses, {
      pointer: recorded.pointer,
      status: 'stale',
      reasonCodes: reasons,
    }),
  );
}

function contextReadErrorCode(
  reason:
    | 'foreign-project'
    | 'wrong-run-kind'
    | 'unsupported-version'
    | 'invalid-manifest'
    | 'storage-failed',
): McpReadReason {
  switch (reason) {
    case 'foreign-project': {
      return 'context-run-foreign-project';
    }
    case 'wrong-run-kind': {
      return 'context-run-wrong-kind';
    }
    case 'unsupported-version': {
      return 'context-run-unsupported-version';
    }
    case 'invalid-manifest': {
      return 'context-run-invalid-manifest';
    }
    case 'storage-failed': {
      return 'context-run-read-failed';
    }
  }
}

export class SqliteContextReadPort implements ContextReadPort {
  private readonly projectRoot: string;
  private readonly store: DataStore;
  private readonly graph: GraphReadPort;
  private readonly codebase: CodebaseReadPort;
  private readonly log: SqliteContextReadPortDeps['log'];

  constructor(deps: SqliteContextReadPortDeps) {
    this.projectRoot = realpathSync(deps.projectRoot);
    this.store = deps.store;
    this.graph = deps.graph;
    this.codebase = deps.codebase;
    this.log = deps.log;
  }

  async contextStatus(
    ref?: ContextRunReference,
    signal?: AbortSignal,
  ): Promise<Result<ContextStatusDto, McpReadError>> {
    if (aborted(signal)) {
      return err(readError('cancelled', 'Task-context replay was cancelled.'));
    }
    const requestedScope = requestedFileScope(ref);
    if (!requestedScope.ok) return requestedScope;
    const requested = requestedScope.value;
    const recorded = readTaskContextRun({
      datastore: this.store,
      cwd: this.projectRoot,
      ...(ref?.runId === undefined ? {} : { runId: ref.runId }),
    });
    if (!recorded.ok) return this.projectReadFailure(recorded.error.reason, requested);
    if (aborted(signal)) {
      return err(readError('cancelled', 'Task-context replay was cancelled.'));
    }
    const pointerRead = await readPointerStatuses(
      this.graph,
      recorded.value.manifest.planes,
      signal,
    );
    if (!pointerRead.ok) return pointerRead;
    const inventoryVerification = await verifyCurrentInventory(
      this.codebase,
      recorded.value.manifest,
      pointerRead.value,
      signal,
    );
    if (!inventoryVerification.ok) return inventoryVerification;
    const pointerStatuses = inventoryVerification.value;
    const unavailable = pointerStatuses.filter((pointer) => pointer.status !== 'available').length;
    const fileScope = fileScopeStatus(requested, recorded.value.manifest.fileScope);
    const scopeMismatch = fileScope.status === 'mismatched';
    const reasonCodes = [
      ...recorded.value.manifest.reasonCodes,
      ...pointerStatuses.flatMap((pointer) => pointer.reasonCodes),
      ...(scopeMismatch ? ['context-scope-mismatch'] : []),
    ];
    const nextActions = boundedActions([
      ...recorded.value.manifest.nextActions,
      ...(unavailable === 0 && !scopeMismatch
        ? []
        : [rerunAction(requested ?? recorded.value.manifest.fileScope)]),
    ]);
    this.log?.('mcp.context.status.resolved', {
      readiness: recorded.value.manifest.readiness,
      pointerCount: pointerStatuses.length,
      unavailableCount: unavailable,
      scopeStatus: fileScope.status,
    });
    return ok({
      status: 'available',
      run: runMetadata(recorded.value.run),
      manifest: recorded.value.manifest,
      fileScope,
      steps: recorded.value.steps.map(stepReference),
      pointers: pointerStatuses,
      reasonCodes: [...new Set(reasonCodes)].slice(0, 32),
      nextActions,
    });
  }

  private projectReadFailure(
    reason:
      | 'missing'
      | 'pre-feature'
      | 'foreign-project'
      | 'wrong-run-kind'
      | 'unsupported-version'
      | 'invalid-manifest'
      | 'storage-failed',
    requestedFileScope: TaskContextFileScope | undefined,
  ): Result<ContextStatusDto, McpReadError> {
    if (reason === 'missing' || reason === 'pre-feature') {
      this.log?.('mcp.context.status.missing', {
        status: reason,
        pointerCount: 0,
        unavailableCount: 0,
      });
      return ok({
        status: reason === 'missing' ? 'missing' : 'unavailable',
        fileScope: fileScopeStatus(requestedFileScope, undefined),
        steps: [],
        pointers: [],
        reasonCodes: [
          `context-run-${reason}`,
          ...(requestedFileScope === undefined ? [] : ['context-scope-mismatch']),
        ],
        nextActions: [rerunAction(requestedFileScope)],
      });
    }
    const code = contextReadErrorCode(reason);
    return err(readError(code, 'The requested task-context run cannot be replayed safely.'));
  }
}
