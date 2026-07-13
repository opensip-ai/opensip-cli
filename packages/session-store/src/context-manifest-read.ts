import {
  TASK_CONTEXT_MANIFEST_SCHEMA_VERSION,
  buildTaskContextProjectIdentity,
  taskContextManifestSchema,
} from '@opensip-cli/contracts';
import { err, ok, type Result } from '@opensip-cli/core';

import { planeMatchesStoredStep } from './context-plane-authority.js';
import {
  aggregateMatchesStoredSteps,
  runExitMatchesAuthority,
  runMetadataIsSafe,
  storedStepsMatchV1Authority,
} from './context-run-authority.js';
import { RunRepo } from './run-repo.js';

import type { StoredRun, StoredRunStep, TaskContextManifest } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

export const TASK_CONTEXT_RUN_NAME = 'agent-context';

export type TaskContextRunReadReason =
  | 'missing'
  | 'pre-feature'
  | 'foreign-project'
  | 'wrong-run-kind'
  | 'unsupported-version'
  | 'invalid-manifest'
  | 'storage-failed';

export interface TaskContextRunReadError {
  readonly code: string;
  readonly reason: TaskContextRunReadReason;
  readonly message: string;
}

export interface StoredTaskContextRun {
  readonly run: StoredRun;
  readonly manifest: TaskContextManifest;
  readonly steps: readonly StoredRunStep[];
}

function readError(reason: TaskContextRunReadReason, message: string): TaskContextRunReadError {
  return {
    code: `CONTEXT.RUN.${reason.replaceAll('-', '_').toUpperCase()}`,
    reason,
    message,
  };
}

function manifestCreatedWithinRun(run: StoredRun, manifest: TaskContextManifest): boolean {
  const started = Date.parse(run.startedAt);
  const created = Date.parse(manifest.createdAt);
  const completed = Date.parse(run.completedAt);
  return started <= created && created <= completed;
}

function projectRun(
  repo: RunRepo,
  run: StoredRun,
  cwd: string,
): Result<StoredTaskContextRun, TaskContextRunReadError> {
  if (run.cwd !== cwd) {
    return err(
      readError('foreign-project', 'The requested task-context run belongs to another project.'),
    );
  }
  if (run.name !== TASK_CONTEXT_RUN_NAME) {
    return err(readError('wrong-run-kind', 'The requested run is not an agent-context run.'));
  }
  if (run.source !== 'built-in-suite') {
    return err(
      readError('wrong-run-kind', 'The requested run is not a built-in agent-context run.'),
    );
  }
  if (run.contextManifest === undefined) {
    return err(readError('pre-feature', 'The requested run predates task-context manifests.'));
  }
  const rawVersion = (run.contextManifest as { readonly schemaVersion?: unknown }).schemaVersion;
  if (rawVersion !== TASK_CONTEXT_MANIFEST_SCHEMA_VERSION) {
    return err(
      readError(
        'unsupported-version',
        'The recorded task-context manifest version is unsupported.',
      ),
    );
  }
  const parsed = taskContextManifestSchema.safeParse(run.contextManifest);
  if (!parsed.success) {
    return err(readError('invalid-manifest', 'The recorded task-context manifest is malformed.'));
  }
  const manifest = parsed.data as TaskContextManifest;
  const steps = repo.listStepsForRun(run.id, 17);
  if (
    steps.length > 16 ||
    !runMetadataIsSafe(run) ||
    !storedStepsMatchV1Authority(steps, run.id) ||
    !aggregateMatchesStoredSteps(run, steps) ||
    !runExitMatchesAuthority(run, manifest, steps) ||
    manifest.runId !== run.id ||
    !manifestCreatedWithinRun(run, manifest) ||
    manifest.projectIdentity !== buildTaskContextProjectIdentity(cwd)
  ) {
    return err(
      readError('invalid-manifest', 'The recorded task-context ledger references are invalid.'),
    );
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  const referencedStepIds = new Set<string>();
  for (const plane of manifest.planes) {
    const step = byId.get(plane.step.stepId);
    if (
      step === undefined ||
      referencedStepIds.has(plane.step.stepId) ||
      plane.step.runId !== run.id ||
      step.runId !== run.id ||
      step.logicalStepKey !== plane.step.logicalStepKey ||
      step.ordinal !== plane.step.ordinal ||
      step.attempt !== plane.step.attempt ||
      !planeMatchesStoredStep(plane, step, manifest)
    ) {
      return err(
        readError('invalid-manifest', 'The recorded task-context step references are invalid.'),
      );
    }
    referencedStepIds.add(plane.step.stepId);
  }
  if (
    manifest.readiness !== 'unavailable' &&
    (manifest.planes.length !== 3 || referencedStepIds.size !== 3)
  ) {
    return err(
      readError('invalid-manifest', 'The recorded task-context evidence set is incomplete.'),
    );
  }
  return ok({ run, manifest, steps });
}

/** Read the latest or exact project-scoped parent Run authority for task context. */
export function readTaskContextRun(input: {
  readonly datastore: DataStore;
  readonly cwd: string;
  readonly runId?: string;
}): Result<StoredTaskContextRun, TaskContextRunReadError> {
  try {
    const repo = new RunRepo(input.datastore);
    const run =
      input.runId === undefined
        ? repo.listRuns({
            cwd: input.cwd,
            name: TASK_CONTEXT_RUN_NAME,
            source: 'built-in-suite',
            limit: 1,
          })[0]
        : (repo.getRun(input.runId) ?? undefined);
    if (run === undefined) {
      return err(readError('missing', 'No recorded agent-context run exists for this project.'));
    }
    return projectRun(repo, run, input.cwd);
  } catch {
    return err(readError('storage-failed', 'Failed to read the recorded task-context run.'));
  }
}
