---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0080: durable tool artifacts write through the host

```yaml
id: ADR-0080
title: durable tool artifacts write through the host
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0036, ADR-0054, ADR-0075]
tags: [tools, persistence, artifacts, cli]
enforcement: mechanizable
enforcement-reason: >
  Fitness check `no-raw-fs-artifact-write-in-tool-engine` forbids durable raw fs
  writes from first-party tool engine paths and allows the host-owned
  `cli.writeArtifact` seam.
```

**Decision:** Durable artifacts authored by a tool command must be written via
`ToolCliContext.writeArtifact(path, bytes)` or a narrower host-owned seam such as
`writeSarif`. The CLI composition root performs path resolution, lock/atomic
write policy, and diagnostics.

**Alternatives:**

- **Let tools call `fs.writeFile` directly** - rejected; this bypasses artifact
  locks, atomic rename, and uniform diagnostics.
- **Add one seam per artifact kind** - rejected; SARIF has a typed seam, but
  generic exports need a small host primitive without expanding the contract for
  every file format.
- **Expose datastore or path helpers to tools** - rejected; durable writes are a
  host plane, not a tool-owned persistence API.

**Rationale:** ADR-0075 made state and artifact locking host-owned. Some graph
export paths still wrote JSON artifacts from engine code, creating a gap between
the documented host seam policy and real writes. A generic artifact seam keeps
tool engines independent of the CLI while preserving host ownership of the
effect.

**Consequences:**

- `ToolCliContext` has a required `writeArtifact` method.
- Worker-dispatched external tools call the seam over host RPC.
- First-party graph export/index paths route durable JSON outputs through the
  context.
- Raw fs writes remain allowed only for ephemeral diagnostics, worker transport,
  or documented allowlisted profiling paths.

**Fitness check:** `no-raw-fs-artifact-write-in-tool-engine`.
