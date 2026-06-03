/**
 * Code Paths panel styling — search/chip bar, filter drawer, view tab
 * bar, info button, view containers, and the Coupling heat-map.
 *
 * All selectors here are scoped to `.code-paths-*` so they cannot
 * accidentally style the fit/sim panels.
 */
export function dashboardCssCodePaths(): string {
  return String.raw`
/* ====== Code Paths panel (v0.3) ====== */
.code-paths-search { width: 320px; margin-bottom: 12px; display: block; }
/* (The shared filter chip bar / collapsible filter drawer was removed — the
   Visualization view owns its own controls and the other views don't need it.) */
.code-paths-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; flex-wrap: wrap; }
.code-paths-tab { padding: 8px 16px; cursor: pointer; color: var(--text-dim); font-size: 13px; font-weight: 500; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; user-select: none; }
.code-paths-tab:hover { color: var(--text-secondary); }
.code-paths-tab.active { color: var(--text); border-bottom-color: var(--accent); }

/* Inline ⓘ button next to a section heading; opens the help drawer. */
.section-info { background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-dim); width: 18px; height: 18px; border-radius: 50%; font-size: 11px; font-style: italic; font-weight: 700; line-height: 16px; padding: 0; margin-left: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; transition: color 0.15s, border-color 0.15s; }
.section-info:hover { color: var(--accent); border-color: var(--accent); }
.code-paths-view { display: none; }
.code-paths-view.active { display: block; }

/* Code Paths tables can hold long file paths and synthetic function
   names; allow cells to wrap rather than overflow the card width. */
.code-paths-view .data-table { table-layout: fixed; width: 100%; }
.code-paths-view .data-table td,
.code-paths-view .data-table th { white-space: normal; word-break: break-all; overflow-wrap: anywhere; vertical-align: top; }

/* ====== Code Paths Graph view (Cytoscape) ====== */
.code-paths-graph-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.code-paths-graph-toolbar-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
/* Visualization controls — ONE CSS grid (not two flex rows) so the label and
   control columns line up like a table across both rows:
     Row 1: Layout · Scope · Highlight-cycles checkbox (spans the rest)
     Row 2: Level · Package · Kind (· Edges, function level only)
   Label columns auto-size to the widest label across both rows; control columns
   are a fixed 190px. The Package/Kind controls are disabled at package level
   (they only apply at function level), so they fade rather than vanish. */
.code-paths-graph-grid { display: grid; grid-template-columns: auto 190px auto 190px auto 190px auto 190px; gap: 10px 12px; align-items: center; margin-bottom: 12px; }
.code-paths-graph-grid .code-paths-graph-toolbar-label { justify-self: start; }
/* The cycles checkbox sits in row 1, col 5, and spans to the row end so row 2
   starts on a fresh grid row. */
.code-paths-graph-grid-rest { grid-column: 5 / -1; }
.code-paths-graph-checkbox { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); cursor: pointer; user-select: none; height: 30px; }
.code-paths-graph-checkbox input { cursor: pointer; }
/* Functions view controls row (Kind · Package · search). */
.code-paths-ranked-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: 12px; }
.code-paths-ranked-controls .code-paths-search { margin-bottom: 0; }
.code-paths-graph-select { font-size: 12px; padding: 4px 8px; border-radius: var(--radius-sm); background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-muted); font-family: var(--font); min-width: 150px; height: 30px; box-sizing: border-box; }
.code-paths-graph-select:disabled { opacity: 0.4; cursor: not-allowed; }
/* Inside the grid, controls fill their fixed 190px column so right edges align. */
.code-paths-graph-grid .code-paths-graph-select { min-width: 0; width: 100%; }
.code-paths-graph-grid .code-paths-graph-ms { width: 100%; }
.code-paths-graph-grid .code-paths-graph-ms-trigger { width: 100%; }
/* Kind multi-select: a trigger button + a checkbox popover (native
   <select multiple> renders an always-open listbox, which looked wrong). */
.code-paths-graph-ms { position: relative; display: inline-block; }
.code-paths-graph-ms-trigger { cursor: pointer; text-align: left; }
.code-paths-graph-ms-panel { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; min-width: 190px; max-height: 230px; overflow-y: auto; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px; box-shadow: 0 6px 18px rgba(0,0,0,0.45); }
.code-paths-graph-ms-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 12px; color: var(--text-muted); cursor: pointer; white-space: nowrap; border-radius: 3px; }
.code-paths-graph-ms-item:hover { background: var(--bg-hover); color: var(--text); }
.code-paths-graph-banner { font-size: 12px; color: var(--text-muted); background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; margin-bottom: 10px; }
.code-paths-graph-search { width: 320px; margin-bottom: 10px; display: block; }
.code-paths-graph-canvas { width: 100%; height: 640px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); }
/* Node highlight + impact states live on the Cytoscape canvas (set via cy
   classes gv-search-hit / gv-search-fade / gv-selected / gv-upstream /
   gv-downstream / gv-dimmed). The canvas can't read CSS custom properties,
   so the authoritative colors are inline in view-graph.ts's stylesheet;
   these DOM classes mirror the naming for any future DOM overlay. */
.search-hit { outline: 2px solid var(--accent); }
.search-fade { opacity: 0.3; }
.gv-selected { outline: 2px solid var(--accent); }
.gv-upstream { color: var(--accent-sim); }
.gv-downstream { color: var(--accent-fitness); }
.gv-dimmed { opacity: 0.1; }

/* Coupling toolbar (Export CSV) — sits between the heading and the matrix. */
.coupling-toolbar { display: flex; justify-content: flex-start; margin-bottom: 8px; }
.coupling-export-btn { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 12px; color: var(--text-muted); font-size: 12px; cursor: pointer; font-family: var(--font); }
.coupling-export-btn:hover { background: var(--bg-hover); color: var(--text); }

/* Coupling heat map cell shading — set --coupling-density per cell */
.coupling-cell { background: color-mix(in srgb, var(--bg-surface), var(--accent) calc(var(--coupling-density, 0) * 60%)); cursor: pointer; }
.coupling-cell.empty { color: var(--text-dim); cursor: default; }

/* Bounded, scrollable viewport so a large N×N matrix stays on the page —
   gives both a vertical and a horizontal scrollbar instead of overflowing. */
.coupling-scroll { overflow: auto; max-height: 70vh; max-width: 100%; }

/* border-collapse:separate (not collapse) so sticky cells keep their borders
   while scrolling — collapsed borders detach from sticky elements. Cells carry
   only right+bottom borders to avoid doubling; the first row/column add the
   top/left outer edges. */
.coupling-table { width: auto; border-collapse: separate; border-spacing: 0; font-size: 12px; }
.coupling-table th, .coupling-table td { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 4px 8px; text-align: center; min-width: 36px; }
.coupling-table thead th { border-top: 1px solid var(--border); }
.coupling-table tr > :first-child { border-left: 1px solid var(--border); }
.coupling-table th { color: var(--text-muted); background: var(--bg-surface); }
.coupling-table th.row-label { text-align: right; padding-right: 10px; }

/* Pin the header row (survives vertical scroll) and the label column (survives
   horizontal scroll); the top-left corner is pinned on both axes and layered
   above both. Sticky cells need an opaque background — the th rule above
   supplies one — so scrolling content doesn't bleed through. */
.coupling-table thead th { position: sticky; top: 0; z-index: 2; }
.coupling-table th.row-label { position: sticky; left: 0; z-index: 1; }
.coupling-table thead th.row-label { z-index: 3; }
`;
}
