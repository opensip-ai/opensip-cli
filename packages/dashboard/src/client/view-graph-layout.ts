/** Cytoscape layout registration, selection, and visible fallback reporting. */

import { el } from './el.js';
import { gvState } from './view-graph-state.js';

import type { CyCore } from './cytoscape-types.js';

// Register the dagre layout extension once. Called lazily at first render so
// vendored globals do not need to exist when the client bundle initializes.
export function gvRegisterGraphLayouts(): boolean {
  if (typeof cytoscape !== 'function' || typeof cytoscapeDagre === 'undefined') {
    gvState.dagreRegistered = false;
    return false;
  }
  try {
    if (!cytoscape.__gvDagreRegistered) {
      cytoscape.use(cytoscapeDagre);
      cytoscape.__gvDagreRegistered = true;
    }
    gvState.dagreRegistered = true;
    return true;
  } catch {
    gvState.dagreRegistered = false;
    return false;
  }
}

export function gvLayoutOptions(layoutId: string): Record<string, unknown> {
  if (layoutId === 'dagre' && gvState.dagreRegistered) {
    return { name: 'dagre', rankDir: 'LR', nodeSep: 24, rankSep: 64, fit: true, padding: 24 };
  }
  if (layoutId === 'breadthfirst') {
    return { name: 'breadthfirst', directed: true, spacingFactor: 1.2, fit: true, padding: 24 };
  }
  return { name: 'cose', animate: false, fit: true, padding: 24, nodeRepulsion: 6000 };
}

function gvShowLayoutDegradation(container: HTMLElement, message: string): void {
  const existing = container.querySelector<HTMLElement>('[data-graph-layout-degradation]');
  const notice = existing ?? el('div', { class: 'empty' });
  notice.dataset.graphLayoutDegradation = 'true';
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  if (!existing) container.prepend(notice);
}

function gvSetLayoutSelection(container: HTMLElement, layoutId: string): void {
  const select = container.querySelector<HTMLSelectElement>('select[data-control="layout"]');
  if (select) select.value = layoutId;
}

function gvTryRunLayout(cy: CyCore, layoutId: string): boolean {
  try {
    cy.layout(gvLayoutOptions(layoutId)).run();
    return true;
  } catch {
    return false;
  }
}

export function gvRunLayout(container: HTMLElement, layoutId: string): void {
  const cy = gvState.cy;
  if (!cy) return;
  const dagreUnavailable = layoutId === 'dagre' && !gvRegisterGraphLayouts();
  const selectedLayout = dagreUnavailable ? 'cose' : layoutId;
  if (gvTryRunLayout(cy, selectedLayout)) {
    gvState.currentLayout = selectedLayout;
    gvSetLayoutSelection(container, selectedLayout);
    if (dagreUnavailable) {
      gvShowLayoutDegradation(
        container,
        'The layered layout is unavailable. The graph is using the built-in Cose layout.',
      );
    }
    return;
  }
  if (selectedLayout !== 'cose' && gvTryRunLayout(cy, 'cose')) {
    gvState.currentLayout = 'cose';
    gvSetLayoutSelection(container, 'cose');
    gvShowLayoutDegradation(
      container,
      'The selected layout could not run. The graph is using the built-in Cose layout.',
    );
    return;
  }
  gvShowLayoutDegradation(container, 'The graph layout could not be updated.');
}

export function gvReportDagreUnavailable(container: HTMLElement): void {
  gvShowLayoutDegradation(
    container,
    'The layered layout is unavailable. The graph is using the built-in Cose layout.',
  );
}

export function gvReportLayoutInitializationFallback(container: HTMLElement): void {
  gvSetLayoutSelection(container, 'cose');
  gvShowLayoutDegradation(
    container,
    'The selected layout could not initialize. The graph is using the built-in Cose layout.',
  );
}
