/**
 * `@opensip-cli/tool-trivy` public barrel.
 *
 * Re-exports the `tool` descriptor the host loads by name through the installed
 * external-tool worker-dispatch path (`mod.tool`), plus a `default` alias and the
 * identity/stable-id constants. There is NO per-adapter SARIF parser: Trivy routes
 * its SARIF output through the substrate's shared `ingestSarif` (the single SARIF
 * read path, ADR-0091). The adapter internals are otherwise not public API.
 */
export { tool, tool as default, TRIVY_IDENTITY, TRIVY_STABLE_ID } from './tool.js';
