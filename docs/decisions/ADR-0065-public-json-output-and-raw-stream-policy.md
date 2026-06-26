---
status: active
last_verified: 2026-06-26
owner: opensip-cli
---

# ADR-0065: Public JSON output and raw-stream policy

```yaml
id: ADR-0065
title: Public JSON output and raw-stream policy
date: 2026-06-26
status: active
supersedes: []
superseded_by: null
related: [ADR-0024, ADR-0011]
tags: [cli, output, contracts]
enforcement: mechanizable
enforcement-reason: >
  opensip-cli/fit/checks/one-outcome-shape.mjs,
  opensip-cli/fit/checks/raw-stream-output-guarded.mjs, and
  packages/fitness/checks-typescript/.../command-handler-host-owned-output.ts
  enforce host-owned public JSON and documented raw-stream transports.
```

**Decision:** Public `--json` commands return data through host-stamped `CommandOutcome` seams (`command-result`, `signal-envelope`, `cli.emitJson`, `cli.emitEnvelope`, `cli.emitError`). `output: 'raw-stream'` is allowed only for reviewed transport categories (`completion-script`, `file-export`, `worker-ipc`, `runtime-render-dispatch`, `session-replay`, `diagnostic-gate`) with in-file justification.

**Alternatives:**
- Keep per-command `process.stdout.write(JSON.stringify(...))` — rejected; outer shape drifts per command.
- Allow raw-stream for any machine output — rejected; bypasses diagnostics and exit-code stamping.
- Require every command to use live views — rejected; incompatible with CI and file-export transports.

**Rationale:** `graph lookup --json` previously wrote bare JSON to stdout while declaring `rawStreamReason: 'lookup'`. The host already owns `renderOutcome` and `CommandOutcome` assembly; routing lookup through `command-result` aligns every public JSON path with the documented contract ([`04-json-output-schema.md`](../public/70-reference/04-json-output-schema.md)).

**Consequences:** Tool handlers with `commonFlags: ['json']` must not write machine JSON directly. Raw-stream reasons are a closed set; `lookup` is not a transport category.

**Fitness check:** Check warranted — `one-outcome-shape`, `raw-stream-output-guarded`, `command-handler-host-owned-output`.

**Related specs / ADRs:** [ADR-0024](ADR-0024-command-outcome-and-observability.md), [ADR-0011](ADR-0011-signal-output-currency-formatter-sink.md).