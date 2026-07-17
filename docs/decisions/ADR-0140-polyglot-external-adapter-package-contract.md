---
status: active
last_verified: 2026-07-08
owner: opensip-cli
enforcement: mechanizable
enforced-by: ['local:external-tool-adapter-contract', 'local:adapter-must-use-substrate', 'script:polyglot-external-adapter-matrix-e2e.test.ts']
enforcement-reason: >
  The shipped check validates adapter package manifests and source seams, the
  local dogfood check hardens first-party adapter paths, and the matrix E2E proves
  worker/doctor/version/fault/suite behavior for the polyglot adapter set.
---

# ADR-0140: Polyglot External Adapter Package Contract

**Decision:** Every external scanner adapter package uses `defineExternalToolAdapter`, declares the static tool manifest contract, exposes substrate-owned `doctor` and `version` commands, and delegates subprocess, output, baseline, artifact, and session effects to the substrate and host seams.

**Alternatives:** Author each adapter as a custom `defineTool` implementation. Rejected because it duplicates binary resolution, redaction, fingerprinting, worker dispatch, and host-owned persistence. Treat adapters as capability packs under another tool. Rejected because adapters are full commands with their own identity, config namespace, sessions, and gates.

**Rationale:** The polyglot wave adds many adapters across Python, Go, Rust, Java, C/C++, and generic SARIF scanners. A single substrate contract keeps the package surface reviewable and lets the host trust, validate, run, suite, and report them as ordinary installed Tools.

**Consequences:** Adapter packages must not import `node:child_process`, call `execFile`/`spawn`, import datastore/session repositories, call `defineTool` directly, or write process output/exit directly. Their manifests must include config namespace, filesystem/subprocess requirements, and no `live-view` output declarations.

**Fitness check:** `external-tool-adapter-contract` enforces the shipped package contract; `adapter-must-use-substrate` additionally covers first-party adapter source paths in this repo.

**Related ADRs:** ADR-0042; ADR-0051; ADR-0080; ADR-0082; ADR-0090; ADR-0091; ADR-0092.
