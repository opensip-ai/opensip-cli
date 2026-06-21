/**
 * Subtab-bar Strategy — the shared subtab pattern.
 *
 * Both the fit/sim Tool Tab (Sessions / Catalog / Recipes — three subtabs) and
 * the Code Paths Tab (Sessions / Explore — two subtabs) need the same DOM/click
 * delegation behaviour: a `.subtab-bar` of clickable headers, a stack of
 * `.subtab-panel` containers, and a single click handler that toggles the
 * `active` class on both.
 *
 * `renderSubtabBar(panel, subtabs)` declares one runtime helper that both
 * consumers call. The Strategy is the `subtabs` array — each entry is
 * `{ id, label, render(panel) }` — and `renderSubtabBar` returns the
 * panel-element map so callers can still reach into specific subpanels if they
 * need to (Code Paths does not; fit/sim's `renderToolTab` does not either).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`. The bundle
 * still exposes `renderSubtabBar` as a page global because the still-string-
 * emitted Code Paths panel calls it by bare name.
 */

import { el } from './el.js';

/** One subtab: a header label plus a renderer that populates its panel. */
export interface Subtab {
  id: string;
  label: string;
  render: (panel: HTMLElement) => void;
}

/**
 * Builds the `.subtab-bar` (with the first subtab `.active`), creates one
 * `.subtab-panel` per entry, mounts them, wires up click delegation, and finally
 * invokes each entry's `render(panel)` to populate it. Returns the `{ id → panel }`
 * map so callers can reach into a specific subpanel by id if they need to.
 */
export function renderSubtabBar(
  panel: HTMLElement,
  subtabs: readonly Subtab[],
): Record<string, HTMLElement> {
  const subtabBar = el('div', { class: 'subtab-bar' });
  const panels: Record<string, HTMLElement> = {};
  subtabs.forEach((t, i) => {
    const subtab = el('div', {
      class: 'subtab' + (i === 0 ? ' active' : ''),
      'data-subtab': t.id,
      text: t.label,
    });
    subtabBar.append(subtab);

    const subpanel = el('div', {
      class: 'subtab-panel' + (i === 0 ? ' active' : ''),
      id: panel.id + '-' + t.id,
    });
    panels[t.id] = subpanel;
  });

  panel.append(subtabBar);
  subtabs.forEach((t) => panel.append(panels[t.id]));

  subtabBar.addEventListener('click', (e) => {
    const tab = (e.target as Element | null)?.closest<HTMLElement>('.subtab');
    if (!tab) return;
    subtabBar.querySelectorAll('.subtab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    subtabs.forEach((t) => panels[t.id].classList.remove('active'));
    panels[tab.dataset.subtab!].classList.add('active');
  });

  // Render each subpanel's body. Done after mounting so renderers can safely
  // measure their host (the panel is in the document).
  subtabs.forEach((t) => t.render(panels[t.id]));

  return panels;
}
