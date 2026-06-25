/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Option 1 — `activateView` only writes `#code-paths/<id>` when the URL already
 * deep-links a view or the reader clicks an Explore tab; silent init keeps the
 * hash empty until then.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

type ActivateView = (id: string, options?: { updateHash?: boolean }) => void;

function loadActivateView(): ActivateView {
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
var graphCatalog = null;
var graphIndexes = {
  byBodyHash: new Map(),
  occurrencesByHash: new Map(),
  bySimpleName: new Map(),
  callees: new Map(),
  callers: new Map()
};
`;
  const tail = `return activateView;`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(head + DASHBOARD_CLIENT_BUNDLE + tail);
  return factory() as ActivateView;
}

function mountExploreDom(viewId: string): void {
  document.body.innerHTML = `
    <div class="code-paths-tab" data-view="${viewId}"></div>
    <div class="code-paths-view" id="code-paths-view-${viewId}"></div>
  `;
}

describe('activateView hash routing', () => {
  beforeEach(() => {
    mountExploreDom('coupling');
    globalThis.history.replaceState(null, '', '/report.html');
  });

  it('does not write a hash on silent init', () => {
    loadActivateView()('coupling', { updateHash: false });
    expect(globalThis.location.hash).toBe('');
  });

  it('writes the deep-link hash on user-driven activation', () => {
    loadActivateView()('coupling');
    expect(globalThis.location.hash).toBe('#code-paths/coupling');
  });

  it('preserves an existing deep-link hash without changing it', () => {
    globalThis.history.replaceState(null, '', '#code-paths/coupling');
    loadActivateView()('coupling');
    expect(globalThis.location.hash).toBe('#code-paths/coupling');
  });
});
