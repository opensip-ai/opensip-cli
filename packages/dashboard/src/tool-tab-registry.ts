/** Tool tab descriptor shared by the dashboard generator and registrations. */

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
