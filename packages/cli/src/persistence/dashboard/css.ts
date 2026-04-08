/**
 * Dashboard CSS — all styles for the self-contained HTML dashboard.
 * Returns the contents of the <style> block.
 */

export function dashboardCss(): string {
  return `
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
.data-table th[data-sort="asc"]::after { content: ' \\25B2'; font-size: 10px; }
.data-table th[data-sort="desc"]::after { content: ' \\25BC'; font-size: 10px; }
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
`;
}
