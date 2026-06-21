/**
 * Universal Function Card overlay — opened by every view's row click.
 *
 * `openFunctionCard(bodyHash)` looks up the occurrence in
 * `graphIndexes.byBodyHash`, renders a card with name + location +
 * meta + callers + callees + action buttons, and appends a single
 * `.function-card-overlay` element to <body>. Re-opening swaps the
 * content of the same overlay (singleton invariant — §10.2).
 *
 * Closes on Escape key (panel orchestrator), close-button click, and click on
 * the overlay backdrop. "Trace from entry" renders the shortest indexed path
 * from an inferred entry point when one exists.
 *
 * Reads the page globals `graphIndexes` / `graphCatalog` (declared by the panel
 * orchestrator, still string-emitted; typed in globals.ts).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { editorLinkUrl } from './editor-link.js';
import { el } from './el.js';
import { displayName, pkgOf } from './path-utils.js';
import { traceFromEntry } from './trace.js';

import type { OccLike } from './code-paths-types.js';

/**
 * Indirection slot for the drill-in handler. The overlay's delegated click
 * listener re-opens a card by calling `drillIn.open?.(hash)` — NOT
 * `openFunctionCard` by name. The slot is assigned `openFunctionCard` once at
 * module load (below). This is the same pattern the pagination paginators use:
 * routing the re-render through a property call (which the static call graph does
 * not resolve to the target) keeps the overlay's once-attached listener from
 * forming a render→click→render cycle, while the runtime behaviour is identical.
 */
const drillIn: { open?: (bodyHash: string) => void } = {};

/**
 * A clickable list item linking to another occurrence's card. The drill-in is
 * NOT wired per-item: each item just carries its target in `data-body-hash`, and
 * a SINGLE delegated listener on the overlay (see {@link getOrCreateOverlay})
 * reads it and re-opens the card. Event delegation (vs. a per-item `onclick`
 * closure that calls `openFunctionCard`) removes the static render→click→render
 * cycle, attaches one listener regardless of list length, and stays correct as
 * the card content is swapped on every (re)open.
 */
function occItem(c: OccLike): HTMLElement {
  return el('li', {
    'data-body-hash': c.bodyHash,
    text: displayName(c.simpleName) + '  —  ' + c.filePath + ':' + c.line,
  });
}

/** The single-line meta row: body size, kind, visibility, params, return type. */
function buildMetaRow(occ: OccLike): HTMLElement {
  const paramText = (occ.params ?? [])
    .map((p) => (p.rest ? '...' : '') + p.name + (p.optional ? '?' : ''))
    .join(', ');
  const metaText =
    'Body: ' +
    Math.max(0, (occ.endLine ?? occ.line ?? 0) - (occ.line ?? 0) + 1) +
    ' lines · ' +
    (occ.kind ?? 'function') +
    ' · ' +
    (occ.visibility ?? 'module-local') +
    (paramText ? ' · params: (' + paramText + ')' : '') +
    (occ.returnType ? ' · returns: ' + occ.returnType : '');
  return el('div', { class: 'fc-meta', text: metaText });
}

/** The Callers section: a count header + caller list grouped by package. */
function buildCallersSection(occ: OccLike): HTMLElement {
  const callerHashes = graphIndexes.callers.get(occ.bodyHash) ?? [];
  const section = el('div', { class: 'fc-section' });
  section.append(el('h4', { text: 'Callers (' + callerHashes.length + ')' }));
  if (callerHashes.length === 0) {
    section.append(el('div', { class: 'empty', text: 'No callers in catalog.' }));
    return section;
  }
  const list = el('ul', { class: 'fc-list' });
  const grouped = new Map<string, OccLike[]>();
  for (const h of callerHashes) {
    const c = graphIndexes.byBodyHash.get(h);
    if (!c) continue;
    const pkg = pkgOf(c);
    const bucket = grouped.get(pkg);
    if (bucket) bucket.push(c);
    else grouped.set(pkg, [c]);
  }
  for (const pkg of [...grouped.keys()].sort()) {
    const bucket = grouped.get(pkg)!;
    list.append(el('li', { class: 'external', text: pkg + ' (' + bucket.length + ')' }));
    for (const c of bucket) list.append(occItem(c));
  }
  section.append(list);
  return section;
}

/** Count external/unresolved call targets (not in byBodyHash, or empty edges). */
function countExternalCalls(occ: OccLike): number {
  return (occ.calls ?? []).reduce((n, e) => {
    let c = 0;
    for (const t of e.to ?? []) if (!graphIndexes.byBodyHash.has(t)) c++;
    return n + c + ((e.to ?? []).length === 0 ? 1 : 0);
  }, 0);
}

/** The Callees section: a resolved/external count header + the resolved callee list. */
function buildCalleesSection(occ: OccLike): HTMLElement {
  const calleeHashes = graphIndexes.callees.get(occ.bodyHash) ?? [];
  const externalCalls = countExternalCalls(occ);
  const section = el('div', { class: 'fc-section' });
  section.append(
    el('h4', {
      text:
        'Callees (' +
        calleeHashes.length +
        ' resolved' +
        (externalCalls > 0 ? ', ' + externalCalls + ' external' : '') +
        ')',
    }),
  );
  if (calleeHashes.length === 0 && externalCalls === 0) {
    section.append(el('div', { class: 'empty', text: 'No callees.' }));
    return section;
  }
  const list = el('ul', { class: 'fc-list' });
  for (const h of calleeHashes) {
    const c = graphIndexes.byBodyHash.get(h);
    if (c) list.append(occItem(c));
  }
  if (externalCalls > 0) {
    list.append(
      el('li', { class: 'external', text: externalCalls + ' external or unresolved call(s)' }),
    );
  }
  section.append(list);
  return section;
}

/** The action row: an "Open in editor" anchor (when a URL resolves) or "Copy path", plus "Trace from entry". */
function buildActions(occ: OccLike, card: HTMLElement): HTMLElement {
  const actions = el('div', { class: 'fc-actions' });
  const editorUrl = editorLinkUrl(occ.filePath ?? '', occ.line ?? 1);
  if (editorUrl) {
    actions.append(el('a', { class: 'fc-action', href: editorUrl, text: 'Open in editor' }));
  } else {
    actions.append(
      el('button', {
        class: 'fc-action',
        text: 'Copy path',
        onclick: () => {
          if (navigator?.clipboard) {
            void navigator.clipboard.writeText(occ.filePath + ':' + occ.line);
          }
        },
      }),
    );
  }
  actions.append(
    el('button', {
      class: 'fc-action',
      text: 'Trace from entry',
      onclick: () => {
        renderTraceInCard(card, traceFromEntry(occ.bodyHash, graphCatalog, graphIndexes));
      },
    }),
  );
  return actions;
}

/**
 * Get the singleton overlay, creating it on first open. The overlay node
 * persists across re-opens (its content is swapped), so its TWO delegated
 * listeners are attached exactly once:
 *   - backdrop click (target IS the overlay itself) → close;
 *   - drill-in click on any `li[data-body-hash]` (callers/callees/trace list
 *     items) → re-open that occurrence's card.
 * Delegation is what keeps the render path acyclic: list items no longer carry
 * per-item `openFunctionCard` closures.
 */
function getOrCreateOverlay(): HTMLElement {
  const existing = document.querySelector<HTMLElement>('.function-card-overlay');
  if (existing) return existing;
  const overlay = el('div', { class: 'function-card-overlay' });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeFunctionCard();
      return;
    }
    const target = e.target;
    if (!(target instanceof Element)) return;
    const item = target.closest<HTMLElement>('li[data-body-hash]');
    const hash = item?.dataset.bodyHash;
    // Re-open via the indirection slot (see `drillIn`), not `openFunctionCard`
    // by name — that keeps this once-attached listener out of the render cycle.
    if (hash) drillIn.open?.(hash);
  });
  document.body.append(overlay);
  return overlay;
}

export function openFunctionCard(bodyHash: string): void {
  if (!bodyHash) return;
  const occ = graphIndexes.byBodyHash.get(bodyHash);
  if (!occ) return;

  // Singleton: reuse the existing overlay if it's open, swapping its content.
  const overlay = getOrCreateOverlay();
  while (overlay.firstChild) overlay.firstChild.remove();

  const card = el('div', { class: 'function-card' });
  overlay.append(card);

  const closeBtn = el('button', { class: 'fc-close', text: '×', onclick: closeFunctionCard });
  card.append(closeBtn);

  card.append(el('h3', { text: displayName(occ.simpleName ?? '<anonymous>') }));
  card.append(el('div', { class: 'fc-loc', text: occ.filePath + ':' + occ.line }));
  card.append(buildMetaRow(occ));
  card.append(buildCallersSection(occ));
  card.append(buildCalleesSection(occ));
  card.append(buildActions(occ, card));

  // Move keyboard focus to the close button (accessibility).
  closeBtn.focus();
}

function renderTraceInCard(card: HTMLElement, path: string[] | null): void {
  // Replace the body of the card with the rendered trace path.
  const old = card.querySelector('.fc-trace-result');
  if (old) old.remove();
  const section = el('div', { class: 'fc-section fc-trace-result' });
  section.append(el('h4', { text: 'Trace from entry point' }));
  if (!path || path.length === 0) {
    section.append(el('div', { class: 'empty', text: 'No path from any entry point.' }));
  } else {
    const list = el('ol', { class: 'fc-list' });
    for (const h of path) {
      const occ = graphIndexes.byBodyHash.get(h);
      if (!occ) continue;
      // Same shape + delegated drill-in as the callers/callees lists (occItem):
      // a `li[data-body-hash]`; the overlay-level listener handles the click.
      list.append(occItem(occ));
    }
    section.append(list);
  }
  card.append(section);
}

export function closeFunctionCard(): void {
  const overlay = document.querySelector('.function-card-overlay');
  if (overlay) overlay.remove();
}

// Wire the drill-in indirection once at module load: the overlay's delegated
// listener calls `drillIn.open(hash)`, which is `openFunctionCard`. Assigning it
// here (rather than referencing `openFunctionCard` inside the listener) is what
// keeps the listener out of the render cycle.
drillIn.open = openFunctionCard;
