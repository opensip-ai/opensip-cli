---
status: active
last_verified: 2026-06-22
owner: opensip-cli
---

# ADR-0058: Shared live-run shell and `@opensip-cli/cli-live`

```yaml
id: ADR-0058
title: Shared live-run shell and @opensip-cli/cli-live
date: 2026-06-22
status: active
supersedes: []
superseded_by: null
related: [ADR-0016, ADR-0051]
tags: [cli, cli-ui, live-view, ink]
enforcement: mechanizable
enforcement-reason: >
  The `live-view-through-cli-live` fitness check forbids direct `ink` render
  imports in first-party tool engines; dependency-cruiser pins cli-live's layer.
```

**Decision:** Extract a presentational `<LiveRun>` shell into `@opensip-cli/cli-ui`
(plain-data props, no core/contracts) and a layer-3 `@opensip-cli/cli-live` package
that owns `runToolLiveView` (state machine + `produce()` Strategy seam + core glue).
All four tools (`fit`, `graph`, `sim`, `yagni`) render live views exclusively through
cli-live.

**Alternatives:** (a) Per-tool ~30-line wrappers around a cli-ui shell without a new
package — rejected because core-typed glue would be copied 3–4 times. (b) Give cli-ui a
`core` dependency so the shell owns the state machine — rejected; breaks cli-ui's
pure-presentation charter. (c) Status quo — rejected; yagni diverged and ~1000 lines
of chrome duplicated across fit/graph/sim.

**Rationale:** `@opensip-cli/cli-ui` already shipped primitives (`Banner`, `RunHeader`,
`LiveProgress`, `RunSummary`) but no assembled live-run frame. Each tool hand-rolled an
identical loading→running→done→error machine; yagni skipped the live view and used
unconditional `verboseDetail`, producing compact-run divergence. A single shell plus a
narrow `produce()` port removes duplication while keeping worker transports tool-owned.

**Consequences:** New package and dependency-cruiser layer entry; tools pass row data to
`liveRunTable` instead of building per-tool table nodes; new tools get TTY parity by
calling `runToolLiveView`. The `live-view-through-cli-live` check enforces the seam.

**Related specs / ADRs:** ADR-0016 (shared live progress), ADR-0051 (host-owned run timing).