/**
 * Subtab-bar Strategy — JS-string emitter for the shared subtab pattern.
 *
 * Both the fit/sim Tool Tab (Sessions / Catalog / Recipes — three
 * subtabs) and the Code Paths Tab (Sessions / Explore — two subtabs)
 * need the same DOM/click-delegation behaviour: a `.subtab-bar` of
 * clickable headers, a stack of `.subtab-panel` containers, and a
 * single click handler that toggles the `active` class on both.
 *
 * Pre-F2, both call sites duplicated the same 20-line block. This
 * emitter declares one runtime helper, `renderSubtabBar(panel,
 * subtabs)`, that both consumers call. The Strategy is the
 * `subtabs` array — each entry is `{ id, label, render(panel) }` —
 * and `renderSubtabBar` returns the panel-element map so callers can
 * still reach into specific subpanels if they need to (Code Paths
 * does not, fit/sim's `renderToolTab` does not either after F2).
 *
 * The emitter must be concatenated BEFORE any caller (i.e. before
 * `dashboardToolTabsJs` and `dashboardCodePathsJs`) since both rely
 * on `renderSubtabBar` being declared in scope.
 */
export function dashboardSubtabBarJs(): string {
  return String.raw`
// =======================================================
// SUBTAB BAR (Strategy — shared by tool tabs and Code Paths)
// =======================================================
//
// renderSubtabBar(panel, subtabs)
//   panel    — host element (e.g. document.getElementById('panel-fitness'))
//   subtabs  — Array<{ id: string, label: string, render(panel): void }>
//
// Builds the .subtab-bar (with the first subtab .active), creates one
// .subtab-panel per entry, mounts them, wires up click delegation,
// and finally invokes each entry's render(panel) to populate it.
//
// Returns the { id → panel } map so callers can reach into a specific
// subpanel by id if they need to (rare; both first-party callers
// don't).
function renderSubtabBar(panel, subtabs) {
  const subtabBar = el('div', { class: 'subtab-bar' });
  const panels = {};
  subtabs.forEach((t, i) => {
    const subtab = el('div', {
      class: 'subtab' + (i === 0 ? ' active' : ''),
      'data-subtab': t.id,
      text: t.label,
    });
    subtabBar.appendChild(subtab);

    const subpanel = el('div', {
      class: 'subtab-panel' + (i === 0 ? ' active' : ''),
      id: panel.id + '-' + t.id,
    });
    panels[t.id] = subpanel;
  });

  panel.appendChild(subtabBar);
  subtabs.forEach(t => panel.appendChild(panels[t.id]));

  subtabBar.addEventListener('click', e => {
    const tab = e.target.closest('.subtab');
    if (!tab) return;
    subtabBar.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    subtabs.forEach(t => panels[t.id].classList.remove('active'));
    panels[tab.dataset.subtab].classList.add('active');
  });

  // Render each subpanel's body. Done after mounting so renderers can
  // safely measure their host (the panel is in the document).
  subtabs.forEach(t => t.render(panels[t.id]));

  return panels;
}
`;
}
