/**
 * Dashboard theme — `:root` design tokens, base reset, header.
 *
 * Defines colour palette, spacing radii, and typography variables
 * that every other CSS file consumes. Must be concatenated first.
 */
export function dashboardCssTheme(): string {
  return String.raw`
:root {
  /* Neutral near-black surfaces matched to the opensip.ai marketing site
     (its tokens are pure grayscale — hsl(0 0% N%)). Warmth comes ONLY from
     the gold --accent (site --primary: hsl(29 42% 59%) = #c4956a), so the
     report and the website read as one brand. Semantic status colours
     (fitness/sim/yagni/success/warning/error) are intentionally kept. */
  --bg: #0a0a0a; --bg-surface: #0f0f0f; --bg-card: #0f0f0f;
  --bg-hover: #1f1f1f; --text: #ededed; --text-secondary: #d4d4d4;
  --text-muted: #bdbdbd; --text-dim: #8a8a8a; --accent: #c4956a;
  --accent-fitness: #7ca068; --accent-sim: #9b8aa5; --accent-yagni: #6f9fb0;
  --success: #8fbc8f; --success-light: rgba(143,188,143,0.2);
  --warning: #d4a574; --warning-light: rgba(212,165,116,0.2);
  --error: #c75b4a; --error-light: rgba(199,91,74,0.2);
  --border: #1f1f1f; --border-light: #2a2a2a;
  /* Type matched to opensip.ai: Geist sans everywhere, Geist Mono for code.
     Like the site, display headings are the SAME family differentiated by
     weight (not a separate serif) — see the bumped h1/h2 weights below. */
  --font: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-display: var(--font);
  --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --radius: 8px; --radius-sm: 4px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.6; padding: 24px; max-width: 1200px; margin: 0 auto; }
h1 { font-family: var(--font-display); font-size: 22px; font-weight: 600; margin-bottom: 4px; }
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
.report-details-link { color: inherit; text-decoration: underline; text-decoration-color: currentColor; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.report-details-link:hover { color: var(--accent); }
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

/* ── Ambient background effects (ported from opensip.ai) ──
   Two decorative layers give the near-black surface the same modern depth as
   the marketing site. Both are inert (pointer-events:none, aria-hidden) and
   self-contained (inline SVG data URI + CSS), so the report stays a single file.

   1. Grain: a fixed fractal-noise overlay floated ABOVE content at very low
      opacity via 'overlay' blend — adds material texture without hurting text.
   2. Orbs: large blurred colour fields on a fixed layer pinned BEHIND all
      content (z-index:-1, above the body's black paint). 'screen' blend over
      black renders them as soft gold/blue glows in the page margins; opaque
      content cards sit on top, so data readability is untouched. */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 180px 180px;
  opacity: 0.038;
  pointer-events: none;
  z-index: 9999;
  mix-blend-mode: overlay;
}
.report-ambient { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: -1; }
.orb { position: absolute; border-radius: 9999px; filter: blur(110px); will-change: transform; mix-blend-mode: screen; }
.orb-1 { width: 800px; height: 800px; background: hsl(29 42% 59%); top: -250px; right: -200px; opacity: 0.2; animation: orb-drift 22s ease-in-out infinite; }
.orb-2 { width: 600px; height: 600px; background: hsl(220 70% 55%); bottom: 30%; left: -200px; opacity: 0.1; animation: orb-drift-alt 28s ease-in-out infinite; }
.orb-3 { width: 500px; height: 500px; background: hsl(29 42% 59%); bottom: 5%; right: 10%; opacity: 0.15; animation: orb-drift 18s ease-in-out infinite reverse; }
@keyframes orb-drift {
  0%, 100% { transform: translate(0px, 0px) scale(1); }
  25% { transform: translate(50px, -40px) scale(1.06); }
  50% { transform: translate(-30px, 30px) scale(0.94); }
  75% { transform: translate(40px, 50px) scale(1.03); }
}
@keyframes orb-drift-alt {
  0%, 100% { transform: translate(0px, 0px) scale(1); }
  25% { transform: translate(-50px, 30px) scale(0.96); }
  50% { transform: translate(40px, -25px) scale(1.04); }
  75% { transform: translate(-30px, -40px) scale(0.98); }
}
@media (prefers-reduced-motion: reduce) {
  .orb { animation: none; }
}
`;
}
