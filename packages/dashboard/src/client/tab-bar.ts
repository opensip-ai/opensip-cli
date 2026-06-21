/**
 * Top-level tab-bar click handler.
 *
 * Wires the `#tab-bar` click event to toggle the `active` class on
 * both the `.tab` headers and the `.tab-panel` containers.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

// Tab switching. `#tab-bar` always exists in the generated full page, but this
// bundle now also loads inside partial DOM fixtures (jsdom unit tests render a
// single panel). Guard the listener wiring so a missing tab-bar is an inert
// no-op rather than a load-time throw — the legacy per-module string emitter
// was simply never concatenated into those fixtures.
document.querySelector('#tab-bar')?.addEventListener('click', (e) => {
  const tab = (e.target as Element | null)?.closest<HTMLElement>('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  // The panel for the active tab is generated alongside its tab header, so it is
  // present whenever a real tab was clicked. Tab ids are simple slugs (overview,
  // fit, sim, graph), so they are safe to interpolate into an id selector.
  document.querySelector('#panel-' + tab.dataset.tab)?.classList.add('active');
});
