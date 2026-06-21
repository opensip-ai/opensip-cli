/**
 * View 4 — "Package coupling heat map".
 *
 * Reads the engine-emitted `catalog.features.edge` rows (Plan C — the dashboard
 * no longer re-aggregates call edges client-side); each row is a
 * { callerPackage, calleePackage, count } directed coupling edge. Renders a
 * per-package N×N table with text-shaded density (CSS custom property
 * --coupling-density).
 *
 * The matrix is the WHOLE-GRAPH (unfiltered) coupling matrix. When the catalog
 * carries no `edge` feature (a non-dashboard run) the view shows a no-data
 * empty state.
 *
 * Empty cells (no calls in this direction) show '·' and are not clickable.
 * Non-empty cells render the count; click → opens a Function Card list of the
 * actual call sites for that pair (the drilldown keeps its own per-call-site
 * walk, which the aggregate edge feature can't provide).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`. The view
 * registers itself by pushing into the shared `views` registry at load.
 */

import { el } from './el.js';
import { passesFilter } from './filters.js';
import { closeFunctionCard, openFunctionCard } from './function-card.js';
import { makeSectionHeading } from './function-row.js';
import { resolveCalleeOcc } from './indexes.js';
import { displayName, pkgOf } from './path-utils.js';
import { views } from './views-registry.js';

import type { FilterStateLike, IndexesLike, OccLike } from './code-paths-types.js';

/** A directed coupling edge row from the engine-emitted `edge` feature. */
interface CouplingEdge {
  callerPackage: string;
  calleePackage: string;
  count: number;
}

/** caller package → (callee package → directed call count). */
type CouplingCounts = Map<string, Map<string, number>>;

views.push({
  id: 'coupling',
  label: 'Coupling',
  help: {
    title: 'Package coupling heat map',
    sections: [
      {
        heading: 'What this is',
        body: 'A caller-by-callee matrix. Each cell counts the static call edges from one package into another. Darker shading = more calls. Click a cell to see the actual call sites.',
      },
      {
        heading: 'Why you care',
        body: 'Layered architectures want a clear flow of dependencies. Surprises in this matrix — a leaf package calling into core, a kernel package calling a peer — are usually layering violations or stale abstractions.',
      },
      {
        heading: 'How to read it',
        body: 'Read rows as "this package calls". Read columns as "this package is called by". The diagonal (a package calling itself) is normally densest. Off-diagonal density tells you which packages know about each other; absence of a cell means no call sites in that direction.',
      },
      {
        heading: 'What to do',
        body: 'Cells you did not expect deserve investigation. If a package is called by everyone (a column with many filled cells), that is a hub — make sure its API is intentional. If two peers both call into each other, you may have a circular dependency hiding in plain sight.',
      },
    ],
  },
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.firstChild.remove();
    if (!catalog?.functions) {
      container.append(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    // The coupling matrix is read from the engine-emitted 'edge' feature
    // (Plan C). Each edge is { callerPackage, calleePackage, count } computed
    // via the canonical resolveCallee. The engine matrix is the WHOLE-GRAPH
    // (unfiltered) matrix; the filter chips no longer narrow it. Absent
    // features ⇒ no-data empty state (a non-dashboard run does not materialize
    // coupling).
    const features = catalog.features as { edge?: readonly CouplingEdge[] } | undefined;
    const edges = features?.edge ?? null;
    if (!edges) {
      container.append(
        el('div', {
          class: 'empty',
          text: 'No coupling data in this catalog. Re-run the graph for a dashboard to compute the package matrix.',
        }),
      );
      return;
    }
    const { counts, max } = buildCounts(edges);
    const pkgs = packageSet(counts);
    if (pkgs.length === 0) {
      container.append(el('div', { class: 'empty', text: 'No cross-package calls found.' }));
      return;
    }
    const section = el('div', { class: 'section' });
    section.append(
      makeSectionHeading('Package coupling (' + pkgs.length + '×' + pkgs.length + ')', 'coupling'),
    );
    // Export the FULL (untruncated) coupling counts as long-format CSV.
    const toolbar = el('div', { class: 'coupling-toolbar' });
    toolbar.append(
      el('button', {
        class: 'coupling-export-btn',
        text: 'Export CSV',
        onclick: () => downloadCouplingCsv(counts),
      }),
    );
    section.append(toolbar);
    const card = el('div', { class: 'card' });
    // Bounded, scrollable viewport: a large N×N matrix would otherwise run off
    // the page. overflow:auto gives both scrollbars; the sticky header/label
    // styling (see code-paths.css .coupling-scroll) keeps the axes readable.
    const scroll = el('div', { class: 'coupling-scroll' });
    scroll.append(
      buildCouplingTable(pkgs, counts, max, (caller, callee) =>
        openCouplingDrilldown(caller, callee, indexes, filterState),
      ),
    );
    card.append(scroll);
    section.append(card);
    container.append(section);
  },
});

// Aggregate the edge rows into a caller→callee count matrix + the max count
// (used for the density shading).
function buildCounts(edges: readonly CouplingEdge[]): { counts: CouplingCounts; max: number } {
  const counts: CouplingCounts = new Map();
  let max = 0;
  for (const e of edges) {
    let row = counts.get(e.callerPackage);
    if (!row) {
      row = new Map();
      counts.set(e.callerPackage, row);
    }
    row.set(e.calleePackage, e.count);
    if (e.count > max) max = e.count;
  }
  return { counts, max };
}

// Build the N×N coupling <table>. Empty cells (no calls in this direction) show
// '·' and are not clickable; non-empty cells render the count, carry a density
// custom property, and fire `onCell(caller, callee)` on click (the drilldown).
function buildCouplingTable(
  pkgs: readonly string[],
  counts: CouplingCounts,
  max: number,
  onCell: (caller: string, callee: string) => void,
): HTMLElement {
  const table = el('table', { class: 'coupling-table' });
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', { class: 'row-label', text: 'caller \\ callee' }));
  for (const callee of pkgs) headRow.append(el('th', { text: callee }));
  thead.append(headRow);
  table.append(thead);
  const tbody = el('tbody');
  for (const caller of pkgs) {
    const row = el('tr');
    row.append(el('th', { class: 'row-label', text: caller }));
    const rowCounts = counts.get(caller);
    for (const callee of pkgs) {
      const c = rowCounts?.get(callee) ?? 0;
      if (c === 0) {
        row.append(el('td', { class: 'coupling-cell empty', text: '·' }));
      } else {
        const density = max > 0 ? (c / max).toFixed(2) : '0';
        row.append(
          el('td', {
            class: 'coupling-cell',
            style: '--coupling-density: ' + density,
            text: String(c),
            'data-caller': caller,
            'data-callee': callee,
            onclick: () => onCell(caller, callee),
          }),
        );
      }
    }
    tbody.append(row);
  }
  table.append(tbody);
  return table;
}

// The package set, sorted — exactly as the table builds it (union of callers and
// every callee key across all rows).
function packageSet(counts: CouplingCounts): string[] {
  const callees: string[] = [];
  for (const m of counts.values()) for (const k of m.keys()) callees.push(k);
  return [...new Set([...counts.keys(), ...callees])].sort();
}

// Build the coupling CSV as the SAME wide matrix the on-screen table shows: a
// 'caller \ callee' corner cell, one column per callee package, one row per
// caller package, cells = the directed call count (0 where there is no edge).
// The package set and its sort match the table's, so the CSV is the grid. Full
// and untruncated. Returned as a string so it is unit testable without touching
// the DOM / Blob APIs.
function buildCouplingCsv(counts: CouplingCounts): string {
  const pkgs = packageSet(counts);
  const header = [csvField('caller \\ callee'), ...pkgs.map(csvField)].join(',');
  const rows = [header];
  for (const caller of pkgs) {
    const row = counts.get(caller);
    const cells = [csvField(caller)];
    for (const callee of pkgs) cells.push(String(row?.get(callee) ?? 0));
    rows.push(cells.join(','));
  }
  return rows.join('\n');
}

// RFC-4180-ish field quoting: wrap in double quotes and double any embedded
// quote when the value contains a comma, quote, CR, or LF. Package names are
// normally bare, but '<unknown>' and odd repo layouts make this cheap insurance.
function csvField(value: string): string {
  let s = value;
  // CSV/formula-injection guard: a cell a spreadsheet could read as a formula
  // (leading =, +, -, @, tab, or CR) is neutralized with a leading apostrophe so
  // Excel/Sheets treat it as text. Package names are untrusted — they come from
  // arbitrary analyzed repos and can legitimately start with '@' (scoped
  // packages) — so guard before the RFC-4180 quoting below.
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/["\r\n,]/.test(s)) return '"' + s.replaceAll('"', '""') + '"';
  return s;
}

// Trigger a client-side download of the coupling CSV via a Blob + a transient
// anchor. No-ops gracefully in environments without URL.createObjectURL.
function downloadCouplingCsv(counts: CouplingCounts): void {
  const csv = buildCouplingCsv(counts);
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'coupling.csv', style: 'display:none' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // @swallow-ok revoke best-effort.
      }
    }, 0);
  } catch {
    // @swallow-ok download unsupported in this environment.
  }
}

// A resolved call site between two packages: the caller occurrence, the callee
// occurrence, and the edge line.
interface CallSite {
  occ: OccLike;
  callee: OccLike;
  line: number | undefined;
}

// Call sites from a single caller occurrence into `calleePkg`.
function callSitesFromOcc(occ: OccLike, calleePkg: string, indexes: IndexesLike): CallSite[] {
  const sites: CallSite[] = [];
  for (const edge of occ.calls ?? []) {
    for (const target of edge.to ?? []) {
      const callee = resolveCalleeOcc(target, occ, indexes);
      if (callee && pkgOf(callee) === calleePkg) sites.push({ occ, callee, line: edge.line });
    }
  }
  return sites;
}

// Walk the indexed occurrences for call sites from `callerPkg` into `calleePkg`,
// honoring the active filter. Capped at 200 hits (the overlay is a sample, not a
// full report).
function collectCallSites(
  callerPkg: string,
  calleePkg: string,
  indexes: IndexesLike,
  filterState: FilterStateLike,
): CallSite[] {
  const sites: CallSite[] = [];
  for (const occ of indexes.byBodyHash.values()) {
    if (!passesFilter(occ, filterState)) continue;
    if (pkgOf(occ) !== callerPkg) continue;
    sites.push(...callSitesFromOcc(occ, calleePkg, indexes));
    if (sites.length > 200) return sites;
  }
  return sites;
}

function openCouplingDrilldown(
  callerPkg: string,
  calleePkg: string,
  indexes: IndexesLike,
  filterState: FilterStateLike,
): void {
  // Render an inline Function Card overlay listing the call sites for the
  // (callerPkg, calleePkg) pair. We piggyback on the overlay used by the
  // universal Function Card to keep the singleton invariant.
  let overlay = document.querySelector<HTMLElement>('.function-card-overlay');
  if (!overlay) {
    overlay = el('div', { class: 'function-card-overlay' });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeFunctionCard();
    });
    document.body.append(overlay);
  }
  while (overlay.firstChild) overlay.firstChild.remove();
  const card = el('div', { class: 'function-card' });
  overlay.append(card);
  card.append(el('button', { class: 'fc-close', text: '×', onclick: closeFunctionCard }));
  card.append(el('h3', { text: callerPkg + ' → ' + calleePkg }));
  card.append(el('div', { class: 'fc-loc', text: 'Call sites between these packages' }));
  const list = el('ul', { class: 'fc-list' });
  const sites = collectCallSites(callerPkg, calleePkg, indexes, filterState);
  for (const { occ, callee, line } of sites) {
    const item = el('li', {
      'data-body-hash': occ.bodyHash,
      text:
        displayName(occ.simpleName) +
        '  →  ' +
        displayName(callee.simpleName) +
        '   (' +
        occ.filePath +
        ':' +
        line +
        ')',
    });
    const hash = occ.bodyHash;
    item.addEventListener('click', () => openFunctionCard(hash));
    list.append(item);
  }
  if (sites.length === 0)
    list.append(el('li', { class: 'external', text: 'No call sites found.' }));
  card.append(list);
}
