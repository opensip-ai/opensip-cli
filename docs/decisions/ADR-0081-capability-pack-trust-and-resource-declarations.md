---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0081: capability packs are deny-by-default unless bundled

```yaml
id: ADR-0081
title: capability packs are deny-by-default unless bundled
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0061, ADR-0068, ADR-0074]
tags: [plugins, trust, capabilities, supply-chain]
enforcement: mechanizable
enforcement-reason: >
  Manifest-loader tests validate the `requires` field, capability-discovery
  tests prove denied packages are not imported, and CLI load tests cover the
  exact-name allowlist plus wildcard rejection.
```

**Decision:** Marker-discovered capability packs that run in the host process
(fit packs, graph adapters, and future in-process contribution packages) are
trusted automatically only when they are bundled first-party packages. Non-bundled
capability packages require exact-name admission through
`OPENSIP_CLI_ALLOW_CAPABILITY_PACKS`; wildcard admission is ignored and warns.
Package manifests may declare `opensipTools.requires` as a normalized,
hash-covered resource declaration, but that declaration is not a sandbox.

**Alternatives:**

- **Trust marker-discovered packs by default** - rejected; they execute in the
  host process and have no worker fault boundary.
- **Reuse the whole-Tool allowlist variable** - rejected; whole Tools and
  in-process capability packs have different isolation and operator meaning.
- **Treat `requires` as enforced permissions** - rejected; no capability sandbox
  exists yet, so implying enforcement would be misleading.
- **Allow `*` for capability packs** - rejected; wildcard would silently convert
  a host-process plugin surface into ambient code execution.

**Rationale:** ADR-0061 kept public ecosystem launch gated because extension
surfaces have different trust tiers. Whole external Tools are fault-isolated in
a worker; capability packs are not. The loader must therefore deny non-bundled
host-process contributions before import unless an operator names the package.
Resource declarations are still useful as manifest facts for review,
provenance, and future policy.

**Consequences:**

- Bundled check packs and graph adapters load without operator config.
- Non-bundled fit packs and graph adapters are selected but not imported until
  exact-name allowlisted.
- Denials produce diagnostics and structured warnings without executing package
  top-level code.
- `opensipTools.requires` is validated, normalized, and hash-covered in manifest
  loading.

**Fitness check:** Covered by discovery/load tests and the ADR-0074 manifest
contract check. A separate source-pattern fitness check is not warranted until
resource declarations become enforced permissions.
