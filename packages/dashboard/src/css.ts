/**
 * Dashboard CSS — all styles for the self-contained HTML dashboard.
 * Returns the contents of the <style> block.
 */

export function dashboardCss(): string {
  return String.raw`
:root {
  --bg: #1a1210; --bg-surface: #231a16; --bg-card: #231a16;
  --bg-hover: #3a2e27; --text: #f4ede5; --text-secondary: #e6ddd2;
  --text-muted: #c0b2a2; --text-dim: #958474; --accent: #c49a6c;
  --accent-fitness: #7ca068; --accent-sim: #9b8aa5;
  --success: #8fbc8f; --success-light: rgba(143,188,143,0.2);
  --warning: #d4a574; --warning-light: rgba(212,165,116,0.2);
  --error: #c75b4a; --error-light: rgba(199,91,74,0.2);
  --border: #3a2e27; --border-light: #483a31;
  --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-display: "Fraunces", Georgia, "Times New Roman", serif;
  --radius: 8px; --radius-sm: 4px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.6; padding: 24px; max-width: 1200px; margin: 0 auto; }
h1 { font-family: var(--font-display); font-size: 22px; font-weight: 500; margin-bottom: 4px; }
h1 .brand-open { color: var(--accent); }
h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
.header-icon { color: var(--accent); display: flex; align-items: center; }
.header-brand { color: var(--accent); font-size: 13px; font-weight: 500; }

/* Tabs */
.tab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
.tab { padding: 10px 20px; cursor: pointer; color: var(--text-dim); font-size: 13px; font-weight: 500; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; display: flex; align-items: center; gap: 6px; }
.tab svg { vertical-align: middle; }
.tab:hover { color: var(--text-secondary); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* Subtabs (within a tab panel) */
.subtab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.subtab { padding: 8px 16px; cursor: pointer; color: var(--text-dim); font-size: 13px; font-weight: 500; border-bottom: 2px solid transparent; transition: color 0.15s; }
.subtab:hover { color: var(--text-secondary); }
.subtab.active { color: var(--text); border-bottom-color: var(--accent); }
.subtab-panel { display: none; }
.subtab-panel.active { display: block; }

/* Cards and stats */
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
.stat-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.stat-label { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.stat-value { font-size: 28px; font-weight: 700; }
.score-good { color: var(--success); } .score-warn { color: var(--warning); } .score-bad { color: var(--error); }
.card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
.section { margin-bottom: 32px; }
.empty { color: var(--text-dim); font-style: italic; padding: 24px; text-align: center; }

/* Trend chart */
.trend-chart { display: flex; align-items: flex-end; gap: 4px; height: 80px; padding: 16px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 24px; }
.trend-bar { flex: 1; border-radius: 2px 2px 0 0; min-width: 8px; max-width: 40px; position: relative; cursor: pointer; }
.trend-bar:hover::after { content: attr(data-tooltip); position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); background: var(--bg-hover); color: var(--text); padding: 4px 8px; border-radius: var(--radius-sm); font-size: 11px; white-space: nowrap; border: 1px solid var(--border); }

/* Table */
.data-table { width: 100%; border-collapse: collapse; }
.data-table td, .data-table th { white-space: nowrap; }
.data-table th { text-align: left; padding: 8px 12px; font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); font-weight: 600; cursor: pointer; }
.data-table th:hover { color: var(--text-muted); }
.data-table th[data-sort="asc"]::after { content: ' \25B2'; font-size: 10px; }
.data-table th[data-sort="desc"]::after { content: ' \25BC'; font-size: 10px; }
.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
.data-table tr:hover { background: var(--bg-hover); }
.data-table tr.clickable { cursor: pointer; }
.data-table tr.selected { background: var(--bg-hover); border-left: 2px solid var(--accent); }

/* Check rows and findings */
.check-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.check-row:last-child { border-bottom: none; }
.check-icon { width: 20px; text-align: center; font-size: 14px; }
.check-icon.pass { color: var(--success); } .check-icon.fail { color: var(--error); }
.check-slug { font-weight: 500; flex: 1; }
.check-duration { color: var(--text-dim); font-size: 12px; min-width: 60px; text-align: right; }
.findings-toggle { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 2px 8px; border-radius: var(--radius-sm); }
.findings-toggle:hover { background: var(--bg-hover); }
.findings-list { display: none; padding: 8px 0 8px 32px; }
.findings-list.open { display: block; }
.finding-item { padding: 4px 0; font-size: 13px; color: var(--text-muted); border-left: 2px solid var(--border); padding-left: 12px; margin-bottom: 4px; }
.finding-file { color: var(--text-dim); font-size: 11px; }
.finding-sev { font-size: 11px; padding: 1px 6px; border-radius: 3px; font-weight: 500; }
.finding-sev.error { background: var(--error-light); color: var(--error); }
.finding-sev.warning { background: var(--warning-light); color: var(--warning); }

/* Expander rows */
.expander-row { display: none; }
.expander-row.open { display: table-row; }
.expander-row td { white-space: normal; }
.expander-content { padding: 8px 12px 16px 36px; background: var(--bg); border-left: 2px solid var(--accent); margin-left: 12px; }
.data-table tr.expanded td:first-child { color: var(--accent); }
.data-table tr.clickable:hover td:first-child { color: var(--accent); }

.badge { font-size: 11px; padding: 2px 8px; border-radius: 3px; font-weight: 500; display: inline-block; }
.badge-pass { background: var(--success-light); color: var(--success); }
.badge-fail { background: var(--error-light); color: var(--error); }
.badge-warn { background: var(--warning-light); color: var(--warning); }

/* Pagination */
.pagination { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; margin-top: 8px; }
.pagination-info { font-size: 12px; color: var(--text-dim); }
.pagination-btns { display: flex; gap: 4px; }
.pagination-btn { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 12px; color: var(--text-muted); font-size: 12px; cursor: pointer; }
.pagination-btn:hover { background: var(--bg-hover); color: var(--text); }
.pagination-btn.disabled { opacity: 0.3; cursor: default; pointer-events: none; }
.pagination-btn.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }

.footer { color: var(--text-dim); font-size: 12px; text-align: center; padding: 24px 0; border-top: 1px solid var(--border); margin-top: 32px; }
.footer a { color: var(--accent); text-decoration: none; }

/* Tag badges */
.tag-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--bg-hover); color: var(--text-muted); display: inline-block; margin-right: 3px; margin-bottom: 2px; white-space: nowrap; }

/* Confidence badges */
.badge-high { background: rgba(143,188,143,0.2); color: var(--success); }
.badge-medium { background: rgba(212,165,116,0.2); color: var(--warning); }
.badge-low { background: rgba(199,91,74,0.15); color: var(--text-dim); }

/* Search & filter bar */
.filter-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.search-input { background: var(--bg-surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; font-size: 13px; font-family: var(--font); width: 240px; }
.search-input::placeholder { color: var(--text-dim); }
.search-input:focus { outline: none; border-color: var(--accent); }
.filter-select { background: var(--bg-surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; font-size: 12px; cursor: pointer; font-family: var(--font); }

/* Check long description */
.check-long-desc { padding: 12px 16px; color: var(--text-muted); font-size: 13px; line-height: 1.7; max-width: 800px; }
.check-long-desc strong { color: var(--text); font-weight: 600; }
.check-long-desc code { background: var(--bg-hover); padding: 1px 4px; border-radius: 2px; font-size: 12px; }

/* Pass rate bar */
.pass-rate-bar { display: inline-flex; align-items: center; gap: 6px; }
.pass-rate-track { width: 48px; height: 6px; border-radius: 3px; background: var(--bg-hover); overflow: hidden; display: inline-block; vertical-align: middle; }
.pass-rate-fill { height: 6px; border-radius: 3px; display: block; }

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

/* Coupling heat map cell shading — set --coupling-density per cell */
.coupling-cell { background: color-mix(in srgb, var(--bg-surface), var(--accent) calc(var(--coupling-density, 0) * 60%)); cursor: pointer; }
.coupling-cell.empty { color: var(--text-dim); cursor: default; }
.coupling-table { width: auto; border-collapse: collapse; font-size: 12px; }
.coupling-table th, .coupling-table td { border: 1px solid var(--border); padding: 4px 8px; text-align: center; min-width: 36px; }
.coupling-table th { color: var(--text-muted); background: var(--bg-surface); }
.coupling-table th.row-label { text-align: right; padding-right: 10px; }

/* Function Card overlay */
.function-card-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: flex-start; justify-content: center; padding: 60px 16px 16px; z-index: 1000; overflow-y: auto; }
.function-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; max-width: 720px; width: 100%; max-height: calc(100vh - 80px); overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
.function-card h3 { color: var(--accent); text-transform: none; letter-spacing: 0; font-size: 16px; margin-bottom: 4px; }
.function-card .fc-loc { color: var(--text-dim); font-size: 12px; margin-bottom: 10px; word-break: break-all; }
.function-card .fc-meta { color: var(--text-muted); font-size: 12px; margin-bottom: 10px; }
.function-card .fc-section { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px; }
.function-card .fc-section h4 { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; font-weight: 600; }
.function-card .fc-list { list-style: none; padding: 0; margin: 0; }
.function-card .fc-list li { padding: 4px 0; font-size: 13px; cursor: pointer; color: var(--text); border-left: 2px solid transparent; padding-left: 8px; }
.function-card .fc-list li[data-body-hash]:hover { background: var(--bg-hover); border-left-color: var(--accent); }
.function-card .fc-list li.external { color: var(--text-dim); cursor: default; }
.function-card .fc-actions { display: flex; gap: 8px; margin-top: 12px; }
.function-card .fc-action { background: var(--bg-hover); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 12px; font-size: 12px; cursor: pointer; text-decoration: none; display: inline-block; }
.function-card .fc-action:hover { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.function-card .fc-close { float: right; background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 18px; padding: 0 6px; }
.function-card .fc-close:hover { color: var(--text); }

/* Help drawer (right-side slide-out) */
.help-drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0); transition: background 0.2s ease; z-index: 1100; pointer-events: none; }
.help-drawer-overlay.open { background: rgba(0,0,0,0.45); pointer-events: auto; }
.help-drawer { position: absolute; top: 0; right: 0; height: 100vh; width: 420px; max-width: 90vw; background: var(--bg-surface); border-left: 1px solid var(--border); box-shadow: -8px 0 24px rgba(0,0,0,0.4); display: flex; flex-direction: column; transform: translateX(100%); transition: transform 0.25s ease; }
.help-drawer-overlay.open .help-drawer { transform: translateX(0); }
.help-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid var(--border); }
.help-drawer-header h3 { font-size: 16px; color: var(--accent); text-transform: none; letter-spacing: 0; margin: 0; }
.help-drawer-close { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 22px; line-height: 1; padding: 0 4px; }
.help-drawer-close:hover { color: var(--text); }
.help-drawer-body { padding: 16px 20px 24px; overflow-y: auto; flex: 1; }
.help-drawer-body h4 { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin: 14px 0 6px; font-weight: 600; }
.help-drawer-body h4:first-child { margin-top: 0; }
.help-drawer-body p { font-size: 13px; color: var(--text); margin: 0 0 10px; line-height: 1.6; }
`;
}
