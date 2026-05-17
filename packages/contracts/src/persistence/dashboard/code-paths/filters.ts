/**
 * Filter chip state + chip-render JS for the v0.3 Code Paths panel.
 *
 * Phase P0 stub — emits a no-op placeholder. Phase P3 fills in
 * the singleton `filterState`, chip rendering, and `notifyViews()`.
 */

export function dashboardFiltersJs(): string {
  return String.raw`
const filterState = { packages: new Set(), kinds: new Set(), includeTests: false };

function renderFilterChips(container, catalog) {
  // Phase P3 implements chip rendering; P0 leaves an empty bar.
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
}

function notifyViews() {
  // Phase P3 wires the observer dispatch.
}
`;
}
