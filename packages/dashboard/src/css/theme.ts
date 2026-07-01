/**
 * Dashboard theme — `:root` design tokens, base reset, header.
 *
 * Defines colour palette, spacing radii, and typography variables
 * that every other CSS file consumes. Must be concatenated first.
 */
export function dashboardCssTheme(): string {
  return String.raw`
:root {
  --bg: #1a1210; --bg-surface: #231a16; --bg-card: #231a16;
  --bg-hover: #3a2e27; --text: #f4ede5; --text-secondary: #e6ddd2;
  --text-muted: #c0b2a2; --text-dim: #958474; --accent: #c49a6c;
  --accent-fitness: #7ca068; --accent-sim: #9b8aa5; --accent-yagni: #6f9fb0;
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
.header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 24px; position: relative; }
.header-icon { color: var(--accent); display: flex; align-items: center; }
.header-title { min-width: 0; }
.header-brand { color: var(--accent); font-size: 13px; font-weight: 500; }
.report-details { margin-left: auto; position: relative; font-size: 13px; }
.report-details summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; color: var(--accent); font-weight: 600; padding: 4px 0; user-select: none; }
.report-details summary::-webkit-details-marker { display: none; }
.report-details summary::after { content: ""; width: 6px; height: 6px; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); margin-top: -3px; transition: transform 0.15s, margin-top 0.15s; }
.report-details[open] summary::after { transform: rotate(-135deg); margin-top: 3px; }
.report-details-version { color: var(--text-dim); font-weight: 500; white-space: nowrap; }
.report-details-label { color: var(--accent); white-space: nowrap; }
.report-details-panel { position: absolute; right: 0; top: calc(100% + 8px); z-index: 30; width: min(560px, calc(100vw - 48px)); padding: 16px; background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: var(--radius); box-shadow: 0 18px 48px rgba(0,0,0,0.35); }
.report-details-title { color: var(--text-dim); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
.report-details-list { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; }
.report-details-list dt { color: var(--text-dim); font-weight: 600; }
.report-details-list dd { color: var(--text-secondary); font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
.footer { color: var(--text-dim); font-size: 12px; text-align: center; padding: 24px 0; border-top: 1px solid var(--border); margin-top: 32px; }
.footer a { color: var(--accent); text-decoration: none; }
@media (max-width: 640px) {
  .header { flex-wrap: wrap; }
  .report-details { width: 100%; margin-left: 0; }
  .report-details-panel { left: 0; right: auto; width: calc(100vw - 48px); }
  .report-details-list { grid-template-columns: 1fr; gap: 2px; }
  .report-details-list dd { margin-bottom: 8px; }
}
`;
}
