/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View conformance — §10.1 invariant asserted at runtime.
 *
 * Every registered View must have:
 *  - id ∈ {graph, coupling, distribution}
 *  - label: non-empty string
 *  - render: a function
 */

import { describe, expect, it } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';
import { dashboardCodePathsJs } from '../code-paths.js';

const expectedIds = new Set(['graph', 'coupling', 'distribution']);

interface Probe {
  views: { id: string; label: string; render: unknown }[];
}

function loadViews(): Probe['views'] {
  // The Code Paths prelude now lives in the typed client bundle (L4) and is
  // exposed as page globals; `dashboardCodePathsJs()` emits the cytoscape vendor
  // blob + the three string view emitters (which push into the bundle's `views`)
  // + the panel orchestrator. The orchestrator declares its own `let graphCatalog`
  // / `graphIndexes`, so only `sessions` + `EDITOR_PROTOCOL` are declared here
  // (declaring graphCatalog again would be a duplicate-binding SyntaxError). Reset
  // `views` so only this load's emitters register.
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
`;
  const tail = `
return { views };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(
    head + DASHBOARD_CLIENT_BUNDLE + 'views.length = 0;\n' + dashboardCodePathsJs() + tail,
  );
  return (factory() as Probe).views;
}

describe('view conformance — §10.1', () => {
  it('exactly three views are registered', () => {
    const views = loadViews();
    expect(views.length).toBe(3);
  });

  it('every view has a known id, non-empty label, and a render function', () => {
    const views = loadViews();
    for (const v of views) {
      expect(expectedIds.has(v.id)).toBe(true);
      expect(typeof v.label).toBe('string');
      expect(v.label.length).toBeGreaterThan(0);
      expect(typeof v.render).toBe('function');
    }
  });

  it('all expected ids are present', () => {
    const views = loadViews();
    const ids = new Set(views.map((v) => v.id));
    for (const id of expectedIds) expect(ids.has(id)).toBe(true);
  });
});
