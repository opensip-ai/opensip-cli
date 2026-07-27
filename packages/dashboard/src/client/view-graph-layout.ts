/** Cytoscape layout registration, selection, and visible fallback reporting. */

import { el } from './el.js';
import { gvState } from './view-graph-state.js';

import type { CyCore } from './cytoscape-types.js';

type GraphLayoutFailureStage = 'dagre-registration' | 'layout-run';
type GraphLayoutFailureKind = 'type-error' | 'error' | 'non-error';

const GRAPH_LAYOUT_FAILURE_CONDITIONS = {
  'dagre-registration': {
    'type-error': 'dagre-registration-type-error',
    error: 'dagre-registration-error',
    'non-error': 'dagre-registration-non-error',
  },
  'layout-run': {
    'type-error': 'layout-run-type-error',
    error: 'layout-run-error',
    'non-error': 'layout-run-non-error',
  },
} as const;

/** Closed, non-sensitive reason vocabulary for a failed graph-layout attempt. */
export type GraphLayoutFailureCondition =
  | (typeof GRAPH_LAYOUT_FAILURE_CONDITIONS)['dagre-registration'][GraphLayoutFailureKind]
  | (typeof GRAPH_LAYOUT_FAILURE_CONDITIONS)['layout-run'][GraphLayoutFailureKind]
  | 'dagre-registration-unavailable';

/** Result of one renderer-layout operation without leaking a caught browser value. */
export type GraphLayoutAttempt =
  { readonly ok: true } | { readonly ok: false; readonly condition: GraphLayoutFailureCondition };

type GraphLayoutDegradationCondition =
  GraphLayoutFailureCondition | 'layout-initialization-fallback';

function failedLayoutAttempt(error: unknown, stage: GraphLayoutFailureStage): GraphLayoutAttempt {
  let kind: GraphLayoutFailureKind = 'non-error';
  if (error instanceof TypeError) kind = 'type-error';
  else if (error instanceof Error) kind = 'error';
  return { ok: false, condition: GRAPH_LAYOUT_FAILURE_CONDITIONS[stage][kind] };
}

// Register the dagre layout extension once. Called lazily at first render so
// vendored globals do not need to exist when the client bundle initializes.
export function gvRegisterGraphLayouts(): GraphLayoutAttempt {
  if (typeof cytoscape !== 'function' || typeof cytoscapeDagre === 'undefined') {
    gvState.dagreRegistered = false;
    return { ok: false, condition: 'dagre-registration-unavailable' };
  }
  let result: GraphLayoutAttempt;
  try {
    if (!cytoscape.__gvDagreRegistered) {
      cytoscape.use(cytoscapeDagre);
      cytoscape.__gvDagreRegistered = true;
    }
    result = { ok: true };
  } catch (error) {
    result = failedLayoutAttempt(error, 'dagre-registration');
  }
  gvState.dagreRegistered = result.ok;
  return result;
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

function reportFailure(
  container: HTMLElement,
  message: string,
  condition: GraphLayoutDegradationCondition,
): void {
  const existing = container.querySelector<HTMLElement>('[data-graph-layout-degradation]');
  const notice = existing ?? el('div', { class: 'empty' });
  notice.dataset.graphLayoutDegradation = condition;
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  if (!existing) container.prepend(notice);
}

/** Remove a previously reported degradation notice, if one is present. */
function clearFailure(container: HTMLElement): void {
  container.querySelector<HTMLElement>('[data-graph-layout-degradation]')?.remove();
}

function gvSetLayoutSelection(container: HTMLElement, layoutId: string): void {
  const select = container.querySelector<HTMLSelectElement>('select[data-control="layout"]');
  if (select) select.value = layoutId;
}

function gvTryRunLayout(cy: CyCore, layoutId: string): GraphLayoutAttempt {
  try {
    cy.layout(gvLayoutOptions(layoutId)).run();
    return { ok: true };
  } catch (error) {
    return failedLayoutAttempt(error, 'layout-run');
  }
}

export function gvRunLayout(container: HTMLElement, layoutId: string): void {
  const cy = gvState.cy;
  if (!cy) return;
  const registration = layoutId === 'dagre' ? gvRegisterGraphLayouts() : { ok: true as const };
  const dagreUnavailable = !registration.ok;
  const selectedLayout = dagreUnavailable ? 'cose' : layoutId;
  const selectedAttempt = gvTryRunLayout(cy, selectedLayout);
  if (selectedAttempt.ok) {
    gvState.currentLayout = selectedLayout;
    gvSetLayoutSelection(container, selectedLayout);
    if (dagreUnavailable) {
      reportFailure(
        container,
        'The layered layout is unavailable. The graph is using the built-in Cose layout.',
        registration.condition,
      );
    } else {
      clearFailure(container);
    }
    return;
  }
  if (selectedLayout !== 'cose') {
    const fallbackAttempt = gvTryRunLayout(cy, 'cose');
    if (!fallbackAttempt.ok) {
      reportFailure(container, 'The graph layout could not be updated.', fallbackAttempt.condition);
      return;
    }
    gvState.currentLayout = 'cose';
    gvSetLayoutSelection(container, 'cose');
    reportFailure(
      container,
      'The selected layout could not run. The graph is using the built-in Cose layout.',
      selectedAttempt.condition,
    );
    return;
  }
  reportFailure(container, 'The graph layout could not be updated.', selectedAttempt.condition);
}

export function gvReportDagreUnavailable(
  container: HTMLElement,
  condition: GraphLayoutFailureCondition,
): void {
  reportFailure(
    container,
    'The layered layout is unavailable. The graph is using the built-in Cose layout.',
    condition,
  );
}

export function gvReportLayoutInitializationFallback(container: HTMLElement): void {
  gvSetLayoutSelection(container, 'cose');
  reportFailure(
    container,
    'The selected layout could not initialize. The graph is using the built-in Cose layout.',
    'layout-initialization-fallback',
  );
}
