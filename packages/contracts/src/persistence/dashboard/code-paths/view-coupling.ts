/**
 * View 4 — "Package coupling heat map".
 *
 * Iterates every CallEdge.to in the catalog; for each (caller-pkg,
 * callee-pkg) pair, counts. Renders a per-package N×N table with
 * text-shaded density (CSS custom property --coupling-density).
 *
 * Empty cells (no calls in this direction) show '·' and are not
 * clickable. Non-empty cells render the count; click → opens a
 * Function Card list of the actual call sites for that pair.
 */

export function dashboardViewCouplingJs(): string {
  return String.raw`
views.push({
  id: 'coupling',
  label: 'Coupling',
  help: {
    title: 'Package coupling heat map',
    sections: [
      { heading: 'What this is', body: 'A caller-by-callee matrix. Each cell counts the static call edges from one package into another. Darker shading = more calls. Click a cell to see the actual call sites.' },
      { heading: 'Why you care', body: 'Layered architectures want a clear flow of dependencies. Surprises in this matrix — a leaf package calling into core, a kernel package calling a peer — are usually layering violations or stale abstractions.' },
      { heading: 'How to read it', body: 'Read rows as "this package calls". Read columns as "this package is called by". The diagonal (a package calling itself) is normally densest. Off-diagonal density tells you which packages know about each other; absence of a cell means no call sites in that direction.' },
      { heading: 'What to do', body: 'Cells you did not expect deserve investigation. If a package is called by everyone (a column with many filled cells), that is a hub — make sure its API is intentional. If two peers both call into each other, you may have a circular dependency hiding in plain sight.' },
    ],
  },
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    // Build (caller-pkg, callee-pkg) counts from filtered occurrences.
    const counts = new Map();
    let max = 0;
    for (const occ of indexes.byBodyHash.values()) {
      if (!passesFilter(occ, filterState)) continue;
      const callerPkg = packageOfPath(occ.filePath);
      for (const edge of (occ.calls || [])) {
        for (const target of (edge.to || [])) {
          const callee = indexes.byBodyHash.get(target);
          if (!callee) continue;
          const calleePkg = packageOfPath(callee.filePath);
          let row = counts.get(callerPkg);
          if (!row) { row = new Map(); counts.set(callerPkg, row); }
          const c = (row.get(calleePkg) || 0) + 1;
          row.set(calleePkg, c);
          if (c > max) max = c;
        }
      }
    }
    const pkgs = Array.from(new Set([...counts.keys(), ...[].concat(...Array.from(counts.values(), m => Array.from(m.keys())))])).sort();
    if (pkgs.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No cross-package calls match the active filters.' }));
      return;
    }
    const section = el('div', { class: 'section' });
    section.appendChild(el('h3', { text: 'Package coupling (' + pkgs.length + '×' + pkgs.length + ')' }));
    const card = el('div', { class: 'card' });
    const table = el('table', { class: 'coupling-table' });
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', { class: 'row-label', text: 'caller \\\\ callee' }));
    for (const callee of pkgs) headRow.appendChild(el('th', { text: callee }));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const caller of pkgs) {
      const row = el('tr');
      row.appendChild(el('th', { class: 'row-label', text: caller }));
      const rowCounts = counts.get(caller);
      for (const callee of pkgs) {
        const c = (rowCounts && rowCounts.get(callee)) || 0;
        if (c === 0) {
          row.appendChild(el('td', { class: 'coupling-cell empty', text: '·' }));
        } else {
          const density = max > 0 ? (c / max).toFixed(2) : '0';
          const cell = el('td', {
            class: 'coupling-cell',
            style: '--coupling-density: ' + density,
            text: String(c),
            'data-caller': caller,
            'data-callee': callee,
            onclick: () => openCouplingDrilldown(caller, callee, indexes, filterState),
          });
          row.appendChild(cell);
        }
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    card.appendChild(table);
    section.appendChild(card);
    container.appendChild(section);
  },
});

function openCouplingDrilldown(callerPkg, calleePkg, indexes, filterState) {
  // Render an inline Function Card overlay listing the call sites for
  // the (callerPkg, calleePkg) pair. We piggyback on the overlay used
  // by the universal Function Card to keep the singleton invariant.
  let overlay = document.querySelector('.function-card-overlay');
  if (!overlay) {
    overlay = el('div', { class: 'function-card-overlay' });
    overlay.addEventListener('click', e => { if (e.target === overlay) closeFunctionCard(); });
    document.body.appendChild(overlay);
  }
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  const card = el('div', { class: 'function-card' });
  overlay.appendChild(card);
  card.appendChild(el('button', { class: 'fc-close', text: '×', onclick: closeFunctionCard }));
  card.appendChild(el('h3', { text: callerPkg + ' → ' + calleePkg }));
  card.appendChild(el('div', { class: 'fc-loc', text: 'Call sites between these packages' }));
  const list = el('ul', { class: 'fc-list' });
  let count = 0;
  for (const occ of indexes.byBodyHash.values()) {
    if (!passesFilter(occ, filterState)) continue;
    if (packageOfPath(occ.filePath) !== callerPkg) continue;
    for (const edge of (occ.calls || [])) {
      for (const target of (edge.to || [])) {
        const callee = indexes.byBodyHash.get(target);
        if (!callee) continue;
        if (packageOfPath(callee.filePath) !== calleePkg) continue;
        const item = el('li', {
          'data-body-hash': occ.bodyHash,
          text: displayName(occ.simpleName) + '  →  ' + displayName(callee.simpleName) + '   (' + occ.filePath + ':' + edge.line + ')',
        });
        item.addEventListener('click', () => openFunctionCard(occ.bodyHash));
        list.appendChild(item);
        count++;
        if (count > 200) break;
      }
      if (count > 200) break;
    }
    if (count > 200) break;
  }
  if (count === 0) list.appendChild(el('li', { class: 'external', text: 'No call sites found.' }));
  card.appendChild(list);
}
`;
}
