/**
 * @fileoverview Restructured Code Paths explore-tab set (Plan D — shipped).
 *
 * The explore-tab restructure has shipped: `dashboardCodePathsJs` emits exactly
 * the kept views (graph / coupling) plus the ranked-distribution "Functions"
 * affordance, and the single-metric / standalone-SCC view sources were deleted.
 * The former standalone Search subtab was folded into the Functions view as an
 * in-table name filter, so it no longer registers a `search` view.
 * The emitter no longer has a legacy branch — the `restructured` parameter is a
 * vestigial test-seam arg that always yields the restructured set.
 */

import { describe, expect, it } from 'vitest';

import { dashboardCodePathsJs } from '../../code-paths.js';

/** Pull every `id: '<x>'` from a `views.push({ id: '<x>' ... })` literal. */
function registeredViewIds(js: string): string[] {
  const ids: string[] = [];
  // Split on the literal `views.push({` boundary, then match the first `id:`
  // in each chunk. Avoids a backtracking-prone whitespace pattern.
  const chunks = js.split('views.push({');
  for (let i = 1; i < chunks.length; i++) {
    const m = /id:\s*'([a-z-]+)'/.exec(chunks[i] ?? '');
    if (m) ids.push(m[1]);
  }
  return ids;
}

describe('Code Paths explore-tab set', () => {
  it('emitter registers exactly {graph, coupling, distribution}', () => {
    const ids = registeredViewIds(dashboardCodePathsJs());
    expect(new Set(ids)).toEqual(new Set(['graph', 'coupling', 'distribution']));
  });

  it('drops the single-metric + standalone-SCC + standalone-search views', () => {
    const ids = registeredViewIds(dashboardCodePathsJs());
    for (const removed of ['big', 'hot', 'wide', 'untested', 'sccs', 'search']) {
      expect(ids).not.toContain(removed);
    }
  });
});
