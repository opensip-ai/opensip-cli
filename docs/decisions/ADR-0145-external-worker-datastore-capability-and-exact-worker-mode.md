---
status: active
last_verified: 2026-07-09
owner: opensip-cli
---

# ADR-0145: External worker datastore capability and exact worker mode

```yaml
id: ADR-0145
title: External worker datastore capability and exact worker mode
date: 2026-07-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0054, ADR-0030, ADR-0061, ADR-0107]
tags: [cli, worker, trust, datastore, security]
enforcement: mechanizable
enforced-by: ['script:external-tool-dispatch', 'script:worker-datastore', 'script:tool-trust']
enforcement-reason: >
  Mechanizable via unit tests for resolveDatastoreAccess + denied thunk,
  forked built-CLI dispatch modes for cli.scope/currentScope denial, and
  exact-id trust tests. Structural fitness gates complement runtime proof.
```

**Decision:** External-tool workers receive a full RunScope for project/config/parse
state, but ambient datastore access is **denied**. Only when the internal command
path is exactly `__tool-command-worker` **and** the host-injected
`OPENSIP_CLI_IN_TOOL_WORKER=1` marker is set may startup discovery import an
external runtime, and bootstrap installs a `host-rpc-only` denied thunk. The
pair is validated before external package discovery; a one-sided marker fails closed with
`SYSTEM.WORKER.MODE_MISMATCH`. Privileged effects (toolState, baseline, delivery,
host planes) continue only through typed host RPC. External tool trust
allowlists admit **exact ids only** — `*` is retained as a token but ignored with
`cli.trust.tool_wildcard_ignored`. There is no in-host fallback for external
runtimes. The worker is fault and capability-channel isolation, not an OS sandbox:
admitted JavaScript retains current-user filesystem/network authority.

The existing capability-pack worker uses the same host-injected marker with its
own exact internal command, `__capability-pack-worker`. It also receives the
`host-rpc-only` datastore posture, but it never receives external Tool runtime
import authority: external Tools remain manifest-derived synthetics in that
process. Only the `__tool-command-worker` pair selects external Tool imports.

**Alternatives:**
- Context-only wrapper denying `cli.scope.datastore` — rejected: external code can
  import `currentScope()` and recover a real handle.
- Wildcard env trust (`*`) — rejected: admits every external runtime under current
  user privileges without explicit intent.
- Broad ToolScope redesign removing datastore from tools — rejected: host-composed
  bundled tools and MCP legitimately need local datastore capability.

**Rationale:** The architecture audit found workers claiming host-RPC-only datastore
while `buildPerRunScope` still installed a real local thunk. Pairing exact worker
mode with ambient denial closes the privilege channel without redesigning every
tool seam.

**Consequences:**
- `buildDeniedWorkerDatastoreThunk` + `resolveDatastoreAccess` are the sole mode gate.
- Project/installed trust env docs say `*` is ignored, not admitted.
- Residual OS authority must be documented; do not call the worker a sandbox.

**Related specs / ADRs:** Modular monolith boundary hardening Spec 20; ADR-0054 fault isolation.
