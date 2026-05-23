/**
 * @opensip-tools/dashboard — self-contained HTML report generator.
 *
 * Renders the OpenSIP Tools dashboard from a list of stored sessions, a
 * fitness check catalog, a recipe catalog, and (optionally) a graph
 * catalog. The output is a single self-contained HTML string with all
 * CSS and JS inlined — no external assets, no fetches, no server.
 *
 * The `GraphCatalog` and per-shape types live in
 * `@opensip-tools/contracts` because they are the contract surface
 * between the graph tool (catalog producer) and this package
 * (consumer); both depend on contracts.
 *
 * This package depends on `@opensip-tools/core` and
 * `@opensip-tools/contracts`. It MUST NOT depend on any tool engine,
 * the CLI, or any UI framework.
 */

export { generateDashboardHtml } from './generator.js';
