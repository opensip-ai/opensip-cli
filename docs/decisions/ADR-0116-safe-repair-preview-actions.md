---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0116: Keep safe repair preview and apply host-owned

```yaml
id: ADR-0116
title: Keep safe repair preview and apply host-owned
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0086, ADR-0084, ADR-0095]
tags: [signals, agents, repairs, sessions, cli]
enforcement: mechanizable
enforcement-reason: >
  Repair actions live on the core SignalRepair type and round-trip through
  session replay tests; command-surface parity pins the host-owned repair group;
  planner tests cover no-write preview, forced apply, advisory refusal, and
  project-root path rejection.
```

**Decision:** `signal.repair.actions[]` is an additive typed list of concrete
repair actions, while `opensip repair preview|apply` is a CLI-host-owned command
group over stored session replay. MCP remains read-only for this phase.

**Alternatives:**

- Add write-capable MCP repair tools now. Rejected because A7 only needs a safe
  local preview/apply slice; MCP write authority belongs to the later full
  apply/verify loop.
- Let each tool apply its own fixes. Rejected because file writes, path safety,
  git cleanliness, and stale-hash checks are host concerns.
- Reuse only freeform `patchHint`. Rejected because agents need stable action
  ids, target metadata, autofixability, and verification hints.

**Rationale:** ADR-0086 created structured repair metadata but deliberately left
actual mutation out of the signal contract. The host already owns session replay,
project root discovery, output rendering, and command exit codes, so it is the
right boundary for deterministic preview/apply. Tools only annotate findings
with honest action metadata; the host validates targets, produces diffs, and
rechecks file hashes immediately before writing.

**Consequences:**

- Preview never mutates files. Apply refuses advisory actions, unsafe paths,
  oversized files, dirty git targets unless `--force` is passed, and stale file
  hashes even with `--force`.
- The first supported actions are `replace-ts-ignore` and
  `remove-unused-dependency`; `normalize-generated-config` is reserved and
  refused until a producer supplies a safe target.
- Stored sessions need no migration. Malformed action rows are dropped by replay
  decoding; valid rows are preserved in JSON, session replay, review brief
  schema, and compact MCP finding DTOs.

**Related specs / ADRs:**

- `docs/plans/completed/07-agent-apply-verify-loop.md`
- `docs/plans/ready/safe-fix-preview-actions/`
- [ADR-0086](ADR-0086-signal-repair-metadata.md)
- [ADR-0084](ADR-0084-mcp-server-surface.md)
- [ADR-0095](ADR-0095-ai-native-guardrail-platform-posture.md)
