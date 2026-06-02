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
.code-paths-filter-chips { display: block; margin-bottom: 12px; }
.code-paths-chip { font-size: 12px; padding: 3px 10px; border-radius: 12px; cursor: pointer; background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-muted); user-select: none; display: inline-block; }
.code-paths-chip:hover { background: var(--bg-hover); color: var(--text); }
.code-paths-chip.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }

/* Collapsible filter drawer header */
.code-paths-filter-header { display: flex; align-items: center; gap: 12px; }
.code-paths-filter-toggle { background: var(--bg-surface); border: 1px solid var(--border); color: var(--text); padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-family: var(--font); cursor: pointer; user-select: none; }
.code-paths-filter-toggle:hover { background: var(--bg-hover); border-color: var(--border-light); }
.code-paths-filter-toggle.open { border-color: var(--accent); color: var(--accent); }
.code-paths-filter-count { font-size: 12px; color: var(--text-dim); }
.code-paths-filter-count.active { color: var(--accent); }
.code-paths-filter-clear { margin-left: auto; background: none; border: none; color: var(--text-dim); font-size: 12px; cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm); }
.code-paths-filter-clear:hover { color: var(--text); background: var(--bg-hover); }

/* Filter drawer body — labeled rows */
.code-paths-filter-body { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; margin-top: 8px; }
.code-paths-filter-row { display: flex; gap: 12px; align-items: flex-start; padding: 6px 0; }
.code-paths-filter-row + .code-paths-filter-row { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 10px; }
.code-paths-filter-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; min-width: 70px; padding-top: 4px; }
.code-paths-filter-chips-wrap { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
.code-paths-filter-scope { display: flex; gap: 16px; }
.code-paths-filter-radio { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); cursor: pointer; user-select: none; padding: 4px 0; }
.code-paths-filter-radio:hover { color: var(--text); }
.code-paths-filter-radio.active { color: var(--text); }
.code-paths-filter-radio-dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--border-light); background: transparent; display: inline-block; }
.code-paths-filter-radio-dot.active { border-color: var(--accent); background: radial-gradient(circle, var(--accent) 0 4px, transparent 5px); }
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
.code-paths-graph-layout-btn { font-size: 12px; padding: 4px 10px; border-radius: var(--radius-sm); cursor: pointer; background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-muted); font-family: var(--font); user-select: none; }
.code-paths-graph-layout-btn:hover { background: var(--bg-hover); color: var(--text); }
.code-paths-graph-layout-btn.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.code-paths-graph-scc-btn { font-size: 12px; padding: 4px 10px; border-radius: var(--radius-sm); cursor: pointer; background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-muted); font-family: var(--font); user-select: none; margin-left: 12px; }
.code-paths-graph-scc-btn:hover { background: var(--bg-hover); color: var(--text); }
.code-paths-graph-scc-btn.active { background: #d46a6a; color: var(--bg); border-color: #d46a6a; }
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
