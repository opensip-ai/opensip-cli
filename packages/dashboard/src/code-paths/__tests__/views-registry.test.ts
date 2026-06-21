/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Restructured Code Paths explore-tab set (Plan D — shipped).
 *
 * The explore-tab restructure has shipped: the Code Paths bundle registers
 * exactly the kept views (graph / coupling) plus the ranked-distribution
 * "Functions" affordance, and the single-metric / standalone-SCC view sources
 * were deleted. The former standalone Search subtab was folded into the
 * Functions view as an in-table name filter, so it no longer registers a
 * `search` view.
 *
 * The views now live in the typed client bundle (L4) and register themselves
 * into the bundle's `views` global at load; this test boots the bundle and reads
 * the registered ids (the old string-emitter source match is gone).
 */

import { describe, expect, it } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../../client-bundle.generated.js';

function registeredViewIds(): string[] {
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
`;
  const tail = `return views.map(function(v) { return v.id; });`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(head + DASHBOARD_CLIENT_BUNDLE + tail);
  return factory() as string[];
}

describe('Code Paths explore-tab set', () => {
  it('bundle registers exactly {graph, coupling, distribution}', () => {
    expect(new Set(registeredViewIds())).toEqual(new Set(['graph', 'coupling', 'distribution']));
  });

  it('drops the single-metric + standalone-SCC + standalone-search views', () => {
    const ids = registeredViewIds();
    for (const removed of ['big', 'hot', 'wide', 'untested', 'sccs', 'search']) {
      expect(ids).not.toContain(removed);
    }
  });
});
