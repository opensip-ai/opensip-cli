/**
 * @fileoverview checks-dogfood architecture checks barrel.
 *
 * These are opensip-cli-INTERNAL architecture checks, path-gated to opensip's own
 * monorepo layout and keyed on @opensip-cli package internals (ToolCliContext
 * seams, cli-live live views, bootstrap tool admission, MCP replay). They are
 * inert/meaningless for an adopter authoring their own Tool, so they are NOT
 * shipped in a public `checks-*` pack — this package is `private: true` and loads
 * only for opensip-cli's own `fit:ci` dogfood gate.
 *
 * The generic, contract-keyed *principles* behind two of these
 * (host-tool-runtime-import-boundary, command-handler-host-owned-output) were
 * historically shipped; the enforcement here dogfoods opensip's own tree.
 */
export * from './external-adapter-progress-private-bridge.js';
export * from './external-tool-adapter-contract.js';
export * from './command-handler-host-owned-output.js';
export * from './first-party-command-static-handler.js';
export * from './host-tool-runtime-import-boundary.js';
export * from './live-view-through-cli-live.js';
export * from './mcp-results-no-rerun.js';
export * from './no-bootstrap-tool-import.js';
export * from './no-full-replacement-vi-mock.js';
export * from './string-prefilter-superset.js';
export * from './no-run-done-result.js';
export * from './single-opts-assembly-seam.js';
export * from './subprocess-correlation-required.js';
