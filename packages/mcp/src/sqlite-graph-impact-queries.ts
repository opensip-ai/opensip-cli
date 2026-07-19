/**
 * Impact-query helpers for the SQLite graph read port (sibling to the
 * symbol/package/declaration query modules): input validation, the
 * missing-catalog projection, and next-action derivation. Pure helpers —
 * the port owns orchestration and evidence-envelope assembly.
 */

import { buildImpactTrust } from '@opensip-cli/contracts';
import { err, ok, type Result } from '@opensip-cli/core';
import { makeFacet, rollupFacets, UNREQUESTED_FACET } from '@opensip-cli/graph/read';

import { readError, type McpReadError } from './mcp-error.js';
import {
  INVALID_INPUT,
  MAX_CONTEXT_DEPTH,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_ROWS,
  safeProjectFile,
} from './sqlite-graph-file-input.js';

import type { ImpactFilesDto, ImpactFilesOptions } from './graph-read-port.js';

export function validateImpactInput(
  files: readonly string[],
  options: ImpactFilesOptions | undefined,
): Result<void, McpReadError> {
  if (files.length === 0) {
    return err(readError(INVALID_INPUT, 'Impact reads require at least one explicit file.'));
  }
  if (files.length > MAX_CONTEXT_FILES) {
    return err(
      readError('input-cap-exceeded', 'Impact file count exceeds the supported maximum.', {
        maximum: MAX_CONTEXT_FILES,
      }),
    );
  }
  const normalized = files.map((file) => file.replaceAll('\\', '/'));
  if (normalized.some((file) => !safeProjectFile(file))) {
    return err(readError(INVALID_INPUT, 'Impact files must be project-relative paths.'));
  }
  if (new Set(normalized).size !== normalized.length) {
    return err(readError(INVALID_INPUT, 'Impact files must be unique after normalization.'));
  }
  if (
    options?.maxDepth !== undefined &&
    (!Number.isSafeInteger(options.maxDepth) ||
      options.maxDepth < 1 ||
      options.maxDepth > MAX_CONTEXT_DEPTH)
  ) {
    return err(readError(INVALID_INPUT, 'Impact depth is outside the supported range.'));
  }
  if (
    options?.top !== undefined &&
    (!Number.isSafeInteger(options.top) || options.top < 1 || options.top > MAX_CONTEXT_ROWS)
  ) {
    return err(readError(INVALID_INPUT, 'Impact top is outside the supported range.'));
  }
  return ok(undefined);
}

export function missingImpact(files: readonly string[]): ImpactFilesDto {
  const requestedFiles = [...files].map((file) => file.replaceAll('\\', '/')).sort();
  const coverage = rollupFacets({
    inventory: makeFacet(true, new Set(['graph-catalog-missing'])),
    evidence: UNREQUESTED_FACET,
    grouping: UNREQUESTED_FACET,
    projection: UNREQUESTED_FACET,
  });
  const trust = buildImpactTrust({
    fallback: 'full-run',
    uncertainties: [
      {
        code: 'graph-catalog-unavailable',
        source: 'catalog',
        message: 'No graph catalog is loaded; impact cannot be computed safely.',
      },
    ],
  });
  return {
    changedFunctions: [],
    impactedFunctions: [],
    impactedPackages: [],
    impactedFiles: [],
    requestedFiles,
    matchedFiles: [],
    unmatchedFiles: requestedFiles,
    trust,
    truncated: false,
    coverage,
    nextActions: [
      'Run refresh_graph, then retry impact_files.',
      'Run the full verification suite.',
    ],
  };
}

export function impactNextActions(
  impact: Omit<ImpactFilesDto, 'nextActions'>,
  fresh: boolean,
): readonly string[] {
  const actions: string[] = [];
  if (!fresh) actions.push('Run refresh_graph, then retry impact_files.');
  if (impact.trust.fallback === 'full-run') actions.push('Run the full verification suite.');
  else if (impact.unmatchedFiles.length > 0) {
    actions.push('Run package or full verification for unmatched files.');
  }
  return actions;
}
