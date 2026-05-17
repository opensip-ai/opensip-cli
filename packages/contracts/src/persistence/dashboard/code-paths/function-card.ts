/**
 * Universal Function Card overlay — opened by every view's row click.
 *
 * `openFunctionCard(bodyHash)` looks up the occurrence in
 * `graphIndexes.byBodyHash`, renders a card with name + location +
 * meta + callers + callees + action buttons, and appends a single
 * `.function-card-overlay` element to <body>. Re-opening swaps the
 * content of the same overlay (singleton invariant — §10.2).
 *
 * Closes on Escape key (panel orchestrator), close-button click, and
 * click on the overlay backdrop. The "open in editor" and "trace from
 * entry" buttons are wired in P9.
 */

export function dashboardFunctionCardJs(): string {
  return String.raw`
function openFunctionCard(bodyHash) {
  if (!bodyHash) return;
  const occ = graphIndexes.byBodyHash.get(bodyHash);
  if (!occ) return;

  // Singleton: reuse the existing overlay if it's open.
  let overlay = document.querySelector('.function-card-overlay');
  if (!overlay) {
    overlay = el('div', { class: 'function-card-overlay' });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeFunctionCard();
    });
    document.body.appendChild(overlay);
  }
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

  const card = el('div', { class: 'function-card' });
  overlay.appendChild(card);

  const closeBtn = el('button', { class: 'fc-close', text: '×', onclick: closeFunctionCard });
  card.appendChild(closeBtn);

  card.appendChild(el('h3', { text: displayName(occ.simpleName || '<anonymous>') }));
  card.appendChild(el('div', { class: 'fc-loc', text: occ.filePath + ':' + occ.line }));

  const paramText = (occ.params || []).map(p => (p.rest ? '...' : '') + p.name + (p.optional ? '?' : '')).join(', ');
  const metaText = 'Body: ' + Math.max(0, (occ.endLine || occ.line) - occ.line + 1) + ' lines · '
    + (occ.kind || 'function') + ' · '
    + (occ.visibility || 'module-local')
    + (paramText ? ' · params: (' + paramText + ')' : '')
    + (occ.returnType ? ' · returns: ' + occ.returnType : '');
  card.appendChild(el('div', { class: 'fc-meta', text: metaText }));

  // Callers section, grouped by package of caller.
  const callerHashes = graphIndexes.callers.get(occ.bodyHash) || [];
  const callerSection = el('div', { class: 'fc-section' });
  callerSection.appendChild(el('h4', { text: 'Callers (' + callerHashes.length + ')' }));
  if (callerHashes.length === 0) {
    callerSection.appendChild(el('div', { class: 'empty', text: 'No callers in catalog.' }));
  } else {
    const list = el('ul', { class: 'fc-list' });
    const grouped = new Map();
    for (const h of callerHashes) {
      const c = graphIndexes.byBodyHash.get(h);
      if (!c) continue;
      const pkg = packageOfPath(c.filePath);
      let bucket = grouped.get(pkg);
      if (!bucket) { bucket = []; grouped.set(pkg, bucket); }
      bucket.push(c);
    }
    const pkgNames = Array.from(grouped.keys()).sort();
    for (const pkg of pkgNames) {
      const groupHeader = el('li', { class: 'external', text: pkg + ' (' + grouped.get(pkg).length + ')' });
      list.appendChild(groupHeader);
      for (const c of grouped.get(pkg)) {
        const item = el('li', {
          'data-body-hash': c.bodyHash,
          text: displayName(c.simpleName) + '  —  ' + c.filePath + ':' + c.line,
        });
        item.addEventListener('click', () => openFunctionCard(c.bodyHash));
        list.appendChild(item);
      }
    }
    callerSection.appendChild(list);
  }
  card.appendChild(callerSection);

  // Callees section.
  const calleeHashes = graphIndexes.callees.get(occ.bodyHash) || [];
  const externalCalls = (occ.calls || []).reduce((n, e) => {
    let c = 0;
    for (const t of (e.to || [])) if (!graphIndexes.byBodyHash.has(t)) c++;
    return n + c + ((e.to || []).length === 0 ? 1 : 0);
  }, 0);
  const calleeSection = el('div', { class: 'fc-section' });
  calleeSection.appendChild(el('h4', { text: 'Callees (' + calleeHashes.length + ' resolved' + (externalCalls > 0 ? ', ' + externalCalls + ' external' : '') + ')' }));
  if (calleeHashes.length === 0 && externalCalls === 0) {
    calleeSection.appendChild(el('div', { class: 'empty', text: 'No callees.' }));
  } else {
    const list = el('ul', { class: 'fc-list' });
    for (const h of calleeHashes) {
      const c = graphIndexes.byBodyHash.get(h);
      if (!c) continue;
      const item = el('li', { 'data-body-hash': c.bodyHash, text: displayName(c.simpleName) + '  —  ' + c.filePath + ':' + c.line });
      item.addEventListener('click', () => openFunctionCard(c.bodyHash));
      list.appendChild(item);
    }
    if (externalCalls > 0) {
      list.appendChild(el('li', { class: 'external', text: externalCalls + ' external or unresolved call(s)' }));
    }
    calleeSection.appendChild(list);
  }
  card.appendChild(calleeSection);

  // Action buttons.
  const actions = el('div', { class: 'fc-actions' });
  const editorUrl = editorLinkUrl(occ.filePath, occ.line);
  if (editorUrl) {
    const a = el('a', { class: 'fc-action', href: editorUrl, text: 'Open in editor' });
    actions.appendChild(a);
  } else {
    const copyBtn = el('button', {
      class: 'fc-action',
      text: 'Copy path',
      onclick: () => {
        if (navigator && navigator.clipboard) navigator.clipboard.writeText(occ.filePath + ':' + occ.line);
      },
    });
    actions.appendChild(copyBtn);
  }
  const traceBtn = el('button', {
    class: 'fc-action',
    text: 'Trace from entry',
    onclick: () => {
      const path = traceFromEntry(occ.bodyHash, graphCatalog, graphIndexes);
      renderTraceInCard(card, path);
    },
  });
  actions.appendChild(traceBtn);
  card.appendChild(actions);

  // Move keyboard focus to the close button (accessibility).
  closeBtn.focus();
}

function renderTraceInCard(card, path) {
  // Replace the body of the card with the rendered trace path. Phase P9
  // produces a real path; before then this shows a "not yet wired" hint.
  const old = card.querySelector('.fc-trace-result');
  if (old) old.parentNode.removeChild(old);
  const section = el('div', { class: 'fc-section fc-trace-result' });
  section.appendChild(el('h4', { text: 'Trace from entry point' }));
  if (!path || path.length === 0) {
    section.appendChild(el('div', { class: 'empty', text: 'No path from any entry point.' }));
  } else {
    const list = el('ol', { class: 'fc-list' });
    for (const h of path) {
      const occ = graphIndexes.byBodyHash.get(h);
      if (!occ) continue;
      const item = el('li', { 'data-body-hash': occ.bodyHash, text: displayName(occ.simpleName) + '  —  ' + occ.filePath + ':' + occ.line });
      item.addEventListener('click', () => openFunctionCard(occ.bodyHash));
      list.appendChild(item);
    }
    section.appendChild(list);
  }
  card.appendChild(section);
}

function closeFunctionCard() {
  const overlay = document.querySelector('.function-card-overlay');
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
}
`;
}
