/**
 * Right-side help drawer — explains a single Explore view.
 *
 * Each view-*.ts puts a `help` field on its View literal:
 *   { title: string, sections: { heading: string, body: string }[] }
 * Clicking the ⓘ icon next to a tab opens this drawer with that
 * view's help. Clicking the backdrop, the × button, or pressing
 * Escape closes it. There is one drawer at a time.
 *
 * The drawer resolves help dynamically via `getView(viewId).help` — there is
 * NO static per-view help map, so registering/dropping views needs no edit
 * here.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { el } from './el.js';
import { getView } from './views-registry.js';

export function openHelpDrawer(viewId: string): void {
  const view = getView(viewId);
  if (!view?.help) return;
  closeHelpDrawer();
  const overlay = el('div', { class: 'help-drawer-overlay', id: 'help-drawer-overlay' });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHelpDrawer();
  });
  const drawer = el('aside', {
    class: 'help-drawer',
    role: 'dialog',
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty-string title must also fall back to the label (byte-identical to the legacy emitter).
    'aria-label': view.help.title || view.label,
  });
  const header = el('div', { class: 'help-drawer-header' });
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty-string title must also fall back to the label (byte-identical to the legacy emitter).
  header.append(el('h3', { text: view.help.title || view.label }));
  const closeBtn = el('button', {
    class: 'help-drawer-close',
    'aria-label': 'Close',
    text: '×',
    onclick: closeHelpDrawer,
  });
  header.append(closeBtn);
  drawer.append(header);
  const body = el('div', { class: 'help-drawer-body' });
  for (const section of view.help.sections ?? []) {
    body.append(el('h4', { text: section.heading }));
    body.append(el('p', { text: section.body }));
  }
  drawer.append(body);
  overlay.append(drawer);
  document.body.append(overlay);
  // Animate in on next frame so the CSS transition takes effect.
  requestAnimationFrame(() => overlay.classList.add('open'));
  closeBtn.focus();
}

export function closeHelpDrawer(): void {
  const existing = document.querySelector('#help-drawer-overlay');
  if (existing) existing.remove();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('#help-drawer-overlay')) closeHelpDrawer();
});
