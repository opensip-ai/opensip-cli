/**
 * Shared utility — normalize a project directory path.
 *
 * Two callers per spec §2.1: stage 0 (discover) and stage 2 (edges).
 * Cache invalidation also normalizes tsConfigPath the same way, making
 * three callers and justifying extraction (rule of three).
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { createToolError, normalizeFailure } from '@opensip-cli/core';
import { graphErrorCatalog } from '@opensip-cli/graph';

const PROJECT_DIR_NOT_FOUND = graphErrorCatalog.require('GRAPH.PROJECT_DIR.NOT_FOUND');
const PROJECT_DIR_NOT_A_DIRECTORY = graphErrorCatalog.require('GRAPH.PROJECT_DIR.NOT_A_DIRECTORY');
const PROJECT_DIR_INSPECTION_FAILED = graphErrorCatalog.require(
  'GRAPH.PROJECT_DIR.INSPECTION_FAILED',
);

/**
 * Normalize a project directory: resolve to absolute, then realpath
 * (follows symlinks). Throws ConfigurationError if missing or not a
 * directory.
 *
 * @throws {ToolError} When the project root is missing, not a directory, or cannot be inspected.
 */
export function normalizeProjectDir(input: string): string {
  const absolute = isAbsolute(input) ? input : resolve(input);
  let stat;
  try {
    stat = statSync(absolute);
  } catch (error) {
    throw projectDirectoryFailure(error, 'project-stat');
  }
  if (!stat.isDirectory()) {
    throw createToolError(PROJECT_DIR_NOT_A_DIRECTORY, 'Graph project root is not a directory.', {
      metadata: { condition: 'project-stat' },
    });
  }
  try {
    return realpathSync(absolute);
  } catch (error) {
    throw projectDirectoryFailure(error, 'project-realpath');
  }
}

function projectDirectoryFailure(error: unknown, condition: string): Error {
  const failure = normalizeFailure(error);
  let definition = PROJECT_DIR_INSPECTION_FAILED;
  if (failure.code === 'CORE.SYSTEM.PERMISSION' || failure.code === 'CORE.SYSTEM.RESOURCE') {
    definition = failure.definition;
  } else if (failure.metadata.errno === 'ENOTDIR') {
    definition = PROJECT_DIR_NOT_A_DIRECTORY;
  } else if (failure.code === 'NOT_FOUND') {
    definition = PROJECT_DIR_NOT_FOUND;
  }
  return createToolError(definition, 'Graph project root could not be resolved.', {
    cause: error,
    metadata: {
      condition,
      ...(typeof failure.metadata.errno === 'string' ? { errno: failure.metadata.errno } : {}),
    },
  });
}
