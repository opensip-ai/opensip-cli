/**
 * Shared validation for exclusive compact-query detail modes
 * (`summary` | `groups` | `nodes`) against `groupBy`.
 */

import { err, ok, type Result } from '@opensip-cli/core';

import { readError } from './mcp-error.js';

import type { CompactQueryDetail } from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';

/** Grouping modes compatible with compact detail projections. */
export type CompactGroupBy = 'none' | 'package' | 'file';

/**
 * Enforce exclusive detail/groupBy combinations used by identity searches,
 * dead-code pages, blast membership, and declaration/reference queries.
 */
export function validateCompactQueryDetail(
  detail: CompactQueryDetail,
  groupBy: CompactGroupBy,
): Result<void, McpReadError> {
  if (detail === 'groups' && groupBy === 'none') {
    return err(readError('invalid-query', 'detail=groups requires groupBy package or file.'));
  }
  if ((detail === 'summary' || detail === 'nodes') && groupBy !== 'none') {
    return err(
      readError(
        'invalid-query',
        'detail=summary and detail=nodes require groupBy none (or omit groupBy).',
      ),
    );
  }
  return ok(undefined);
}
