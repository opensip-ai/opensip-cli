/**
 * Ranked-view emitter — `defineRankedView`.
 *
 * `defineRankedView` is a JS-source emitter: it splices a declarative config
 * into the in-page `views.push({ … })` literal the Code Paths bundle ships.
 * The only first-party caller (the Functions/distribution view) turns EVERY
 * optional affordance ON (search box, Kind/Package selects, a filter toggle,
 * a preamble, a custom predicate), so the emitter's DEFAULT/OFF branches —
 * the ones a minimal ranked view uses — never run in production wiring.
 *
 * These tests drive the emitter directly with a minimal config (all optional
 * flags omitted) and a maximal config (every flag on), and assert on the
 * emitted JS so a regression in what the dashboard ships is caught:
 *  - minimal → no controls row, no search input, no Kind/Package selects, no
 *    toggle, no onActivate hook, the default `passesFilter` predicate and a
 *    `{}` row-extras splice;
 *  - maximal → all of those present, with the supplied predicate, preamble,
 *    row-extras, custom column values, and per-id-namespaced state vars.
 */

import { describe, expect, it } from 'vitest';

import { defineRankedView, type RankedViewConfig } from '../code-paths/view-template.js';

function minimalConfig(): RankedViewConfig {
  return {
    id: 'plain',
    label: 'Plain',
    help: { title: 'Plain', sections: [{ heading: 'h', body: 'b' }] },
    metric: 'occ.line',
    columns: [{ label: 'Function', value: 'o => o.simpleName' }],
    headingText: 'Plain things',
    emptyMessage: 'Nothing here.',
  };
}

describe('defineRankedView — minimal config (default/off branches)', () => {
  const js = defineRankedView(minimalConfig());

  it('emits a views.push with the configured id, label, and heading', () => {
    expect(js).toContain('views.push({');
    expect(js).toContain("id: 'plain'");
    expect(js).toContain("label: 'Plain'");
    expect(js).toContain('Plain things');
    expect(js).toContain('Nothing here.');
  });

  it('uses the default passesFilter predicate when none is supplied', () => {
    expect(js).toContain('passesFilter(occ, filterState)');
  });

  it('splices an empty row-extras object when rowExtras is omitted', () => {
    // The Object.assign row build must close over a `{}` extras literal.
    expect(js).toContain('return {}; })(r.occ, r.metric)');
  });

  it('emits NO controls row, search input, Kind/Package selects, or toggle', () => {
    expect(js).not.toContain('code-paths-ranked-controls');
    expect(js).not.toContain('code-paths-search-plain');
    expect(js).not.toContain("'data-control': 'fn-kind'");
    expect(js).not.toContain("'data-control': 'fn-package'");
    expect(js).not.toContain("'data-control': 'fn-toggle'");
  });

  it('emits the trivial always-true row filter and no per-view state vars', () => {
    expect(js).toContain('(function(){ return true; })');
    expect(js).not.toContain('__rankedSearchQuery_plain');
    expect(js).not.toContain('__rankedKind_plain');
    expect(js).not.toContain('__rankedToggle_plain');
  });

  it('emits no onActivate hook (search auto-focus) for a non-search view', () => {
    expect(js).not.toContain('onActivate()');
  });
});

describe('defineRankedView — maximal config (populated branches)', () => {
  const js = defineRankedView({
    id: 'rich-1',
    label: 'Rich',
    help: { title: 'Rich', sections: [{ heading: 'h', body: 'b' }] },
    metric: 'occ.line',
    predicate: "passesFilter(occ, filterState) && occ.kind === 'function-declaration'",
    rowExtras: '{ __thumb: occ.params.length }',
    preamble: 'function helper(o) { return o.simpleName; }',
    columns: [{ label: 'Name', value: 'o => helper(o)' }],
    headingText: 'Rich functions',
    emptyMessage: 'No rich functions.',
    searchByName: true,
    filterByKindPackage: true,
    filterToggle: { label: 'Test-only', predicate: 'isTestOnly(occ)' },
  });

  it('splices the custom predicate verbatim (replacing the default)', () => {
    expect(js).toContain("passesFilter(occ, filterState) && occ.kind === 'function-declaration'");
  });

  it('splices the preamble helper and custom row-extras', () => {
    expect(js).toContain('function helper(o) { return o.simpleName; }');
    expect(js).toContain('return { __thumb: occ.params.length }; })(r.occ, r.metric)');
  });

  it('renders the controls row with search, Kind/Package selects, and toggle', () => {
    expect(js).toContain('code-paths-ranked-controls');
    expect(js).toContain('code-paths-search-rich-1');
    expect(js).toContain("'data-control': 'fn-kind'");
    expect(js).toContain("'data-control': 'fn-package'");
    expect(js).toContain("'data-control': 'fn-toggle'");
    expect(js).toContain('Test-only');
  });

  it('namespaces every piece of view state by a sanitized id', () => {
    // The hyphen in `rich-1` becomes `_` in the state-var suffix.
    expect(js).toContain('__rankedSearchQuery_rich_1');
    expect(js).toContain('__rankedKind_rich_1');
    expect(js).toContain('__rankedPkg_rich_1');
    expect(js).toContain('__rankedToggle_rich_1');
  });

  it('builds a non-trivial row filter that consults kind, package, name, and toggle', () => {
    expect(js).toContain('occ.kind !== __rankedKind_rich_1');
    expect(js).toContain('pkgOf(occ) !== __rankedPkg_rich_1');
    expect(js).toContain("occ.simpleName || ''");
    expect(js).toContain('!(isTestOnly(occ))');
    // And it is NOT the trivial always-true filter.
    expect(js).not.toContain('(function(){ return true; })');
  });

  it('emits an onActivate hook that focuses the search box', () => {
    expect(js).toContain('onActivate()');
    expect(js).toContain("getElementById('code-paths-search-rich-1')");
  });
});

describe('defineRankedView — partial configs (each flag independently)', () => {
  it('search-only: controls + search input, but no Kind/Package or toggle', () => {
    const js = defineRankedView({ ...minimalConfig(), id: 'searchonly', searchByName: true });
    expect(js).toContain('code-paths-ranked-controls');
    expect(js).toContain('code-paths-search-searchonly');
    expect(js).toContain('__rankedSearchQuery_searchonly');
    expect(js).not.toContain("'data-control': 'fn-kind'");
    expect(js).not.toContain("'data-control': 'fn-toggle'");
    expect(js).toContain('onActivate()');
  });

  it('toggle-only: controls + toggle checkbox, but no search input or selects', () => {
    const js = defineRankedView({
      ...minimalConfig(),
      id: 'toggleonly',
      filterToggle: { label: 'Only X', predicate: 'isX(occ)' },
    });
    expect(js).toContain('code-paths-ranked-controls');
    expect(js).toContain("'data-control': 'fn-toggle'");
    expect(js).toContain('__rankedToggle_toggleonly');
    expect(js).toContain('!(isX(occ))');
    expect(js).not.toContain('code-paths-search-toggleonly');
    expect(js).not.toContain("'data-control': 'fn-kind'");
    // A toggle without search → no auto-focus hook.
    expect(js).not.toContain('onActivate()');
  });

  it('kind/package-only: selects present, but no search input or toggle', () => {
    const js = defineRankedView({ ...minimalConfig(), id: 'kponly', filterByKindPackage: true });
    expect(js).toContain("'data-control': 'fn-kind'");
    expect(js).toContain("'data-control': 'fn-package'");
    expect(js).toContain('__rankedKind_kponly');
    expect(js).toContain('occ.kind !== __rankedKind_kponly');
    expect(js).not.toContain('code-paths-search-kponly');
    expect(js).not.toContain("'data-control': 'fn-toggle'");
    expect(js).not.toContain('onActivate()');
  });
});
