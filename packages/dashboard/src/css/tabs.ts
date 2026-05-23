/**
 * Top-level tabs and per-panel subtabs.
 *
 * Covers `.tab-bar` / `.tab` / `.tab-panel` (top of page) plus
 * `.subtab-bar` / `.subtab` / `.subtab-panel` (within a tool tab,
 * see subtab-bar.ts for the runtime helper).
 */
export function dashboardCssTabs(): string {
  return String.raw`
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
`;
}
