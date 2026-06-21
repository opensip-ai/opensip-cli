/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Ranked-view skeleton — `defineRankedView`.
 *
 * `defineRankedView` registers a ranked-list view (rank-and-render skeleton)
 * into the shared `views` registry. It used to splice JS-source strings into an
 * emitted `views.push({ … })` literal; it is now a typed bundle function taking
 * real callbacks. These tests load the client bundle (which exposes
 * `defineRankedView` + `views` as page globals), register a MINIMAL config (all
 * optional flags omitted) and a MAXIMAL config (every flag on), then assert on
 * the RENDERED DOM so a regression in the controls a ranked view ships is
 * caught:
 *  - minimal → no controls row, no search input, no Kind/Package selects, no
 *    toggle, no onActivate hook, the default `passesFilter` predicate;
 *  - maximal → all of those present, with the supplied predicate / row-extras /
 *    custom columns active.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

/** Minimal occurrence shape the ranked views read. */
interface OccLike {
  bodyHash: string;
  simpleName?: string;
  kind?: string;
  filePath?: string;
  line?: number;
  endLine?: number;
  params?: unknown[];
  inTestFile?: boolean;
}

interface IndexesLike {
  byBodyHash: Map<string, OccLike>;
  occurrencesByHash: Map<string, OccLike[]>;
  bySimpleName: Map<string, string[]>;
  callees: Map<string, string[]>;
  callers: Map<string, string[]>;
}

interface RankedViewConfig {
  id: string;
  label: string;
  help: { title: string; sections: { heading: string; body: string }[] };
  metric: (occ: OccLike, indexes: IndexesLike) => number | false;
  predicate?: (occ: OccLike, fs: unknown) => boolean;
  rowExtras?: (occ: OccLike, metric: number) => Record<string, unknown>;
  columns: { label: string; value: (o: OccLike) => string | number | null | undefined }[];
  headingText: string;
  emptyMessage: string;
  searchByName?: boolean;
  filterByKindPackage?: boolean;
  filterToggle?: { label: string; predicate: (occ: OccLike) => boolean };
}

interface View {
  id: string;
  label: string;
  render: (c: HTMLElement, cat: unknown, idx: IndexesLike, fs: unknown) => void;
  onActivate?: () => void;
}

interface Env {
  defineRankedView: (config: RankedViewConfig) => void;
  views: View[];
  buildIndexes: (catalog: GraphCatalog) => IndexesLike;
  filterState: unknown;
}

function loadEnv(): Env {
  // The ranked-view skeleton lives in the typed client bundle (L4); loading the
  // bundle exposes `defineRankedView`, `views`, `buildIndexes`, `filterState` as
  // page globals. Declare the page globals the bundle reads at load.
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
var graphCatalog = null;
var graphIndexes = null;
`;
  const tail = `return { defineRankedView, views, buildIndexes, filterState };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(head + DASHBOARD_CLIENT_BUNDLE + tail);
  return factory() as Env;
}

function makeOcc(
  over: Partial<GraphFunctionOccurrence> & {
    bodyHash: string;
    simpleName: string;
    filePath: string;
  },
): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

const SAMPLE: GraphCatalog = {
  version: '2.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: 'now',
  functions: {
    a: [makeOcc({ bodyHash: 'a', simpleName: 'alpha', filePath: 'packages/cli/src/a.ts' })],
    b: [
      makeOcc({
        bodyHash: 'b',
        simpleName: 'beta',
        filePath: 'packages/cli/src/b.ts',
        kind: 'method',
      }),
    ],
  },
};

function minimalConfig(): RankedViewConfig {
  return {
    id: 'plain',
    label: 'Plain',
    help: { title: 'Plain', sections: [{ heading: 'h', body: 'b' }] },
    metric: (occ) => occ.line ?? 0,
    columns: [{ label: 'Function', value: (o) => o.simpleName }],
    headingText: 'Plain things',
    emptyMessage: 'Nothing here.',
  };
}

function renderConfig(env: Env, config: RankedViewConfig): HTMLElement {
  env.defineRankedView(config);
  const view = env.views.find((v) => v.id === config.id)!;
  const host = document.createElement('div');
  document.body.append(host);
  const indexes = env.buildIndexes(SAMPLE);
  view.render(host, SAMPLE, indexes, env.filterState);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('defineRankedView — minimal config (default/off branches)', () => {
  it('registers a view with the configured id, label, and heading count', () => {
    const env = loadEnv();
    const host = renderConfig(env, minimalConfig());
    const view = env.views.find((v) => v.id === 'plain');
    expect(view).toBeDefined();
    expect(view!.label).toBe('Plain');
    expect(host.querySelector('h3')!.textContent).toContain('Plain things (2)');
  });

  it('renders rows with the default (passesFilter) predicate', () => {
    const env = loadEnv();
    const host = renderConfig(env, minimalConfig());
    // Both sample functions pass the default whole-graph filter.
    expect(host.querySelectorAll('[data-body-hash]').length).toBe(2);
  });

  it('renders NO controls row, search input, Kind/Package selects, or toggle', () => {
    const env = loadEnv();
    const host = renderConfig(env, minimalConfig());
    expect(host.querySelector('.code-paths-ranked-controls')).toBeNull();
    expect(host.querySelector('#code-paths-search-plain')).toBeNull();
    expect(host.querySelector('select[data-control="fn-kind"]')).toBeNull();
    expect(host.querySelector('select[data-control="fn-package"]')).toBeNull();
    expect(host.querySelector('input[data-control="fn-toggle"]')).toBeNull();
  });

  it('registers no onActivate hook for a non-search view', () => {
    const env = loadEnv();
    env.defineRankedView(minimalConfig());
    const view = env.views.find((v) => v.id === 'plain')!;
    expect(view.onActivate).toBeUndefined();
  });
});

function maximalConfig(): RankedViewConfig {
  return {
    id: 'rich-1',
    label: 'Rich',
    help: { title: 'Rich', sections: [{ heading: 'h', body: 'b' }] },
    metric: (occ) => occ.line ?? 0,
    // Custom predicate: keep only function-declarations.
    predicate: (occ) => occ.kind === 'function-declaration',
    rowExtras: (occ) => ({ __thumb: (occ.params ?? []).length }),
    columns: [{ label: 'Name', value: (o) => o.simpleName }],
    headingText: 'Rich functions',
    emptyMessage: 'No rich functions.',
    searchByName: true,
    filterByKindPackage: true,
    filterToggle: { label: 'Test-only', predicate: (occ) => occ.inTestFile === true },
  };
}

describe('defineRankedView — maximal config (populated branches)', () => {
  it('applies the custom predicate (drops non-matching rows)', () => {
    const env = loadEnv();
    const host = renderConfig(env, maximalConfig());
    // Only 'alpha' is a function-declaration; 'beta' is a method → dropped.
    expect(host.querySelectorAll('[data-body-hash]').length).toBe(1);
    expect(host.textContent).toContain('alpha');
    expect(host.textContent).not.toContain('beta');
  });

  it('renders the controls row with search, Kind/Package selects, and toggle', () => {
    const env = loadEnv();
    const host = renderConfig(env, maximalConfig());
    expect(host.querySelector('.code-paths-ranked-controls')).not.toBeNull();
    expect(host.querySelector('#code-paths-search-rich-1')).not.toBeNull();
    expect(host.querySelector('select[data-control="fn-kind"]')).not.toBeNull();
    expect(host.querySelector('select[data-control="fn-package"]')).not.toBeNull();
    expect(host.querySelector('input[data-control="fn-toggle"]')).not.toBeNull();
    expect(host.textContent).toContain('Test-only');
  });

  it('registers an onActivate hook that focuses the search box', () => {
    const env = loadEnv();
    env.defineRankedView(maximalConfig());
    const view = env.views.find((v) => v.id === 'rich-1')!;
    expect(typeof view.onActivate).toBe('function');
  });
});

describe('defineRankedView — partial configs (each flag independently)', () => {
  it('search-only: controls + search input, but no Kind/Package or toggle', () => {
    const env = loadEnv();
    const host = renderConfig(env, { ...minimalConfig(), id: 'searchonly', searchByName: true });
    expect(host.querySelector('.code-paths-ranked-controls')).not.toBeNull();
    expect(host.querySelector('#code-paths-search-searchonly')).not.toBeNull();
    expect(host.querySelector('select[data-control="fn-kind"]')).toBeNull();
    expect(host.querySelector('input[data-control="fn-toggle"]')).toBeNull();
    const view = env.views.find((v) => v.id === 'searchonly')!;
    expect(typeof view.onActivate).toBe('function');
  });

  it('toggle-only: controls + toggle checkbox, but no search input or selects', () => {
    const env = loadEnv();
    const host = renderConfig(env, {
      ...minimalConfig(),
      id: 'toggleonly',
      filterToggle: { label: 'Only X', predicate: () => true },
    });
    expect(host.querySelector('.code-paths-ranked-controls')).not.toBeNull();
    expect(host.querySelector('input[data-control="fn-toggle"]')).not.toBeNull();
    expect(host.querySelector('#code-paths-search-toggleonly')).toBeNull();
    expect(host.querySelector('select[data-control="fn-kind"]')).toBeNull();
    const view = env.views.find((v) => v.id === 'toggleonly')!;
    // A toggle without search → no auto-focus hook.
    expect(view.onActivate).toBeUndefined();
  });

  it('kind/package-only: selects present, but no search input or toggle', () => {
    const env = loadEnv();
    const host = renderConfig(env, { ...minimalConfig(), id: 'kponly', filterByKindPackage: true });
    expect(host.querySelector('select[data-control="fn-kind"]')).not.toBeNull();
    expect(host.querySelector('select[data-control="fn-package"]')).not.toBeNull();
    expect(host.querySelector('#code-paths-search-kponly')).toBeNull();
    expect(host.querySelector('input[data-control="fn-toggle"]')).toBeNull();
    const view = env.views.find((v) => v.id === 'kponly')!;
    expect(view.onActivate).toBeUndefined();
  });
});
