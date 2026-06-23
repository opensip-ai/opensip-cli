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
.header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
.header-icon { color: var(--accent); display: flex; align-items: center; }
.header-brand { color: var(--accent); font-size: 13px; font-weight: 500; }
.footer { color: var(--text-dim); font-size: 12px; text-align: center; padding: 24px 0; border-top: 1px solid var(--border); margin-top: 32px; }
.footer a { color: var(--accent); text-decoration: none; }
`;
}
