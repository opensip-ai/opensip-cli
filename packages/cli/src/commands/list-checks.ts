/**
 * list-checks command — list all available fitness checks
 */

import { defaultRegistry } from '@opensip-tools/core';
import { ensureChecksLoaded } from './fit.js';
import type { ListChecksResult } from '../types.js';

// ---------------------------------------------------------------------------
// listChecks
// ---------------------------------------------------------------------------

export async function listChecks(projectDir?: string): Promise<ListChecksResult> {
  await ensureChecksLoaded(projectDir);
  const checks = defaultRegistry.listEnabled();

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
