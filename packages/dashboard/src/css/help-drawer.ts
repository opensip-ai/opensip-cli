/**
 * Help drawer — the right-side slide-out triggered by the inline `ⓘ`
 * button next to each Code Paths view's section heading.
 */
export function dashboardCssHelpDrawer(): string {
  return String.raw`
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
