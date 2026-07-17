---
status: active
last_verified: 2026-07-09
owner: opensip-cli
---

# ADR-0144: Host-owned presentation values (single source for display labels)

```yaml
id: ADR-0144
title: Host-owned presentation values (single source for display labels)
date: 2026-07-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0051, ADR-0058, ADR-0117, ADR-0137, ADR-0143]
tags: [cli, dashboard, mcp, presentation, format, architecture]
enforcement: mechanizable
enforced-by: ['depcruise:format-imports-nothing', 'depcruise:cli-ui-no-workspace-deps', 'depcruise:dashboard-imports-only-core-contracts', 'script:verify-gate-live', 'local:presentation-labels-via-format']
enforcement-reason: >
  Mechanizable: (1) pure formatters + narrow display projections live only in
  @opensip-cli/format; (2) depcruise allowlists pin which packages may import
  format and forbid reimplementation sites; (3) a project-local fitness check
  forbids ad-hoc duration/score string construction outside the format package
  and guards format from owning suite/count/status business aggregation.

**Decision:** Canonical **raw facts** (for example `durationMs`, `score`, unit
counts) remain host-stamped or tool-produced domain values stored and replayed
unchanged. Canonical **human display labels** derived from those facts
(`durationLabel`, `scoreLabel`) are produced **only** by pure functions and
narrow display projectors in a new zero-dependency package `@opensip-cli/format`.
CLI (Ink), HTML report (dashboard), MCP raw DTOs, and host session surfaces must
consume those functions for any human duration/score string — they must not
re-derive labels with local rounding or string math. `@opensip-cli/format` owns
**lexical presentation only**; it does not decide suite score, status, counts,
pass/fail, or wall-clock-vs-summed duration semantics.

**Public API of `@opensip-cli/format` (locked):**

| Export | Role |
|--------|------|
| `formatDuration(ms)` | Duration → human string |
| `formatScore(score)` | Score → human string |
| `projectDurationDisplay(ms)` | `{ durationMs, durationLabel }` |
| `projectSessionDisplay({ durationMs, score })` | Labels a **precomputed** score+duration pair (single session **or** upstream suite aggregate) |

There is no second multi-field projector and no suite-specific helper. Callers that
aggregate own the sum/average; they then call `projectSessionDisplay`.

**Formatter input policy (locked):** non-finite and negative inputs fall back to
the `0` display path (never throw). `formatScore` uses `Math.round` and does
**not** clamp to 0–100 — upstream `passRate` owns meaning. Identity example:
`formatDuration(19850) === "19.9s"`.

**Alternatives:**

- *Keep formatters in `@opensip-cli/core` and duplicate into `cli-ui`.* Rejected:
  `cli-ui` is an intentional workspace leaf (Ink/React only); the existing
  `formatDuration` copy in `cli-ui` already diverged from dashboard's
  `(ms/1000).toFixed(1)` path and produced 0.1s label disagreements.
- *Put formatters only in `@opensip-cli/contracts`.* Rejected: contracts depends
  on core and is the wrong home for presentation policy; `cli-ui` still cannot
  import contracts without breaking its leaf charter.
- *Embed pre-formatted strings in SQLite as the sole source of truth.* Rejected:
  raw numeric facts must remain machine-stable for agents, gates, and
  comparisons; labels are a pure projection of facts, not a second persisted
  truth.
- *Accept per-surface formatting as "skin."* Rejected: look/feel may differ;
  **lexical identity of derived values** (same `durationMs` → same `"19.8s"`)
  is a product correctness requirement across CLI, report, and host history.
- *Re-export formatters from `cli-ui`.* Rejected: dual import paths recreate
  drift; consumers import `@opensip-cli/format` directly.

**Rationale:** OpenSIP already treats timing, baselines, and run choreography as
host-owned planes (ADR-0051, ADR-0036, ADR-0117). Presentation values are the
same class of drift: multiple consumers read one SQLite row and apply different
rounding. The dogfood case — report showing `19.9s` while the CLI shows `19.8s`
for the same run — comes from dashboard using `(durationMs / 1000).toFixed(1)`
while CLI uses tenths-via-`Math.round(ms / 100)`. A pure shared package, modeled
after `@opensip-cli/clone-detection` (single-sourced algorithms, no tool→tool
edge), is the only layout that `cli-ui`, `dashboard`, `cli`, and `mcp` can all
import without violating the layer DAG.

**Layering and package charter:**

| Rule | Detail |
|------|--------|
| Package | `@opensip-cli/format` at `packages/format/` |
| Dependencies | **None** (no workspace, no runtime npm beyond TypeScript build) |
| Layer | Layer-2 leaf substrate (peer of `clone-detection` / `cli-ui` shape) |
| May import format | `cli-ui`, `cli-live`, `dashboard`, `cli`, `mcp` (if labels added later), tools that render human labels |
| Must not reimplement | Any other package constructing duration/score human labels from raw numbers |
| Must not own | Suite/count/status/pass-rate aggregation or other business meaning |
| `cli-ui` depcruise | Amend `cli-ui-no-workspace-deps` to allow **only** `packages/format/` |
| `cli-ui` barrel | Does **not** re-export formatters |
| `dashboard` depcruise | Amend dashboard allowlist to also allow `packages/format/` |
| Dashboard labels | Client imports format directly (Strategy A); no host-embedded labels required |
| Core | Remove `packages/core/src/lib/format.ts` after migration; kernel does not own presentation |

**Three guarantees:**

1. **Semantic identity** — every surface that claims to describe the same
   session/run uses the same raw fields (`durationMs`, `score`, counts) from
   the same projection of the same stored identity.
2. **Lexical identity** — human labels for those fields are byte-identical when
   produced for the same inputs (`formatDuration(19850) === "19.9s"` everywhere).
3. **Provenance identity** — post-run CLI summary, report, MCP, and `sessions
   show` refer to the **persisted** (or host-finalized) values for that run id;
   they must not silently mix a live wall-clock sample with a stored row from
   another invocation.

**Live vs final (explicit exception):**

| Phase | Allowed clock / field | Label path |
|-------|----------------------|------------|
| **Live / in-progress** | Live elapsed for spinners and stage rows may use a running clock | Still **must** call `formatDuration` (or shared projector) so rounding matches |
| **Final CLI summary** | Host `RunTimer` duration that is stamped onto `StoredSession.durationMs` | Same `formatDuration` |
| **Report / MCP / sessions / history** | **Only** persisted `durationMs` / `score` (and upstream-owned aggregate values derived from those) | Same formatters / projectors |

Live labels may change while a run is open. **After the run completes**, CLI
summary, report, and host history for that session id must never disagree on
labels for the same raws; MCP must agree on raw `durationMs` / `score`.

**Display projection:**

```ts
// Conceptual — exact names in @opensip-cli/format
projectDurationDisplay(durationMs: number): {
  durationMs: number;
  durationLabel: string;
};

projectSessionDisplay(input: { durationMs: number; score: number }): {
  durationMs: number;
  durationLabel: string;
  score: number;
  scoreLabel: string;
};

Suite aggregate **duration** for overview rows is the **sum of constituent
session (or step) `durationMs` values**, computed by the dashboard (or other
surface that owns suite semantics), then labeled via `formatDuration` /
`projectSessionDisplay`. That matches today's dashboard overview behavior and
must not silently become "suite wall clock" without a separately named field. If
a wall-clock suite span is shown later, it gets a distinct field and label
(`wallDurationMs` / `wallDurationLabel`), never overloading `durationMs`.

**MCP posture:** MCP result tools remain primarily **raw evidence ports**. This
decision requires exposing raw `durationMs` on run summaries for semantic
identity. Optional human convenience label fields may be added only in a later
change and only if produced by `@opensip-cli/format`.

**What this does not decide:** visual design (colors, density, Ink vs HTML
layout); PASS/FAIL/status wording; count labels; timestamp pretty-printing;
changing how `passRate` / score **numbers** are computed (contracts); migration
of `scripts/perf` local formatters.

**Consequences:**

- New package `@opensip-cli/format` is publishable; add it to
  `scripts/release-package-order.mjs` before consumers; first publish of the
  new npm name still requires bootstrap/OIDC trusted publishing per RELEASING.
- Delete duplicate `cli-ui` / `core` `formatDuration` implementations; no
  cli-ui re-export of formatters.
- Dashboard deletes ad-hoc duration/score label construction in favor of shared
  formatters while keeping aggregate score/count/status policy local. Check-level
  detail rows that currently force always-`ms` strings switch to shared
  `formatDuration` (e.g. `1234` → `"1.2s"`).
- Final CLI run summary duration must be the host-stamped duration for that
  run, not an independent live sample taken after tool return.
- Implementation plan:
 (local).
- Follow-up enforcement: depcruise allowlist updates + project-local fitness
  check forbidding ad-hoc duration/score label construction outside
  `packages/format/` (allowlist `scripts/perf/` until a separate cleanup), plus
  a guard that `packages/format/` does not accept session arrays or compute
  suite/count/status aggregates.

**Related ADRs:** Sibling to [ADR-0051](ADR-0051-host-owned-run-lifecycle-timing.md) (raw timing ownership), [ADR-0058](ADR-0058-shared-live-run-shell.md) / [ADR-0137](ADR-0137-live-run-five-section-render-contract.md) (shared render shell — skins consume shared labels), [ADR-0117](ADR-0117-host-owned-analysis-run-pipeline.md) (host-owned run tail), [ADR-0143](ADR-0143-host-owned-run-step-ledger.md) (run/step ledger fields used by suite projections).
