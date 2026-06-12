---
status: current
last_verified: 2026-06-07
release: v3.0.0
title: "CLI output rendering"
audience: [contributors]
purpose: "How every command's human-readable output is defined once and rendered two ways — Ink for a TTY, plain text for pipes/CI — so the two cannot drift."
source-files:
  - packages/cli-ui/src/view-model.ts
  - packages/cli-ui/src/render-to-ink.tsx
  - packages/cli-ui/src/render-to-text.ts
  - packages/cli/src/ui/result-to-view.ts
  - packages/cli/src/bootstrap/render.ts
related-docs:
  - ./02-tool-plugin-model.md
  - ./04-contract-surfaces.md
---
# CLI output rendering

A command's output has to look good in an interactive terminal *and* read
cleanly when piped to a file, a CI log, or `| grep`. The naive way to get
both is to write the interactive version in Ink and hand-maintain a
plain-text copy beside it — and then the two drift the moment someone edits
one and forgets the other.

opensip-cli avoids that by defining each command's output **once** and
rendering it **twice**.

> **What you'll understand after this:**
> - The view-model that decouples *what* to show from *how* to render it.
> - The two interpreters and the single seam that chooses between them.
> - Why the interactive and piped forms cannot structurally diverge.

## One view-model, two interpreters

Every command result is expressed as a renderer-agnostic **view-model** — a
small, line-oriented tree of `ViewNode`s (`line`, `heading`, `table`,
`hints`, `group`, …) whose inline spans carry a *semantic* `Tone`
(`success`/`error`/`warning`/`brand`/…), never a raw color. This vocabulary
lives in `@opensip-cli/cli-ui` (`view-model.ts`) and depends on nothing.

Two interpreters consume that same tree:

- **`renderToInk`** (TTY) maps each `Tone` onto a `DEFAULT_THEME` token and
  returns an Ink element — colored, bold, dimmed.
- **`renderToText`** (pipe / CI / redirect) drops tone entirely and returns
  a plain string with **zero ANSI** — stronger than `NO_COLOR`, which only
  zeroes colors.

Because both interpreters read the *same* node, the interactive and
non-interactive forms cannot drift: there is no second definition to fall
out of sync. A test suite renders representative results through both and
asserts the content matches.

## The mapping and the seam

`@opensip-cli/cli` owns the `CommandResult → ViewNode` mapping
(`resultToView`) — it is *total*, with one view per result variant. The
single render seam (`renderResult` in `bootstrap/render.ts`) is the only
place that chooses the medium:

```
stdout is a TTY?  ──yes──▶  Ink  (banner + project line + renderToInk(view))
        │
        └──no──────────▶  plain text  (project line + renderToText(view), no banner)
```

Tools never make this choice. A tool computes a `CommandResult` and calls
`cli.render(result)`; the seam decides Ink vs. plain text from
`process.stdout.isTTY`. The ASCII banner is suppressed when piped (clean
logs); the `ℹ Project:` discovery line is kept (CI should still record which
root was analyzed).

### The cli-ui boundary (load-bearing)

`@opensip-cli/cli-ui` must stay generic: it ships the view-model and the
two interpreters but **never imports `@opensip-cli/contracts`**. The
knowledge of *which* result maps to *which* nodes lives in `cli`, above
contracts in the layer graph. dependency-cruiser enforces this — it keeps
the UI kit reusable and prevents the result types from leaking into the
presentation primitives.

## What is not in scope

- **`--json`** is a separate machine contract (the `SignalEnvelope`,
  `schemaVersion: 2`) with its own `emitEnvelope` seam (the shared
  `formatSignalJson` formatter at the composition root, ADR-0011); it does
  not go through the view-model. See [Contract surfaces](./04-contract-surfaces.md).
- **Live progress views** (the animated `fit`, `graph`, and `sim` runners) are
  inherently TTY-only and render directly with cli-ui primitives. All three
  share one renderer — `<LiveProgress>` (ADR-0016), driven by a universal
  `ProgressEvent` stream in two modes: a *phases* checklist (graph's fixed
  pipeline stages) and a *pool* spinner + `completed/total` counter (fit's
  checks, sim's scenarios). `graph` keeps its spinner animating during its
  heavy `resolve` stage by yielding to the event loop cooperatively, so it stays
  in-process and host-agnostic. A non-TTY run falls back to the static,
  dual-rendered result. Expressing a live view's final frame through the
  view-model is tracked future work.
