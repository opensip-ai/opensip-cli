/**
 * @fileoverview Restructured Code Paths explore-tab set (Plan B, Phase 5 Task 5.4).
 *
 * The build ships with RESTRUCTURED_EXPLORE_TABS = false (legacy seven views).
 * This test forces the flag `true` via the `dashboardCodePathsJs(restructured)`
 * test seam and asserts the emitted JS registers exactly the kept views
 * (graph / coupling / search) plus the ranked-distribution affordance, and does
 * NOT emit the removed single-metric / standalone-SCC views.
 *
 * The file-absence half (deleting view-big/hot/wide/untested/sccs.ts) lands
 * with Plan D when the flag default flips; Plan B retains the files for the
 * legacy branch.
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
  it('default (legacy) emitter registers the seven current views', () => {
    const ids = registeredViewIds(dashboardCodePathsJs(false));
    expect(new Set(ids)).toEqual(new Set(['hot', 'big', 'wide', 'coupling', 'untested', 'sccs', 'search', 'graph']));
  });

  it('restructured emitter registers exactly {graph, coupling, search, distribution}', () => {
    const ids = registeredViewIds(dashboardCodePathsJs(true));
    expect(new Set(ids)).toEqual(new Set(['graph', 'coupling', 'search', 'distribution']));
  });

  it('restructured emitter drops the single-metric + standalone-SCC views', () => {
    const ids = registeredViewIds(dashboardCodePathsJs(true));
    for (const removed of ['big', 'hot', 'wide', 'untested', 'sccs']) {
      expect(ids).not.toContain(removed);
    }
  });
});
