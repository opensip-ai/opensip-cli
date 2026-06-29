/**
 * `@opensip-cli/tool-osv-scanner` public barrel.
 *
 * Re-exports the `tool` descriptor the host loads by name through the installed
 * external-tool worker-dispatch path (`mod.tool`), plus a `default` alias and the
 * pure `parseOsvJson` normalizer (consumed by the acceptance tests). The adapter
 * internals are otherwise not public API.
 */
export { tool, tool as default, OSV_SCANNER_IDENTITY, OSV_SCANNER_STABLE_ID } from './tool.js';
export { parseOsvJson } from './parse-osv-json.js';
