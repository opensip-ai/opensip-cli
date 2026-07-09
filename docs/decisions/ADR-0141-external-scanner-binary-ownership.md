---
status: active
last_verified: 2026-07-08
owner: opensip-cli
enforcement: mechanizable
enforced-by: ['local:external-tool-adapter-contract', 'script:polyglot-external-adapter-matrix-e2e.test.ts']
enforcement-reason: >
  The adapter package contract keeps scanner execution on the substrate, while
  the matrix E2E exercises doctor/version success, broken binary pins, and scan
  dispatch against caller-provided binaries.
---

# ADR-0141: External Scanner Binary Ownership

**Decision:** OpenSIP adapter packages do not bundle or download scanner binaries. Users install and update scanner executables through their normal platform tooling, and OpenSIP resolves them by config pin, environment variable, then `PATH`.

**Alternatives:** Bundle scanner binaries in `@opensip-cli/tool-*` packages. Rejected because it expands supply-chain and platform support scope, obscures scanner provenance, and makes network/database mutation harder to reason about. Auto-download missing binaries from `doctor`. Rejected because `doctor` is diagnostic, not an installer.

**Rationale:** External adapters are an opt-in bridge from a customer's existing scanner fleet into OpenSIP evidence. The adapter package owns normalization; the customer owns the native scanner binary and any cache, rule, or vulnerability database lifecycle.

**Consequences:** A missing scanner is a setup diagnostic surfaced by `opensip <tool> doctor`, not a package install failure. Adapter docs and `tools list --available` must distinguish installing the OpenSIP adapter from installing the wrapped scanner.

**Fitness check:** No broader static check is warranted beyond `external-tool-adapter-contract`; binary ownership is primarily runtime behavior covered by doctor/version and broken-pin E2E tests.

**Related specs / ADRs:** ADR-0071, ADR-0090, ADR-0091, ADR-0092, ADR-0140.
