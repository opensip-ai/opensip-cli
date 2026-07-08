---
status: active
last_verified: 2026-07-08
owner: opensip-cli
enforcement: mechanizable
enforced-by: ['shipped:external-adapter-progress-private-bridge', 'script:polyglot-external-adapter-matrix-e2e.test.ts']
enforcement-reason: >
  The shipped progress-bridge check keeps the bridge private to the CLI host and
  external-tool-adapter substrate; the polyglot matrix E2E proves installed
  adapters still execute through worker dispatch and suite replay.
---

# ADR-0139: Host-Owned External Adapter Live View

**Decision:** The CLI host owns terminal live rendering for external adapters. Installed adapter workers may emit typed adapter-progress events through the private bridge, but they do not import Ink, `cli-live`, or a public progress seam.

**Alternatives:** Let each adapter declare `output: "live-view"` in its manifest. Rejected because the host must mount installed tools before importing runtime code, and ADR-0082 already reserves live-view output for host-known first-party surfaces. Add a public `ToolCliContext` progress API. Rejected because scanner progress is an adapter-substrate implementation detail, not a general tool contract.

**Rationale:** ADR-0090 keeps external adapter runtime isolated in the worker path. The host can still show useful live feedback by attaching the private progress bridge when it dispatches the worker and by falling back to the normal static/JSON/gate surfaces outside TTY runs.

**Consequences:** External adapters continue to declare raw/static command shells in manifests. Any package outside `packages/cli` and `packages/external-tool-adapter` that imports `EXTERNAL_ADAPTER_PROGRESS`, `attachExternalAdapterProgress`, or `externalAdapterProgressOf` is violating the boundary.

**Fitness check:** `external-adapter-progress-private-bridge` enforces that the bridge remains private.

**Related specs / ADRs:** ADR-0058, ADR-0082, ADR-0090, ADR-0091, ADR-0131.
