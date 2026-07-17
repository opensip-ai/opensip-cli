---
status: active
last_verified: 2026-07-08
owner: opensip-cli
enforcement: mechanizable
enforced-by: ['script:tool-dependency-check-tool.test.ts', 'script:polyglot-external-adapter-matrix-e2e.test.ts']
enforcement-reason: >
  The Dependency-Check adapter argument-builder test pins `--noupdate`; the
  polyglot matrix E2E proves the adapter runs through the same worker and doctor
  surfaces as the rest of the external adapter set.
---

# ADR-0142: Dependency-Check Offline-Safe Default

**Decision:** The OWASP Dependency-Check adapter runs with `--noupdate` by default. Users must pre-populate or manage the vulnerability database outside OpenSIP before relying on offline scans.

**Alternatives:** Let Dependency-Check update its database during every scan. Rejected because a static-analysis CLI run should not perform unexpected network/database mutation. Add a first-class OpenSIP updater command. Rejected because scanner database lifecycle belongs to the scanner/operator, not the adapter substrate.

**Rationale:** Dependency-Check is useful as an external scanner, but its default update behavior can perform network I/O and mutate local state. OpenSIP's CLI posture is deterministic evidence collection; the adapter should scan from an already prepared environment unless a future explicit opt-in design is approved.

**Consequences:** `dependency-check doctor` and docs must tell users to install Dependency-Check and prepare the database. A future online-update mode must be explicit config or a separate command, and must update this ADR.

**Fitness check:** No broad static check is warranted; the invariant is encoded in the Dependency-Check adapter argument-builder test and the external adapter worker E2E.

**Related ADRs:** ADR-0070; ADR-0090; ADR-0091; ADR-0092; ADR-0141.
