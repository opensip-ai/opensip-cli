/**
 * Function Card overlay — the modal that appears when you click a
 * function row in any Code Paths view.
 */
export function dashboardCssFunctionCard(): string {
  return String.raw`
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
`;
}
