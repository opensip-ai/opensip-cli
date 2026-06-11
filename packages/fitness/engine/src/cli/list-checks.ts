/**
 * list-checks command — list all available fitness checks
 */

import { currentCheckRegistry } from '../framework/scope-registry.js';

import { ensureChecksLoaded } from './fit.js';

import type { ListChecksResult } from '@opensip-tools/contracts';

// ---------------------------------------------------------------------------
// listChecks
// ---------------------------------------------------------------------------

/** Returns metadata for every enabled check in the project's check registry. */
export async function listChecks(projectDir?: string): Promise<ListChecksResult> {
  await ensureChecksLoaded(projectDir);
  const checks = currentCheckRegistry().listEnabled();

  const entries = checks.map((check) => ({
    slug: check.config.slug,
    description: check.config.description,
    tags: [...(check.config.tags ?? ['untagged'])],
  }));

  return {
    type: 'list-checks',
    checks: entries,
    totalCount: checks.length,
  };
}
