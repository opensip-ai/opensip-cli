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

import { beforeEach, describe, expect, it } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

const expectedIds = new Set(['graph', 'coupling', 'distribution']);

interface Probe {
  views: { id: string; label: string; render: unknown }[];
}

interface ResiliencyProbe {
  views: {
    id: string;
    label: string;
    render: (container: HTMLElement) => void;
    onActivate?: () => void;
  }[];
  activateView: (id: string) => void;
}

function loadViews(): Probe['views'] {
  // The whole Code Paths panel + its three views now live in the typed client
  // bundle (L4): loading the bundle registers coupling / distribution / graph
  // into the bundle's `views` global at IIFE eval. Declare the page globals the
  // bundle reads at load.
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
`;
  const tail = `
return { views };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(head + DASHBOARD_CLIENT_BUNDLE + tail);
  return (factory() as Probe).views;
}

function loadResiliencyProbe(): ResiliencyProbe {
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
var graphCatalog = null;
var graphIndexes = { byBodyHash: new Map(), occurrencesByHash: new Map(), bySimpleName: new Map(), callees: new Map(), callers: new Map() };
`;
  const tail = `return { views, activateView };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  return new Function(head + DASHBOARD_CLIENT_BUNDLE + tail)() as ResiliencyProbe;
}

function mountView(id: string): HTMLElement {
  const tab = document.createElement('button');
  tab.className = 'code-paths-tab';
  tab.dataset.view = id;
  document.body.append(tab);
  const container = document.createElement('div');
  container.className = 'code-paths-view';
  container.id = 'code-paths-view-' + id;
  document.body.append(container);
  return container;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

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

  it('contains a registered view render failure in that view', () => {
    const env = loadResiliencyProbe();
    const container = mountView('broken-render');
    env.views.push({
      id: 'broken-render',
      label: 'Broken Render',
      render() {
        throw new Error('extension render failed');
      },
    });

    env.activateView('broken-render');

    expect(container.textContent).toBe(
      'Broken Render could not be rendered. Other views remain available.',
    );
  });

  it('turns a registered activation-hook failure into a visible state', () => {
    const env = loadResiliencyProbe();
    const container = mountView('broken-activation');
    env.views.push({
      id: 'broken-activation',
      label: 'Broken Activation',
      render(target) {
        target.textContent = 'rendered';
      },
      onActivate() {
        throw new Error('extension activation failed');
      },
    });

    env.activateView('broken-activation');

    expect(container.textContent).toBe(
      'Broken Activation could not be activated. Other views remain available.',
    );
  });
});
