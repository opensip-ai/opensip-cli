---
status: active
date: 2026-07-02
owner: opensip-cli
related:
  - ADR-0085
  - ADR-0086
  - ADR-0116
  - ADR-0123
  - ADR-0124
---

# ADR-0125: Deterministic Repair Apply-Verify Loop

## Context

OpenSIP CLI already emits structured `signal.repair.actions[]` metadata and has
host-owned `repair preview` / `repair apply` commands over stored session
replay. The remaining agent-workflow gap is verification: after an agent applies
a deterministic repair, it needs machine-readable evidence that the relevant
check actually ran and whether the finding is gone.

The risky failure mode is false confidence. A patch can apply cleanly while the
verification check never ran, ran on an incomplete scope, or still reports the
same finding.

## Decision

`repair apply` gains an explicit `--verify` mode. Without `--verify`, the
existing apply-only result stays unchanged. With `--verify`, the command returns
`repair-apply-verify`, which includes the apply status and a separate
verification verdict:

- `verified`
- `partial`
- `unverified`
- `skipped`

The first verifier supports fitness repairs only, because the shipped
deterministic repair producers are fitness findings. The host reruns:

```bash
opensip fit --check <rule> --changed --include-impacted --json
```

and classifies the returned `SignalEnvelope`. The verifier may report
`verified` only when the selected check ran, the selected finding is absent, and
impact trust is fully verified. Missing trust metadata, conservative fallback,
check errors, malformed JSON, unsupported tools, or a remaining matching finding
produce `partial` or `unverified`.

Action `verification.commands[]` metadata remains guidance. The CLI does not
execute arbitrary command strings from stored findings.

The MCP server remains read-only by default. A mutating `repair_apply_verify`
tool is registered only when the server starts with `--allow-mutations` or
`OPENSIP_MCP_ALLOW_MUTATIONS=1`. The tool delegates through a separate
`RepairWritePort`, not through the `ResultsReadPort`.

## Consequences

- Agents have a stable JSON contract for apply + verify and must not claim a fix
  unless `verification.status === "verified"`.
- Plain repair apply behavior stays compatible.
- MCP clients that do not opt into mutation continue to see the existing
  read-only tool catalog.
- Future graph/sim/yagni repairs require explicit deterministic verifier design
  before they can return `verified`.
- No datastore migration is needed; apply-verify is command output and optional
  session payload evidence, not a new persisted entity.

## Enforcement

- Contract tests cover the result shape and classifier behavior.
- Repair command tests prove refused actions skip verification and verified-mode
  uses the same apply path.
- MCP descriptor/e2e tests prove mutation is absent by default and present only
  when explicitly enabled.
- The verifier and MCP write port spawn the CLI with argument arrays and
  `shell: false`; metadata-provided commands are never executed.
