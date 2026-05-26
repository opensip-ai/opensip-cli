/**
 * Tool tab registry — the extension point for top-level tabs.
 *
 * `generator.ts` walks the registry to emit (1) the tab buttons in the
 * top-level `.tab-bar`, (2) the per-tab `<div id="panel-…">` containers,
 * (3) the per-tab `render*Tab()` calls in the inlined `<script>`, and
 * (4) Overview's `tool → tab` and badge-style maps. Adding a new tool
 * tab is a `defineToolTab` call plus shipping the tool's `render*Tab`
 * JS-string emitter — no central-dispatcher edits.
 *
 * Mirrors `defineRankedView` (Code Paths) and `tabActivators`
 * (cross-tab navigation): a single descriptor type + a registry +
 * iteration in the generator.
 *
 * The Overview tab is intentionally NOT in this registry — it is a
 * cross-tool aggregate by design and lives outside the per-tool
 * abstraction.
 */

/**
 * Descriptor for a top-level tool tab (Fitness, Simulation, Code
 * Paths, …). All fields are required to keep the registry shape
 * predictable; tools that don't carry per-session state (e.g. a
 * future "audit" tool with no detail view) still supply a `tool`
 * key — Overview's row-click handler uses it for the tabMap.
 */
export interface ToolTabDescriptor {
  /**
   * The DOM tab id, used for `data-tab="<id>"` and `panel-<id>`.
   * Examples: `'fitness'`, `'simulation'`, `'code-paths'`.
   */
  id: string;
  /**
   * The `StoredSession.tool` key whose sessions belong on this tab.
   * Examples: `'fit'`, `'sim'`, `'graph'`. Used by Overview to map
   * a session to a tab and by `tabActivators` for deep-link routing.
   */
  tool: string;
  /** Tab label, e.g. `'Fitness'`. */
  label: string;
  /** SVG markup for the tab icon. Spliced verbatim into the `.tab` div. */
  icon: string;
  /**
   * Inline `style` value for the `.badge` element rendered for this
   * tool in Overview's Recent Activity table. Example:
   * `'background:rgba(124,160,104,0.15);color:var(--accent-fitness)'`.
   */
  badgeStyle: string;
  /**
   * Name of the JS-side `render*Tab()` function the tool's emitter
   * declares. The generator emits a call to this name in the inlined
   * `<script>` after all emitters run. Must be a plain identifier
   * (no parentheses) — the generator appends `();`.
   */
  renderFunctionName: string;
}

const registry: ToolTabDescriptor[] = [];

/**
 * Register a top-level tool tab. Called at module load by every tool
 * that ships a tab (today: fit, sim, graph). Order of registration
 * controls tab-bar order; the existing fit/sim/graph order is what
 * pre-F1 hard-coded, so callers should preserve it.
 */
export function defineToolTab(descriptor: ToolTabDescriptor): void {
  registry.push(descriptor);
}

/**
 * Snapshot of the current registry. Returned as a fresh array so
 * callers can iterate without worrying about concurrent registration.
 */
export function listToolTabs(): ToolTabDescriptor[] {
  return [...registry];
}

