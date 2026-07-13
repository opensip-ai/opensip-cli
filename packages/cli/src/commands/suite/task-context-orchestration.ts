import { realpath } from 'node:fs/promises';

import {
  EXIT_CODES,
  buildTaskContextFileScope,
  buildTaskContextProjectIdentity,
  type SuiteRunResult,
  type TaskContextFileScope,
  type TaskContextManifest,
  type TaskContextSourceIdentity,
} from '@opensip-cli/contracts';
import { ConfigurationError, currentLogger, currentScope } from '@opensip-cli/core';

import { validateBuiltInAgentContextAuthority } from './agent-context-authority.js';
import { BUILT_IN_AGENT_CONTEXT_SUITE_NAME, type SuiteSource } from './built-in-suites.js';
import { buildTaskContextManifest } from './task-context-manifest.js';
import { captureTaskContextSourceIdentity } from './task-context-source-identity.js';

import type { SuiteStepReviewInput } from './review-brief.js';
import type { SuiteLedgerIdentity } from './run-ledger-persist.js';
import type { ValidatedSuite } from './validate-suite.js';

export type TaskContextPreparation =
  | { readonly aggregates: false; readonly cwd: string }
  | {
      readonly aggregates: true;
      readonly cwd: string;
      readonly sourceStart: TaskContextSourceIdentity;
      readonly producerVersion: string;
      readonly fileScope: TaskContextFileScope;
      readonly projectIdentity: string;
    };

export interface TaskContextPreparationInput {
  readonly name: string;
  readonly source?: SuiteSource;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
}

function contextDatastoreAvailable(): boolean {
  try {
    return currentScope()?.datastore() !== undefined;
  } catch {
    return false;
  }
}

async function captureContextSource(cwd: string): Promise<TaskContextSourceIdentity> {
  const configDocument = currentScope()?.configDocument;
  return captureTaskContextSourceIdentity({
    cwd,
    ...(configDocument === undefined ? {} : { configDocument }),
  });
}

async function canonicalTaskContextRoot(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot);
  } catch {
    throw new ConfigurationError('The task-context project root could not be canonicalized.', {
      code: 'CONFIG.SUITE.CONTEXT_PROJECT_ROOT_INVALID',
    });
  }
}

function assertSupportedSelectors(input: TaskContextPreparationInput): void {
  const since = input.suiteOpts.since;
  if (
    input.suiteOpts.changed === true ||
    input.defaultChanged === true ||
    (typeof since === 'string' && since.trim() !== '')
  ) {
    throw new ConfigurationError(
      'The built-in agent-context suite does not support --changed or --since; use repeatable --files for task selection.',
      { code: 'CONFIG.SUITE.CONTEXT_SELECTOR_UNSUPPORTED' },
    );
  }
}

function taskContextFileScope(rawFiles: unknown): TaskContextFileScope {
  if (
    rawFiles !== undefined &&
    (!Array.isArray(rawFiles) || rawFiles.some((file) => typeof file !== 'string'))
  ) {
    throw new ConfigurationError('Task-context files must be project-relative path strings.', {
      code: 'CONFIG.SUITE.CONTEXT_FILES_INVALID',
    });
  }
  try {
    return buildTaskContextFileScope((rawFiles ?? []) as readonly string[]);
  } catch {
    throw new ConfigurationError(
      'Task-context files must be a bounded set of normalized project-relative paths.',
      { code: 'CONFIG.SUITE.CONTEXT_FILES_INVALID' },
    );
  }
}

/** Validate and bind the built-in context suite before any producer runs. */
export async function prepareTaskContext(
  input: TaskContextPreparationInput,
  suite: ValidatedSuite,
  requestedCwd: string,
): Promise<TaskContextPreparation> {
  const aggregates =
    input.source === 'built-in' && input.name === BUILT_IN_AGENT_CONTEXT_SUITE_NAME;
  if (!aggregates) return { aggregates, cwd: requestedCwd };

  assertSupportedSelectors(input);
  const enteredScope = currentScope();
  const authority = validateBuiltInAgentContextAuthority({
    suite,
    provenance: enteredScope?.toolProvenance ?? [],
  });
  const cwd = await canonicalTaskContextRoot(
    enteredScope?.projectContext?.projectRoot ?? requestedCwd,
  );
  if (!contextDatastoreAvailable()) {
    throw new ConfigurationError(
      'The built-in agent-context suite requires an initialized project datastore.',
      { code: 'CONFIG.SUITE.CONTEXT_DATASTORE_REQUIRED' },
    );
  }
  const fileScope = taskContextFileScope(input.suiteOpts.files);
  return {
    aggregates,
    cwd,
    sourceStart: await captureContextSource(cwd),
    producerVersion: authority.producerVersion,
    fileScope,
    projectIdentity: buildTaskContextProjectIdentity(cwd),
  };
}

export async function taskContextManifestFor(input: {
  readonly preparation: TaskContextPreparation;
  readonly ledger: SuiteLedgerIdentity;
  readonly steps: readonly SuiteStepReviewInput[];
}): Promise<TaskContextManifest | undefined> {
  if (!input.preparation.aggregates) return;
  const sourceEnd = await captureContextSource(input.preparation.cwd);
  return buildTaskContextManifest({
    ledger: input.ledger,
    steps: input.steps,
    sourceStart: input.preparation.sourceStart,
    sourceEnd,
    expectedProducerVersion: input.preparation.producerVersion,
    fileScope: input.preparation.fileScope,
    createdAt: new Date().toISOString(),
    projectIdentity: input.preparation.projectIdentity,
  });
}

export function logTaskContextManifest(
  suite: string,
  manifest: TaskContextManifest | undefined,
): void {
  if (manifest === undefined) return;
  currentLogger().info?.({
    evt: 'cli.suite.context_manifest.built',
    suite,
    readiness: manifest.readiness,
    planes: manifest.planes.length,
    ready: manifest.planes.filter(
      (plane) => plane.status === 'rebuilt' || plane.status === 'reused',
    ).length,
    unavailable: manifest.planes.filter(
      (plane) => plane.status === 'failed' || plane.status === 'cancelled',
    ).length,
  });
}

/** A context result is never reported ready when its parent ledger write failed. */
export function resultWithPersistence(
  base: SuiteRunResult,
  runId: string | undefined,
): SuiteRunResult {
  if (runId !== undefined) return { ...base, runId };
  if (base.contextManifest === undefined) return base;
  return {
    ...base,
    exitCode: Math.max(base.exitCode, EXIT_CODES.RUNTIME_ERROR),
    contextManifest: {
      ...base.contextManifest,
      readiness: 'unavailable',
      reasonCodes: [...base.contextManifest.reasonCodes, 'ledger-persist-failed'],
      nextActions: [
        base.contextManifest.fileScope.mode === 'explicit'
          ? 'opensip suite run agent-context --files <same-explicit-files> --json'
          : 'opensip suite run agent-context --json',
      ],
    },
  };
}
