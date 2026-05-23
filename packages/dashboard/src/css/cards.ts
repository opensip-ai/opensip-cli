/**
 * Cards, stats grid, sections, empty states, and the trend chart.
 *
 * Container shells used by every panel — score cards, the
 * `.section + .card` shell that wraps every tabular view, and the
 * empty-state placeholder.
 */
export function dashboardCssCards(): string {
  return String.raw`
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
`;
}
