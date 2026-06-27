---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0082: external tools cannot declare live-view output

```yaml
id: ADR-0082
title: external tools cannot declare live-view output
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0028, ADR-0054, ADR-0058, ADR-0065]
tags: [tools, live-view, isolation, cli]
enforcement: mechanizable
enforcement-reason: >
  External-tool synthesis tests reject `output: live-view`, and `tools validate`
  has an `external-output-modes` section that fails before runtime probing.
```

**Decision:** External-provenance Tool manifests may not declare a command shell
with `output: "live-view"`. The host rejects that manifest shape during external
tool synthesis and `tools validate` reports it in the static output-mode section
without importing the runtime.

**Alternatives:**

- **Mount external live renderers in the host** - rejected; it would import and
  execute untrusted UI/runtime code in the host process, violating ADR-0054.
- **Run an external renderer in the worker and proxy Ink state** - rejected for
  now; that is a new protocol, not a manifest flag.
- **Silently downgrade to raw-stream** - rejected; output mode is part of the
  command contract and changing it changes user behavior.

**Rationale:** `live-view` is not only an output format. It is a stateful UI
renderer registered into the host's live-view registry. Bundled first-party tools
can keep that in-process contract. External tools are manifest-mounted in the
host and runtime-dispatched in a worker, so there is no safe in-process renderer
to call.

**Consequences:**

- External commands can use `command-result` or documented `raw-stream` modes.
- `tools validate` fails fast on manifest-only data and skips runtime probing
  after this incompatibility.
- A future external live-view protocol must be a new ADR and IPC contract.

**Fitness check:** Covered by external synthesis and `tools validate` coherence
tests. No source-pattern check is needed because the invalid state is manifest
data, not a repository call shape.
