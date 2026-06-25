# Plugin isolation surface (ADR-0054)

Internal reference for external-tool fault isolation. Public docs:
`docs/public/50-extend/06-full-tool-plugins.md`.

## Shipped (M4-E / M4-F / M4-G)

| Mechanism | Module | Behavior |
|-----------|--------|----------|
| Synthetic host registration | `synthesize-external-tool.ts` | Host mounts manifest-derived `commandSpecs` without importing runtime |
| Worker dispatch | `bind-external-dispatch.ts`, `dispatch-fork-core.ts` | External provenance always forks `__tool-command-worker` |
| Lifecycle gating | `tool-provenance.ts` (`shouldRunHookInHost`) | External hooks skip in host; run in worker |
| Runtime import boundary | `host-tool-runtime-import-boundary` check | Host may not `import()` external runtimes outside admission/dispatch |
| Bundled mount fail-closed | `register-tools-mount.ts` | Bundled `mountOneTool` failure → `PluginIncompatibleError` (exit 5) |

## Trust admission (pre-import)

- Project-local: deny-by-default; `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` allowlist.
- Installed npm: deny-by-default; `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` allowlist.
- Wildcard `*` admits all and logs `cli.trust.wildcard_allowlist` once per process.

## Remaining gap (Q7 — out of scope here)

No npm package attestation (signature verification, hash-lock at install).
**Public third-party ecosystem MUST NOT open until an attestation plan ships.**

## Tool independence (ADR-0064)

`@opensip-cli/clone-detection` is the canonical example of the platform's tool-independence rule: when two tools need the same logic, **refactor the shared piece into a leaf substrate** — never add a tool→peer-tool dependency edge. Graph and yagni both depend on `@opensip-cli/clone-detection` for duplicate/near-duplicate detection math; neither depends on the other. Enforcement: dep-cruiser `clone-detection-imports-nothing` (leaf package) + the existing `yagni-no-graph*` rules (yagni must not import graph engine/adapters). See [ADR-0064](../decisions/ADR-0064-shared-clone-detection-substrate.md).

## Related ADRs

- ADR-0054 — tool fault isolation boundary
- ADR-0056 — audit remediation scope index
- ADR-0030 — authored tool discovery
- ADR-0064 — shared clone-detection substrate (tool independence)