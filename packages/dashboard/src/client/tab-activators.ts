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
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

/** The minimal session shape the activator registry reads. */
interface ActivatableSession {
  id: string;
  tool: string;
}

type TabActivator = (sessionId: string) => void;

const tabActivators: Record<string, TabActivator> = {};

export function registerTabActivator(key: string, fn: TabActivator): void {
  tabActivators[key] = fn;
}

export function activateTabForSession(session: ActivatableSession | null | undefined): boolean {
  if (!session) return false;
  const fn = tabActivators[session.tool];
  if (typeof fn !== 'function') return false;
  fn(session.id);
  return true;
}
