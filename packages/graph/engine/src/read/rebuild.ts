/**
 * Public rebuild facade over runGraph.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import { runGraph } from '../cli/orchestrate.js';

import type { Catalog, GraphReadError, RunGraphInput } from './types.js';

function rebuildError(code: string, message: string): GraphReadError {
  const truncated = message.length > 160 ? message.slice(0, 157) + '...' : message;
  return { code, operation: 'rebuild', message: truncated };
}

/**
 * Rebuild the project catalog via the canonical graph pipeline.
 * Null/empty pipeline output ⇒ GRAPH.READ.REBUILD_EMPTY.
 * Infrastructure throws ⇒ fixed bounded error (no raw message leak).
 */
export async function rebuildCatalog(
  input: RunGraphInput,
): Promise<Result<Catalog, GraphReadError>> {
  try {
    const result = await runGraph(input);
    const catalog = result.catalog;
    if (catalog === null || catalog === undefined) {
      return err(
        rebuildError('GRAPH.READ.REBUILD_EMPTY', 'Graph rebuild produced an empty catalog'),
      );
    }
    return ok(catalog);
  } catch {
    return err(
      rebuildError('GRAPH.READ.REBUILD_FAILED', 'Graph rebuild failed due to infrastructure error'),
    );
  }
}
