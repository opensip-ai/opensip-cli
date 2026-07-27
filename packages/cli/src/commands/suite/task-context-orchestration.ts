import { realpath } from 'node:fs/promises';

import {
  EXIT_CODES,
  buildTaskContextFileScope,
  buildTaskContextProjectIdentity,
  parseTaskContextManifest,
  type SuiteRunResult,
  type TaskContextFileScope,
  type TaskContextManifest,
  type TaskContextSourceIdentity,
} from '@opensip-cli/contracts';
import { ConfigurationError, currentLogger, currentScope, isRecord } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

import { validateBuiltInAgentContextAuthority } from './agent-context-authority.js';
import { BUILT_IN_AGENT_CONTEXT_SUITE_NAME, type SuiteSource } from './built-in-suites.js';
import { buildTaskContextManifest } from './task-context-manifest.js';
import { captureTaskContextSourceIdentity } from './task-context-source-identity.js';

import type { SuiteStepReviewInput } from './review-brief.js';
import type { SuiteLedgerIdentity } from './run-ledger-persist.js';
import type { ValidatedSuite } from './validate-suite.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const SUITE_INVALID = hostErrorCatalog.require('CLI.SUITE.INVALID');

interface TaskContextGraphReadScope {
  readonly contextCatalog: {
    generationIdentity():
      { readonly ok: true; readonly value: string | null } | { readonly ok: false };
  };
  readonly contextSnapshots: {
    get(id: string): {
      readonly id: string;
      readonly kind: string;
      readonly schemaVersion: number;
    } | null;
  };
}

function taskContextGraphReadScope(): TaskContextGraphReadScope | undefined {
  const scope: unknown = currentScope();
  if (!isRecord(scope) || !isRecord(scope.graph)) return;
  const graph = scope.graph;
  if (
    !isRecord(graph.contextCatalog) ||
    typeof graph.contextCatalog.generationIdentity !== 'function' ||
    !isRecord(graph.contextSnapshots) ||
    typeof graph.contextSnapshots.get !== 'function'
  ) {
    return;
  }
  return graph as unknown as TaskContextGraphReadScope;
}

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
      code: SUITE_INVALID.code,
      definition: SUITE_INVALID,
      metadata: { condition: 'context-project-root' },
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
      {
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'context-selector' },
      },
    );
  }
}

function taskContextFileScope(rawFiles: unknown): TaskContextFileScope {
  if (
    rawFiles !== undefined &&
    (!Array.isArray(rawFiles) || rawFiles.some((file) => typeof file !== 'string'))
  ) {
    throw new ConfigurationError('Task-context files must be project-relative path strings.', {
      code: SUITE_INVALID.code,
      definition: SUITE_INVALID,
      metadata: { condition: 'context-files' },
    });
  }
  try {
    return buildTaskContextFileScope((rawFiles ?? []) as readonly string[]);
  } catch {
    throw new ConfigurationError(
      'Task-context files must be a bounded set of normalized project-relative paths.',
      {
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'context-files' },
      },
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
      {
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'context-datastore-required' },
      },
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
  const manifest = buildTaskContextManifest({
    ledger: input.ledger,
    steps: input.steps,
    sourceStart: input.preparation.sourceStart,
    sourceEnd,
    expectedProducerVersion: input.preparation.producerVersion,
    fileScope: input.preparation.fileScope,
    createdAt: new Date().toISOString(),
    projectIdentity: input.preparation.projectIdentity,
  });
  return revalidateTaskContextPointers(manifest);
}

function rerunTaskContextAction(manifest: TaskContextManifest): string {
  return manifest.fileScope.mode === 'explicit'
    ? 'opensip suite run agent-context --files <same-explicit-files> --json'
    : 'opensip suite run agent-context --json';
}

function taskContextPointerFailures(manifest: TaskContextManifest): readonly string[] {
  const graph = taskContextGraphReadScope();
  if (graph === undefined) return ['context-pointer-verification-unavailable'];
  const failures: string[] = [];
  try {
    for (const plane of manifest.planes) {
      const pointer = plane.pointer;
      if (pointer === undefined) continue;
      if (pointer.kind === 'graph') {
        const identity = graph.contextCatalog.generationIdentity();
        if (!identity.ok || identity.value !== pointer.id) {
          failures.push('graph-pointer-missing-or-mismatched');
        }
        continue;
      }
      const snapshot = graph.contextSnapshots.get(pointer.id);
      if (
        snapshot?.id !== pointer.id ||
        snapshot?.kind !== pointer.kind ||
        snapshot?.schemaVersion !== pointer.schemaVersion
      ) {
        failures.push(`${pointer.kind}-pointer-missing-or-mismatched`);
      }
    }
  } catch {
    return ['context-pointer-verification-failed'];
  }
  return failures;
}

/** Recheck durable evidence while the caller holds the datastore write lock. */
export function taskContextPointersAvailable(manifest: TaskContextManifest): boolean {
  return taskContextPointerFailures(manifest).length === 0;
}

/** Fail closed if retention or another writer invalidated a just-produced exact pointer. */
export function revalidateTaskContextPointers(manifest: TaskContextManifest): TaskContextManifest {
  if (manifest.readiness === 'unavailable') return manifest;
  const failures = taskContextPointerFailures(manifest);
  if (failures.length === 0) return manifest;
  const reasonCodes = [...new Set([...failures, ...manifest.reasonCodes])].slice(0, 32);
  return parseTaskContextManifest({
    ...manifest,
    readiness: 'unavailable',
    reasonCodes,
    nextActions: [rerunTaskContextAction(manifest)],
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
      reasonCodes: [
        ...new Set(['ledger-persist-failed', ...base.contextManifest.reasonCodes]),
      ].slice(0, 32),
      nextActions: [rerunTaskContextAction(base.contextManifest)],
    },
  };
}
