/**
 * Test-selection helpers for the SQLite graph read port (sibling to the
 * symbol/package/declaration query modules): input validation, the
 * missing-catalog fallback selection, trust qualification, and proof-option
 * resolution. Pure helpers — the port owns orchestration and envelope assembly.
 */

import { createHash } from 'node:crypto';

import {
  TEST_SELECTION_SCHEMA_VERSION,
  type ProjectInventorySnapshot,
  type TestSelectionSnapshot,
  type VerificationCommand,
} from '@opensip-cli/contracts';
import { err, ok, type Result } from '@opensip-cli/core';
import { compareCodePointStrings } from '@opensip-cli/graph/read';

import { readError, type McpReadError } from './mcp-error.js';
import {
  INVALID_INPUT,
  MAX_CONTEXT_DEPTH,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_ROWS,
  safeProjectFile,
} from './sqlite-graph-file-input.js';

import type { MissingGraphTestSelectionDto, SelectTestsOptions } from './graph-read-port.js';

function selectionSnapshotId(snapshot: object): string {
  return `ts1:${createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex')}`;
}

function selectionCommandKey(command: VerificationCommand): string {
  return `${command.cwd}\u0000${command.argv.join('\u0000')}`;
}

function fallbackCommands(
  inventory: ProjectInventorySnapshot,
  files: readonly string[],
  tier: NonNullable<SelectTestsOptions['tier']>,
  maximum: number,
): readonly VerificationCommand[] {
  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  const packageNames = new Set(
    files.flatMap((file) => {
      const name = byPath.get(file)?.packageName;
      return name === undefined ? [] : [name];
    }),
  );
  const allowed = tier === 'full' ? new Set(['full']) : new Set(['package', 'full']);
  const candidates = inventory.packages
    .filter((item) => packageNames.size === 0 || packageNames.has(item.name) || item.root === '.')
    .flatMap((item) => item.verificationCommands)
    .filter((command) => allowed.has(command.tier));
  const unique = new Map<string, VerificationCommand>();
  for (const command of candidates) unique.set(selectionCommandKey(command), command);
  return [...unique.values()]
    .sort((left, right) =>
      compareCodePointStrings(selectionCommandKey(left), selectionCommandKey(right)),
    )
    .slice(0, maximum);
}

export function missingSelection(
  files: readonly string[],
  inventory: ProjectInventorySnapshot,
  options: SelectTestsOptions | undefined,
): MissingGraphTestSelectionDto {
  const normalized = files.map((file) => file.replaceAll('\\', '/')).sort();
  const commands = fallbackCommands(
    inventory,
    normalized,
    options?.tier ?? 'focused',
    options?.commandLimit ?? 20,
  );
  const reasonCodes = [
    'graph-catalog-unavailable',
    ...(inventory.coverage.status === 'complete' ? [] : ['inventory-incomplete']),
  ];
  const withoutId: Omit<MissingGraphTestSelectionDto, 'snapshotId'> = {
    schemaVersion: TEST_SELECTION_SCHEMA_VERSION,
    files: normalized,
    tests: [],
    commands,
    uncoveredFiles: normalized,
    trust: {
      status: 'fallback',
      reasonCodes,
      fallbackTier: commands.some((command) => command.tier === 'package') ? 'package' : 'full',
    },
    graphIdentity: 'graph:missing',
    inventoryIdentity: inventory.snapshotId,
    durable: false,
  };
  return { ...withoutId, snapshotId: selectionSnapshotId(withoutId) };
}

/** Exported for the saturated-boundary regression test only (module-internal otherwise). */
export function qualifySelection(
  snapshot: TestSelectionSnapshot,
  reasons: readonly string[],
): TestSelectionSnapshot {
  // Skip the downgrade only when the incoming reasons are a SUBSET of the
  // existing set — decided before the 32-reason cap. The old post-slice
  // length-equality gate missed a downgrade at exactly the saturated
  // boundary: a new-but-equal-count reason set passed the length check.
  const existing = new Set(snapshot.trust.reasonCodes);
  if (reasons.every((reason) => existing.has(reason))) return snapshot;
  const reasonCodes = [...new Set([...snapshot.trust.reasonCodes, ...reasons])].sort().slice(0, 32);
  const withoutId: Omit<TestSelectionSnapshot, 'snapshotId'> = {
    schemaVersion: snapshot.schemaVersion,
    files: snapshot.files,
    tests: snapshot.tests,
    commands: snapshot.commands,
    uncoveredFiles: snapshot.uncoveredFiles,
    trust: {
      ...snapshot.trust,
      status: snapshot.tests.length === 0 ? 'fallback' : 'partial',
      reasonCodes,
    },
    graphIdentity: snapshot.graphIdentity,
    inventoryIdentity: snapshot.inventoryIdentity,
  };
  return { ...withoutId, snapshotId: selectionSnapshotId(withoutId) };
}

export function validateSelectionInput(
  files: readonly string[],
  options: SelectTestsOptions | undefined,
): Result<void, McpReadError> {
  if (files.length === 0) {
    return err(readError(INVALID_INPUT, 'Test selection requires explicit files.'));
  }
  if (files.length > MAX_CONTEXT_FILES) {
    return err(
      readError('input-cap-exceeded', 'Test-selection file count exceeds the maximum.', {
        maximum: MAX_CONTEXT_FILES,
      }),
    );
  }
  const normalized = files.map((file) => file.replaceAll('\\', '/'));
  if (normalized.some((file) => !safeProjectFile(file))) {
    return err(readError(INVALID_INPUT, 'Test-selection files must be project-relative paths.'));
  }
  if (new Set(normalized).size !== normalized.length) {
    return err(readError(INVALID_INPUT, 'Test-selection files must be unique.'));
  }
  if (
    options?.maxDepth !== undefined &&
    (!Number.isSafeInteger(options.maxDepth) ||
      options.maxDepth < 1 ||
      options.maxDepth > MAX_CONTEXT_DEPTH)
  ) {
    return err(readError(INVALID_INPUT, 'Test-selection depth is outside the supported range.'));
  }
  if (
    options?.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_CONTEXT_ROWS)
  ) {
    return err(readError(INVALID_INPUT, 'Test-selection limit is outside the supported range.'));
  }
  if (
    options?.commandLimit !== undefined &&
    (!Number.isSafeInteger(options.commandLimit) ||
      options.commandLimit < 1 ||
      options.commandLimit > 100)
  ) {
    return err(readError(INVALID_INPUT, 'Command limit is outside the supported range.'));
  }
  if (
    options?.proofLimit !== undefined &&
    (!Number.isSafeInteger(options.proofLimit) || options.proofLimit < 0 || options.proofLimit > 6)
  ) {
    return err(readError(INVALID_INPUT, 'Proof limit is outside the supported range.'));
  }
  return ok(undefined);
}

export function selectionProofOptions(options: SelectTestsOptions | undefined): {
  readonly includeProof: boolean;
  readonly maxProofNodes: number | undefined;
} {
  const detail = options?.proofDetail ?? 'summary';
  if (detail === 'none') return { includeProof: false, maxProofNodes: 0 };
  if (detail === 'summary') return { includeProof: true, maxProofNodes: 1 };
  return { includeProof: true, maxProofNodes: options?.proofLimit };
}
