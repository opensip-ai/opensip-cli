/**
 * `@opensip-cli/tool-gitleaks` public barrel.
 *
 * Re-exports the `tool` descriptor the host loads by name through the installed
 * external-tool worker-dispatch path (`mod.tool`), plus a `default` alias and the
 * pure `parseGitleaksJson` normalizer (consumed by the acceptance tests). The
 * adapter internals are otherwise not public API.
 */
export { tool, tool as default, GITLEAKS_IDENTITY, GITLEAKS_STABLE_ID } from './tool.js';
export { parseGitleaksJson } from './parse-gitleaks-json.js';
