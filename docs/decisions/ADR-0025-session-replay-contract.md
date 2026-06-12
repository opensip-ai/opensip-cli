---
status: active
last_verified: 2026-06-08
owner: opensip-cli
---

# ADR-0025: Session replay as a Tool-contributed projection over a shared structural decoder

```yaml
id: ADR-0025
title: Session replay as a Tool-contributed projection over a shared structural decoder
date: 2026-06-08
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0024]   # SignalEnvelope currency; CommandOutcome + observability
tags: [sessions, persistence, tool-contract, output]
enforcement: mechanizable
enforcement-reason: >
  The output path is enforced by the 2.12.0 `one-outcome-shape` guardrail (replay
  errors must flow through `cli.emitError`, success through the `renderOutcome`
  seam — no bare `emitJson({ error })` / `process.stdout.write`). The
  decode-not-re-execute boundary is a design invariant, not mechanically checked.
```

**Decision:** A stored session is **replayed**, never re-executed. The opaque
`StoredSession.payload` is decoded back into its structural shape
(`{ summary, checks[] }`) by ONE shared decoder, `decodeSessionPayload`, in
`@opensip-cli/session-store`; each tool then contributes a `sessionReplay`
projection (a new optional `Tool` contract member) that maps that structure into
a `SignalEnvelope` tagged `fidelity: 'projection'`. The host exposes it as
`sessions show <ref>` plus an inline `--show <session>` shorthand on each run
command, and routes all machine output through the 2.12.0 `CommandOutcome` seam.

**Alternatives:**
- *Re-run the tool to reproduce output.* Rejected: non-deterministic (code/config
  drift), slow, and impossible once the source has changed — replay must read the
  persisted record, not recompute it.
- *Per-tool decoders (the as-merged state).* Rejected: three near-identical
  `parseSummary`/`parseCheck`/`parseFinding` copies tripped
  `duplicate-utility-functions` and triplicated the `@throws` surface — real debt.
- *Put the decoder in the `core` kernel.* Rejected: core is the strict kernel;
  a session-payload-shaped decoder is session-domain, not kernel-generic.
- *Put the decoder in `contracts`.* Rejected: `contracts` is types-only and
  cannot host runtime.

**Rationale:** All three engines already depend on `@opensip-cli/session-store`,
which owns session persistence — so it is the natural home for the *inverse*
(structural decode for replay). The decoder holds **zero tool vocabulary**:
severity→category mapping, signal IDs, and the envelope/result shape stay in each
engine's `session-replay.ts` (`replaySignal`). This keeps the per-tool
`build*SessionPayload` (encode) and the shared decode symmetric on structure while
leaving semantics with the tools. `fidelity: 'projection'` makes the
rebuilt-not-re-run nature explicit to consumers (ADR-0011's `SignalEnvelope` is
the currency; this is a faithful projection of it, not a fresh run).

**Consequences:**
- New optional `Tool.sessionReplay` member (tool short id + `replaySession`); the
  CLI builds a `SessionReplayRegistry` from the registered tools' contributions.
- `@opensip-cli/session-store` gains `decodeSessionPayload` (and the field
  coercers) on its public surface; its charter note is amended to cover the
  structural decode while preserving the opaque-to-persistence invariant.
- Replay errors are structured `CommandOutcome` errors (`reason`/`code`:
  `not-found` / `wrong-tool` / `ambiguous-latest` / `decode-error` /
  `replay-unavailable` / `datastore-unavailable`) with exit 2, via the
  `cli.emitError` seam — `emitError` gained an optional `code` to carry the
  machine-readable category into `ErrorDetail.code`.

**Related specs / ADRs:** Builds on [ADR-0011](ADR-0011-signal-output-currency-formatter-sink.md)
(SignalEnvelope as output currency) and [ADR-0024](ADR-0024-command-outcome-and-observability.md)
(CommandOutcome / `cli.emitError`). User-facing docs:
`docs/public/70-reference/01-cli-commands.md` (`sessions show`, `--show`) and
`docs/public/80-implementation/03-session-and-persistence.md`.
