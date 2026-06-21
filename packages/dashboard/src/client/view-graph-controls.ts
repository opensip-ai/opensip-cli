/**
 * Visualization control toolbar + function-level projector.
 *
 * A render helper (registers no view), kept separate from `view-graph.ts` to
 * keep that module under the file-length budget. Exports:
 *
 *  - `gvRenderControls(host, catalog, indexes)` — the self-contained Level /
 *    Scope / Package / Kind / Edges control bar. Package + Kind are disabled at
 *    package level (they only apply at function level). Every change re-renders
 *    the graph in place via `gvRenderGraph`.
 *  - `gvBuildFunctionElements(indexes, pkg, includeTests, kinds, crossPackage)`
 *    — projects ONE package's function call graph client-side from the catalog
 *    indexes (the package→package view-model blob can't express it).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { el } from './el.js';
import { KIND_LIST, packagesInCatalog } from './filters.js';
import { resolveCalleeOcc } from './indexes.js';
import { displayName, pkgOf } from './path-utils.js';
import { GV_LAYOUTS, gvState } from './view-graph-state.js';

import type { CatalogLike, IndexesLike, OccLike } from './code-paths-types.js';
import type { GraphElement } from './view-graph-elements.js';

/**
 * The view-graph render handlers this toolbar drives. Injected by view-graph's
 * render driver (`gvRenderControls(host, …, handlers)`) rather than imported, so
 * the dependency stays one-directional (view-graph → controls) — no module
 * cycle.
 *
 *  - rerender          re-render the whole graph in place (full remount).
 *  - runLayout         re-run a layout on the live graph (no remount).
 *  - applySccHighlight toggle the cross-package cycle emphasis on the live graph.
 *  - renderSearchBox   mount the name-search box into the given host.
 */
export interface GraphControlHandlers {
  rerender: () => void;
  runLayout: (layoutId: string) => void;
  applySccHighlight: () => void;
  renderSearchBox: (host: HTMLElement) => void;
}

/** Shared class for the toolbar's `<select>` controls (Layout/Scope/…). */
const SELECT_CLASS = 'code-paths-graph-select';

// Append [value, label] option pairs to a select, marking 'current' selected.
function gvAddOptions(
  sel: HTMLSelectElement,
  pairs: readonly (readonly [string, string])[],
  current: string | null,
): void {
  for (const [value, label] of pairs) {
    const opt = el('option', { value, text: label }) as HTMLOptionElement;
    if (value === current) opt.selected = true;
    sel.append(opt);
  }
}

/** Config for the compact multi-select dropdown (Kind, at function level). */
interface MultiSelectOpts {
  id: string;
  items: readonly string[];
  selected: readonly string[];
  allLabel: string;
  disabled: boolean;
  onClose: (selected: string[]) => void;
}

// A compact multi-select dropdown: a trigger button + a checkbox popover.
// Native <select multiple> renders an ugly always-open listbox, so we roll a
// small popover instead. Checkboxes toggle the selection live and update the
// trigger label; the graph re-renders only when the panel CLOSES (trigger
// re-click or outside click) so a remount doesn't fire on every checkbox.
function gvMultiSelect(opts: MultiSelectOpts): HTMLElement {
  const wrap = el('div', { class: 'code-paths-graph-ms' });
  const selected = [...opts.selected];
  function triggerLabel(): string {
    if (selected.length === 0) return opts.allLabel;
    if (selected.length === 1) return selected[0];
    return selected.length + ' selected';
  }
  const trigger = el('button', {
    class: 'code-paths-graph-select code-paths-graph-ms-trigger',
    'data-control': opts.id,
    text: triggerLabel() + ' ▾',
  }) as HTMLButtonElement;
  trigger.disabled = !!opts.disabled;
  const panel = el('div', { class: 'code-paths-graph-ms-panel' });
  panel.style.display = 'none';
  let open = false;
  let docHandler: ((e: MouseEvent) => void) | null = null;
  function close(): void {
    if (!open) return;
    open = false;
    panel.style.display = 'none';
    if (docHandler) {
      document.removeEventListener('mousedown', docHandler);
      docHandler = null;
    }
    opts.onClose([...selected]);
  }
  function openPanel(): void {
    if (open || opts.disabled) return;
    open = true;
    panel.style.display = 'block';
    docHandler = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', docHandler);
  }
  trigger.addEventListener('click', () => {
    if (open) close();
    else openPanel();
  });
  for (const item of opts.items) {
    const row = el('label', { class: 'code-paths-graph-ms-item' });
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = selected.includes(item);
    cb.addEventListener('change', () => {
      const ix = selected.indexOf(item);
      if (cb.checked && ix === -1) selected.push(item);
      else if (!cb.checked && ix !== -1) selected.splice(ix, 1);
      trigger.textContent = triggerLabel() + ' ▾';
    });
    row.append(cb);
    row.append(' ' + item);
    panel.append(row);
  }
  wrap.append(trigger);
  wrap.append(panel);
  return wrap;
}

// The "Highlight cycles" checkbox — rendered into the row-1 control grid (beside
// the search box). Package-level SCC emphasis; toggles the emphasis on the live
// graph in place (no re-render) via the injected handler.
function gvRenderCyclesToggle(host: HTMLElement, applySccHighlight: () => void): void {
  const sccToggle = el('label', { class: 'code-paths-graph-checkbox' });
  const sccCb = el('input', { type: 'checkbox', 'data-scc-toggle': '1' }) as HTMLInputElement;
  sccCb.checked = gvState.sccHighlight;
  sccCb.addEventListener('change', () => {
    gvState.sccHighlight = sccCb.checked;
    applySccHighlight();
  });
  sccToggle.append(sccCb);
  sccToggle.append(' Highlight cycles');
  host.append(sccToggle);
}

// The view's controls, laid out as a 2-row × 4-column CSS grid where each cell
// is a labeled control (label + control flex pair). Auto-flow fills 4 cells per
// row:
//   Row 1: Layout · Scope · Search · Highlight cycles
//   Row 2: Level · Package · Kind · Edges
// Self-contained (the shared Explore filter bar was removed). The Level
// dropdown decides what the graph shows; Package, Kind, AND Edges only apply at
// function level, so all three are DISABLED at package level (faded, not
// hidden) — consistent greying. The render driver's handlers (rerender /
// runLayout / applySccHighlight / renderSearchBox) are injected by view-graph so
// this module never imports back into it (no cycle).
export function gvRenderControls(
  host: HTMLElement,
  catalog: CatalogLike | null,
  indexes: IndexesLike,
  handlers: GraphControlHandlers,
): void {
  const { rerender, runLayout, applySccHighlight, renderSearchBox } = handlers;
  const fnLevel = gvState.level === 'function';
  const grid = el('div', { class: 'code-paths-graph-grid' });
  // cell(labelText, control) — one labeled grid cell (label + control). A null
  // labelText yields an unlabeled cell (used for the search box).
  function cell(labelText: string | null, control: HTMLElement | null): HTMLElement {
    const c = el('div', { class: 'code-paths-graph-cell' });
    if (labelText)
      c.append(el('span', { class: 'code-paths-graph-toolbar-label', text: labelText }));
    if (control) c.append(control);
    grid.append(c);
    return c;
  }

  // ---- Row 1: Layout · Scope · Search · Highlight cycles ----
  // Layout — dropdown; re-runs the layout on the live graph (no full remount).
  const layoutSel = el('select', {
    class: SELECT_CLASS,
    'data-control': 'layout',
  }) as HTMLSelectElement;
  gvAddOptions(
    layoutSel,
    GV_LAYOUTS.map((l) => [l.id, l.label] as const),
    gvState.currentLayout,
  );
  layoutSel.addEventListener('change', (e) => {
    runLayout((e.target as HTMLSelectElement).value);
  });
  cell('Layout', layoutSel);

  // Scope — always enabled. Production-only vs include-tests.
  const scopeSel = el('select', {
    class: SELECT_CLASS,
    'data-control': 'scope',
  }) as HTMLSelectElement;
  gvAddOptions(
    scopeSel,
    [
      ['prod', 'Production only'],
      ['tests', 'Include tests'],
    ],
    gvState.includeTests ? 'tests' : 'prod',
  );
  scopeSel.addEventListener('change', (e) => {
    gvState.includeTests = (e.target as HTMLSelectElement).value === 'tests';
    rerender();
  });
  cell('Scope', scopeSel);

  // Search (unlabeled cell) — the name search box.
  const searchCell = el('div', { class: 'code-paths-graph-cell code-paths-graph-cell-search' });
  renderSearchBox(searchCell);
  grid.append(searchCell);

  // Highlight cycles (unlabeled cell) — the checkbox toggle.
  const cyclesCell = el('div', { class: 'code-paths-graph-cell' });
  gvRenderCyclesToggle(cyclesCell, applySccHighlight);
  grid.append(cyclesCell);

  // ---- Row 2: Level · Package · Kind · Edges ----
  // Level — always enabled. Drives package vs function granularity.
  const levelSel = el('select', {
    class: SELECT_CLASS,
    'data-control': 'level',
  }) as HTMLSelectElement;
  gvAddOptions(
    levelSel,
    [
      ['package', 'Package'],
      ['function', 'Function'],
    ],
    gvState.level,
  );
  levelSel.addEventListener('change', (e) => {
    gvState.level = (e.target as HTMLSelectElement).value as 'package' | 'function';
    rerender();
  });
  cell('Level', levelSel);

  // Package — single-select; function level only (disabled at package level).
  const pkgs = packagesInCatalog(catalog);
  const pkgSel = el('select', {
    class: SELECT_CLASS,
    'data-control': 'package',
  }) as HTMLSelectElement;
  pkgSel.append(el('option', { value: '', text: pkgs.length > 0 ? '— select —' : '— none —' }));
  gvAddOptions(
    pkgSel,
    pkgs.map((p) => [p, p] as const),
    gvState.selectedPackage,
  );
  pkgSel.disabled = !fnLevel;
  pkgSel.addEventListener('change', (e) => {
    gvState.selectedPackage = (e.target as HTMLSelectElement).value || null;
    rerender();
  });
  cell('Package', pkgSel);

  // Kind — multi-select dropdown; function level only (disabled at package
  // level). A custom checkbox popover (gvMultiSelect) rather than a native
  // <select multiple> listbox, which renders as an always-open box.
  cell(
    'Kind',
    gvMultiSelect({
      id: 'kind',
      items: KIND_LIST,
      selected: gvState.kinds,
      allLabel: 'All kinds',
      disabled: !fnLevel,
      onClose: (sel) => {
        gvState.kinds = sel;
        rerender();
      },
    }),
  );

  // Edges — function level only: intra-package (default) vs + cross-package.
  // Always present; disabled at package level (consistent with Package/Kind).
  const edgeSel = el('select', {
    class: SELECT_CLASS,
    'data-control': 'granularity',
  }) as HTMLSelectElement;
  gvAddOptions(
    edgeSel,
    [
      ['intra', 'Intra-package'],
      ['cross', '+ cross-package'],
    ],
    gvState.crossPackage ? 'cross' : 'intra',
  );
  edgeSel.disabled = !fnLevel;
  edgeSel.addEventListener('change', (e) => {
    gvState.crossPackage = (e.target as HTMLSelectElement).value === 'cross';
    rerender();
  });
  cell('Edges', edgeSel);

  host.append(grid);
}

// Project the function-level graph for a single package, client-side from the
// embedded catalog indexes (the package->package view-model blob can't express
// it). Nodes = the package's functions passing the Scope/Kind filters; edges =
// resolved function->function calls. Intra-package mode keeps only calls whose
// callee is in the same package; "+ cross-package" mode also keeps calls
// leaving the package, drawing the external callee as a faded node. Node size
// (totalCoupling) is the incident-edge degree. Bounded by package size.
export function gvBuildFunctionElements(
  indexes: IndexesLike,
  pkg: string,
  includeTests: boolean,
  kinds: readonly string[],
  crossPackage: boolean,
): GraphElement[] {
  const elements: GraphElement[] = [];
  if (!indexes?.occurrencesByHash || !indexes.callees) return elements;
  const kindSet = kinds && kinds.length > 0 ? kinds : null;
  function passes(occ: OccLike): boolean {
    if (!includeTests && occ.inTestFile) return false;
    if (kindSet && !kindSet.includes(occ.kind ?? '')) return false;
    return true;
  }

  // Seeds: one occurrence per bodyHash that lives in 'pkg' and passes filters.
  const seeds: OccLike[] = [];
  const seenSeed: Record<string, boolean> = {};
  indexes.occurrencesByHash.forEach((occs) => {
    for (const occ of occs) {
      if (pkgOf(occ) === pkg && passes(occ)) {
        if (!seenSeed[occ.bodyHash]) {
          seenSeed[occ.bodyHash] = true;
          seeds.push(occ);
        }
        break;
      }
    }
  });

  const nodeIds: Record<string, boolean> = {};
  const degree: Record<string, number> = {};
  function addNode(occ: OccLike, external: boolean): void {
    if (nodeIds[occ.bodyHash]) return;
    nodeIds[occ.bodyHash] = true;
    degree[occ.bodyHash] ??= 0;
    elements.push({
      group: 'nodes',
      data: {
        id: occ.bodyHash,
        label: displayName(occ.simpleName),
        external: external ? 1 : 0,
        totalCoupling: 0,
      },
    });
  }
  for (const seed of seeds) addNode(seed, false);

  const edgeSeen: Record<string, boolean> = {};
  seeds.forEach((seed, s2) => {
    const targets = indexes.callees.get(seed.bodyHash) ?? [];
    targets.forEach((target, t) => {
      const callee = resolveCalleeOcc(target, seed, indexes);
      if (!callee) return;
      const external = pkgOf(callee) !== pkg;
      if (external && !crossPackage) return;
      if (!external && !passes(callee)) return;
      addNode(callee, external);
      const ekey = seed.bodyHash + '\n' + callee.bodyHash;
      if (edgeSeen[ekey]) return;
      edgeSeen[ekey] = true;
      elements.push({
        group: 'edges',
        data: {
          id: 'fe' + s2 + '_' + t,
          source: seed.bodyHash,
          target: callee.bodyHash,
          weight: 1,
          isCycleEdge: false,
        },
      });
      degree[seed.bodyHash] = (degree[seed.bodyHash] || 0) + 1;
      degree[callee.bodyHash] = (degree[callee.bodyHash] || 0) + 1;
    });
  });
  for (const elem of elements) {
    if (elem.group === 'nodes') elem.data.totalCoupling = degree[elem.data.id as string] || 0;
  }
  return elements;
}
