/**
 * Data tables — the `.data-table` shell used by every list view —
 * plus check rows, findings, expander rows, badges, pagination, the
 * search/filter bar, the long-description block, and the pass-rate
 * progress bar.
 *
 * One file because all of these only ever appear inside a card body
 * around a `.data-table`; splitting further would just create a pile
 * of two-rule files.
 */
export function dashboardCssDataTable(): string {
  return String.raw`
/* Table */
.data-table { width: 100%; border-collapse: collapse; }
/* Containment contract (defensive default).
   - Headers are short labels: keep them on one line.
   - Body cells WRAP and break long unbreakable tokens (file paths, regex,
     code snippets in suggestions) so a free-text column can never overrun
     the card edge and bleed past the page boundary.
   - Short metric columns (timestamps, durations, counts) opt OUT with
     the .cell-nowrap class to stay on a single line.
   This makes "no horizontal bleed" the behaviour a view gets for free;
   bleeding now requires a deliberate .cell-nowrap opt-out on long text. */
.data-table th { white-space: nowrap; }
.data-table td { white-space: normal; overflow-wrap: anywhere; }
.data-table td.cell-nowrap { white-space: nowrap; }
.data-table th { text-align: left; padding: 8px 12px; font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); font-weight: 600; cursor: pointer; }
.data-table th:hover { color: var(--text-muted); }
.data-table th[data-sort="asc"]::after { content: ' ▲'; font-size: 10px; }
.data-table th[data-sort="desc"]::after { content: ' ▼'; font-size: 10px; }
/* Shared cell baseline: every .data-table body cell renders in the standard
   site font at a consistent size, so views don't drift or force monospace.
   Set at the root here rather than per-view (item 13). */
.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; font-family: var(--font); }
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
