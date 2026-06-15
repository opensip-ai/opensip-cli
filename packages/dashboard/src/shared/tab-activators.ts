/**
 * Tab activator registry — runtime side.
 *
 * Decouples cross-tab navigation from "tab X is loaded into the page"
 * guards. The Overview row-click handler asks the registry to
 * activate the tab for a given session; each tab tooling (Code Paths
 * today; future tabs like fit-detail, sim-detail, etc.) registers
 * its activator at module init.
 *
 * New tabs that need session-aware deep-linking should call
 * `registerTabActivator(<session.tool>, fn)` at the top of their
 * JS-string emitter — the same place `dashboardCodePathsJs()` does
 * for `'graph'`.
 */
export function dashboardTabActivatorsJs(): string {
  return String.raw`
// =======================================================
// TAB ACTIVATOR REGISTRY
// =======================================================
const tabActivators = {};
function registerTabActivator(key, fn) {
  tabActivators[key] = fn;
}
function activateTabForSession(session) {
  if (!session) return false;
  const fn = tabActivators[session.tool];
  if (typeof fn !== 'function') return false;
  fn(session.id);
  return true;
}
`;
}
