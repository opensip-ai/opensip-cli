/**
 * Right-side help drawer — explains a single Explore view.
 *
 * Each view-*.ts puts a `help` field on its View literal:
 *   { title: string, sections: { heading: string, body: string }[] }
 * Clicking the ⓘ icon next to a tab opens this drawer with that
 * view's help. Clicking the backdrop, the × button, or pressing
 * Escape closes it. There is one drawer at a time.
 */

export function dashboardHelpDrawerJs(): string {
  return String.raw`
function openHelpDrawer(viewId) {
  const view = (typeof getView === 'function') ? getView(viewId) : null;
  if (!view || !view.help) return;
  closeHelpDrawer();
  const overlay = el('div', { class: 'help-drawer-overlay', id: 'help-drawer-overlay' });
  overlay.addEventListener('click', e => { if (e.target === overlay) closeHelpDrawer(); });
  const drawer = el('aside', { class: 'help-drawer', role: 'dialog', 'aria-label': view.help.title || view.label });
  const header = el('div', { class: 'help-drawer-header' });
  header.appendChild(el('h3', { text: view.help.title || view.label }));
  const closeBtn = el('button', { class: 'help-drawer-close', 'aria-label': 'Close', text: '×', onclick: closeHelpDrawer });
  header.appendChild(closeBtn);
  drawer.appendChild(header);
  const body = el('div', { class: 'help-drawer-body' });
  for (const section of (view.help.sections || [])) {
    body.appendChild(el('h4', { text: section.heading }));
    body.appendChild(el('p', { text: section.body }));
  }
  drawer.appendChild(body);
  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
  // Animate in on next frame so the CSS transition takes effect.
  requestAnimationFrame(() => overlay.classList.add('open'));
  closeBtn.focus();
}

function closeHelpDrawer() {
  const existing = document.getElementById('help-drawer-overlay');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('help-drawer-overlay')) closeHelpDrawer();
});
`;
}
