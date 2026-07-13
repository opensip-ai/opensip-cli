/**
 * Change Impact report layout and state styling.
 *
 * This concern is kept separate from the shared cards and table primitives so
 * the report can reuse those primitives without changing unrelated panels.
 * Status treatments exclusively consume theme tokens and always retain a
 * textual label or symbol in addition to colour.
 */
export function dashboardCssChangeImpact(): string {
  return String.raw`
/* ====== Change Impact report ====== */
.tab-bar { overflow-x: auto; overscroll-behavior-inline: contain; }
.change-impact-section { margin-bottom: 20px; }
.change-impact-section:last-child { margin-bottom: 0; }

.change-impact-controls { display: grid; grid-template-columns: max-content minmax(220px, 1fr); align-items: center; gap: 8px 16px; }
.change-impact-controls label { color: var(--text-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.change-impact-controls select { min-width: 0; width: min(100%, 520px); padding: 7px 10px; color: var(--text); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: var(--radius-sm); font: inherit; }
.change-impact-controls p { grid-column: 2; }

.change-impact-hero { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 6px 12px; border-inline-start: 4px solid var(--border-light); }
.change-impact-hero h2 { font-family: var(--font-display); font-size: 22px; font-weight: 500; }
.change-impact-hero > .text-muted,
.change-impact-hero > p { grid-column: 2; overflow-wrap: anywhere; }

.change-impact-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.change-impact-count { min-width: 0; margin-bottom: 0; }
.change-impact-count strong { display: block; margin-top: 4px; color: var(--text-secondary); font-size: 20px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

.change-impact-list { margin: 10px 0 0; padding-inline-start: 22px; color: var(--text-secondary); }
.change-impact-list li { margin: 5px 0; overflow-wrap: anywhere; }

.change-impact-trust { border-inline-start: 4px solid var(--accent); }
.change-impact-trust > p { margin-top: 10px; }
.change-impact-facts { display: grid; grid-template-columns: minmax(150px, max-content) minmax(0, 1fr); gap: 6px 18px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.change-impact-facts dt { color: var(--text-dim); font-weight: 600; }
.change-impact-facts dd { min-width: 0; color: var(--text-secondary); overflow-wrap: anywhere; }

.change-impact-risks > p { margin-top: 8px; }
.change-impact-risks h4 { margin-top: 18px; color: var(--text-muted); font-size: 13px; }
.change-impact-risk { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.change-impact-risk:last-child { border-bottom: 0; }
.change-impact-risk > :not(.badge) { grid-column: 2; min-width: 0; }
.change-impact-risk a { color: var(--accent); text-underline-offset: 3px; overflow-wrap: anywhere; }
.change-impact-correlation { margin-top: 12px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.change-impact-correlation summary { color: var(--text-secondary); font-weight: 600; cursor: pointer; }
.change-impact-correlation[open] summary { margin-bottom: 8px; }
.change-impact-command { display: block; max-width: 100%; margin-top: 8px; padding: 8px 10px; overflow-x: auto; color: var(--text-secondary); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }

.change-impact-section .data-table { min-width: 680px; }
.change-impact-section .card { max-width: 100%; overflow-x: auto; }
.change-impact-section .data-table td,
.change-impact-section .data-table th { vertical-align: top; }
.change-impact-section .fc-action { color: var(--text); background: var(--bg-hover); border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: 5px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.change-impact-section .fc-action:hover { color: var(--bg); background: var(--accent); border-color: var(--accent); }
.change-impact-section [aria-disabled="true"] { display: inline-block; max-width: 300px; }

.change-impact-selection-fallback { padding-inline-start: 10px; border-inline-start: 3px solid var(--warning); }
.change-impact-empty { border: 1px dashed var(--border-light); border-radius: var(--radius); }
.change-impact-empty h3 { color: var(--text-muted); }

.change-impact-verdict-pass,
.change-impact-verdict-warn,
.change-impact-verdict-fail,
.change-impact-trust [class*="trust-"] { border: 1px solid currentColor; text-transform: uppercase; letter-spacing: 0.04em; }
.change-impact-verdict-pass { color: var(--success); background: var(--success-light); }
.change-impact-verdict-pass::before { content: "✓ "; }
.change-impact-verdict-warn { color: var(--warning); background: var(--warning-light); }
.change-impact-verdict-warn::before { content: "! "; }
.change-impact-verdict-fail { color: var(--error); background: var(--error-light); }
.change-impact-verdict-fail::before { content: "× "; }
.trust-available { color: var(--success); background: var(--success-light); }
.trust-available::before { content: "✓ "; }
.trust-projection-degraded,
.trust-step-faulted,
.trust-missing-session,
.trust-legacy,
.trust-malformed { color: var(--warning); background: var(--warning-light); }
.trust-projection-degraded::before,
.trust-step-faulted::before,
.trust-missing-session::before,
.trust-legacy::before,
.trust-malformed::before { content: "! "; }
.severity-critical,
.severity-high { color: var(--error); background: var(--error-light); border: 1px solid currentColor; }
.severity-medium { color: var(--warning); background: var(--warning-light); border: 1px solid currentColor; }
.severity-low { color: var(--text-muted); background: var(--bg-hover); border: 1px solid var(--border-light); }

/* Keyboard focus is deliberately visible across the Change Impact → Code Paths flow. */
.tab { appearance: none; border-radius: 0; font-family: var(--font); }
.tab:focus-visible,
#change-impact-run-select:focus-visible,
#panel-change-impact a:focus-visible,
#panel-change-impact button:focus-visible,
.code-paths-tab:focus-visible,
.code-paths-search:focus-visible,
.code-paths-graph-search:focus-visible,
.code-paths-graph-select:focus-visible,
.code-paths-graph-ms-trigger:focus-visible,
.section-info:focus-visible,
.coupling-export-btn:focus-visible,
.function-card .fc-action:focus-visible,
.function-card .fc-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: 0 0 0 3px var(--border-light); }
.tab:disabled,
#panel-change-impact button:disabled { cursor: not-allowed; opacity: 0.55; }

@media (max-width: 720px) {
  .change-impact-controls { grid-template-columns: 1fr; }
  .change-impact-controls p { grid-column: 1; }
  .change-impact-controls select { width: 100%; }
  .change-impact-hero { grid-template-columns: 1fr; }
  .change-impact-hero > .text-muted,
  .change-impact-hero > p { grid-column: 1; }
  .change-impact-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .change-impact-facts { grid-template-columns: 1fr; gap: 2px; }
  .change-impact-facts dd { margin-bottom: 8px; }
  .change-impact-section .card { padding: 12px; }
}
@media (max-width: 440px) {
  .change-impact-counts { grid-template-columns: 1fr; }
  .change-impact-risk { grid-template-columns: 1fr; }
  .change-impact-risk > :not(.badge) { grid-column: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .tab,
  .code-paths-tab,
  .section-info { transition: none; }
  .change-impact-section *,
  .function-card * { scroll-behavior: auto; }
}
`;
}
