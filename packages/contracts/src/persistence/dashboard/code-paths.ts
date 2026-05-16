/**
 * Dashboard Code Paths panel — renders the graph tool's static
 * call-graph findings (orphans, duplicates, dead branches, etc.).
 *
 * Sessions whose `tool === 'graph'` are picked up automatically by
 * the existing session-load path. The panel is purely client-side
 * JS that filters those sessions and produces a navigable list.
 */

export function dashboardCodePathsJs(): string {
  return `
function renderCodePathsTab() {
  const panel = document.getElementById('panel-code-paths');
  if (!panel) return;
  const graphSessions = sessions.filter(s => s.tool === 'graph');
  if (graphSessions.length === 0) {
    panel.innerHTML = \`
      <div class="card">
        <h2>Code Paths</h2>
        <p>No graph sessions yet. Run <code>opensip-tools graph</code> to generate one.</p>
      </div>\`;
    return;
  }
  const latest = graphSessions[0];
  const total = (latest.summary && latest.summary.total) ? latest.summary.total : 0;
  const findings = (latest.summary && (latest.summary.errors + latest.summary.warnings)) || 0;

  const byRule = {};
  for (const c of latest.checks || []) {
    const rule = c.checkSlug;
    byRule[rule] = byRule[rule] || [];
    for (const f of c.findings || []) byRule[rule].push(f);
  }

  let html = \`
    <div class="card">
      <h2>Code Paths — graph tool</h2>
      <p class="muted">Static call-graph + dead-end findings from the most recent <code>opensip-tools graph</code> run.</p>
      <ul class="metrics">
        <li><strong>\${total}</strong> rule(s) ran</li>
        <li><strong>\${findings}</strong> finding(s)</li>
        <li><strong>\${graphSessions.length}</strong> historical session(s)</li>
      </ul>
    </div>\`;
  const slugs = Object.keys(byRule).sort();
  for (const slug of slugs) {
    const items = byRule[slug] || [];
    html += \`
      <div class="card">
        <h3>\${slug} <span class="badge">\${items.length}</span></h3>
        <ul class="findings">\`;
    for (const f of items.slice(0, 50)) {
      const loc = (f.line ? ':' + f.line : '');
      html += \`<li><code>\${f.filePath || ''}\${loc}</code> — \${f.message}</li>\`;
    }
    if (items.length > 50) {
      html += \`<li class="muted">…and \${items.length - 50} more.</li>\`;
    }
    html += \`</ul></div>\`;
  }
  panel.innerHTML = html;
}
`;
}
