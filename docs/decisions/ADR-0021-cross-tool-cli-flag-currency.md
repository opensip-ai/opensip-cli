---
status: active
last_verified: 2026-06-06
owner: opensip-cli
---

# ADR-0021: One source of truth for cross-tool CLI flags; `--verbose` is an output-currency concern

```yaml
id: ADR-0021
title: One source of truth for cross-tool CLI flags; verbose is an output-currency concern
date: 2026-06-06
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0016]
tags: [cli, ux, fitness, graph, simulation, architecture]
enforcement: mechanizable
enforcement-reason: >
  A new fitness check (`cross-tool-flag-parity`, checks-universal) asserts that
  every registered run command declares the mandatory common flags with the
  canonical description string, and that no tool re-declares a common flag with a
  hand-written literal instead of `applyCommonFlags`. The verbose-render parity
  (TTY == pipe) is covered by the CLI acceptance harness (a `--verbose` snapshot
  per tool, run through both `renderToInk` and `renderToText`).
```

**Decision:** The common CLI flags shared by every tool are declared **once**,
and `--verbose` (the per-tool detail body) is rendered **once** through the
shared output seam — never per-tool. Concretely:

1. **Flag specs live in `@opensip-cli/contracts`.** A `commonFlags` registry
   maps each shared flag key (`json`, `cwd`, `quiet`, `verbose`, `debug`,
   `reportTo`, `apiKey`, `open`) to its canonical `{ flags, description, default }`
   tuple, plus an `applyCommonFlags(command, keys[])` helper. Every tool builds
   its run command by calling `applyCommonFlags(...)` for the shared flags and
   adds only its genuinely tool-specific options by hand. The triplicated
   `JSON_FLAG`/`CWD_FLAG` (fitness), `OPT_CWD` (graph), and inline literals (sim)
   are deleted; `cli/commands/shared.ts`'s `JSON_DESC` is re-exported from
   contracts, not redefined.

2. **`--verbose` is part of the ADR-0011 output currency, not the live runner.**
   A tool's verbose "detail body" is carried as renderer-agnostic data on its
   `*DoneResult` (the model `graph` already uses with `reportLines`) and rendered
   by the shared `resultToView` seam, so it is **identical in a TTY and a pipe
   and across tools**. The per-tool Ink runners consume that same view-model;
   they no longer compute verbose output independently. The
   *"Use --verbose for detailed results"* footer becomes one shared `cli-ui`
   producer, shown when verbose is off and suppressed when on.

3. **Canonical cross-tool flag set is fixed.** Mandatory on every run command:
   `--json`, `--cwd`, `--quiet`/`-q`, `--verbose`/`-v`, `--debug`, `--help`,
   and (for tools that egress) `--report-to`/`--api-key`. `sim` gains
   `--verbose`; `graph` gains `--quiet`. Tool-specific flags (`--recipe`,
   `--gate-save`/`--gate-compare`, `--no-cache`, `--profile`, `--language`,
   `--config`, `--exclude`, `--out`, …) stay local. Fitness's overlapping
   `--findings` is folded into `--verbose` (with `--findings` kept as a
   documented alias for one release, then dropped per ADR-0012).

4. **`--help` is standardized at the bootstrap.** One shared `helpConfiguration`
   is applied to every mounted command (consistent option ordering — common
   flags grouped and ordered identically and last — consistent description
   casing, and a shared `addHelpText` footer pointing at the docs). The bare
   invocation keeps its `welcome.ts` behaviour.

**Alternatives:**

- *Flag registry in `@opensip-cli/core`.* Rejected: core is the kernel and
  declares no `commander` dependency; flag specs are a CLI-contract concern, and
  `contracts` already declares `commander` and is the documented Tool↔runner
  contract layer that every tool and the CLI sit above. Putting the registry in
  core forces a `commander` dependency down into the kernel.
- *A new dedicated `cli-flags` package.* Rejected as over-fragmentation — it
  would carry exactly one concern that `contracts` already owns and already has
  the dependency for. (Contrast ADR-0016, where the progress currency genuinely
  needed a *different* home — `cli-ui` — because it is renderer-bound; flags are
  parser-bound and belong with the other CLI-contract types.)
- *Keep `--verbose` in each tool's Ink runner (status quo).* Rejected: it has
  already produced divergence — `fit --verbose | cat` (CI/pipe) renders **no**
  detail because the static `resultToView('fit-done')` path ignores verbose,
  while a TTY shows the `FindingsBlock`; the *"Use --verbose…"* hint is
  hand-copied in three places (graph static, graph runner, fit runner) and
  absent from sim; `sim` has no verbose at all. A flag whose output depends on
  whether stdout is a TTY is a correctness bug, not a UX nicety.
- *Let `resultToView` re-derive verbose detail from `envelope.signals` at the
  CLI.* Rejected as the universal mechanism: it works for fit (findings are
  signals) but not for graph, whose detail body is catalog/entry-point data that
  is deliberately **not** in the envelope. The uniform contract is "the tool
  produces its detail body as data on the result; the seam renders it" — which
  fit satisfies by formatting its findings groups tool-side, exactly as graph
  formats `reportLines` tool-side. (cli must not import a tool; the detail must
  arrive as data.)
- *Document the convention without enforcing it.* Rejected: descriptions have
  *already* drifted with no registry (`--report-to` reads "POST **signals**…"
  in sim, "POST **findings**…" in graph, "POST findings **to a URL**…" in fit).
  Convention without a gate is how this repo got here; per the project's
  guardrail posture the parity is a live fitness check.

**Rationale:** This is the *input/flag* and *verbose-output* analogue of the
two currencies already established: ADR-0011 made the `SignalEnvelope` the one
output currency, ADR-0016 made `ProgressEvent` the one live-progress currency,
and both are rendered through a single shared seam. Flags and their verbose
detail were the remaining hand-maintained, per-tool surface — and the only one
where output silently depends on the TTY. Centralizing the spec kills the
already-observed description drift at the source; routing verbose through the
existing `resultToView` seam reuses the exact mechanism graph already proves
works in both media, so fit/sim inherit TTY==pipe parity for free. The registry
is pure data + one applier (tiny production surface), and the parity check makes
regression mechanically impossible rather than a review burden.

**Consequences:**

- New in `contracts`: `cli-flags.ts` (`commonFlags` registry +
  `applyCommonFlags`). `fitness`/`graph`/`simulation` `tool.ts` drop their local
  flag constants and call `applyCommonFlags`.
- `*DoneResult` contract gains a renderer-agnostic verbose **detail** carrier;
  `resultToView` renders it for every tool (graph's `reportLines` is folded into
  the shared shape). `fit-runner.tsx`/`sim-runner.tsx`/`graph-runner.tsx` consume
  the shared view-model instead of computing verbose locally.
- `sim` gains `--verbose` (per-scenario detail); `graph` gains `--quiet`; fit's
  `--findings` becomes a deprecated alias of `--verbose`.
- The *"Use --verbose for detailed results"* footer is a single `cli-ui`
  producer; the three hand-copied literals are deleted.
- One shared `helpConfiguration` is applied at the bootstrap that mounts tools;
  per-command option ordering becomes uniform.
- New fitness check `cross-tool-flag-parity` (checks-universal) enforces the
  mandatory set + canonical descriptions; the CLI acceptance harness gains a
  per-tool `--verbose` dual-media snapshot.
- A new tool inherits the full common-flag surface and verbose rendering by
  calling `applyCommonFlags` and populating the result's detail carrier — no
  bespoke flag wiring, no bespoke verbose renderer.

**Related specs / ADRs:** `docs/plans/specs/cross-tool-cli-flag-currency.md`
(local). Symmetric to ADR-0011 (output currency) and ADR-0016 (progress
currency); the three together make flags-in, progress, and output-out all
single-currency, single-seam.
