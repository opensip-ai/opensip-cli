# Golden render fixtures — capture record

These golden files are the pre-migration byte-identity baseline for the
**envelope-first-presentation** plan (RP-0 Task 0.5). For each representative
fit / sim / graph result (clean / findings / errored / verbose) they hold the
human-readable render output through both interpreters:

- `<case>.tty.txt` — the TTY path (`renderToInk` + `ink-testing-library`
  `lastFrame()`, raw frame).
- `<case>.pipe.txt` — the pipe/CI path (`renderToText`, ANSI-free).

## Capture provenance

- **Render path captured:** the pre-migration `fit-done` / `sim-done` /
  `graph-done` `CommandResult` render path (the `legacyResult` projection in
  `golden-fixtures.ts`).
- **Branch base SHA (`main`):** `1dfb7bbefdaf488c85527d9327aa6a51ea11cda6`
- **Capture commit (this worktree):** the RP-0 commit that adds these fixtures.
  RP-0 added only dead code (the `RunPresentation` type, the uncalled
  `presentationToView`, the dep-cruiser edge); it did NOT modify any existing
  `resultToView` case, so these goldens are byte-identical to what `main` renders.

## How they are used downstream

- **RP-1 (fit + sim):** the fit/sim cases are re-pointed to render the
  `presentation` projection (a `RunPresentation`) and MUST reproduce these exact
  bytes. Any diff is a regression to fix in RP-1, not an approved change.
- **RP-2 (graph):** DONE. graph's `graph-*` goldens were REGENERATED to the new
  envelope-backed output (graph now renders a `RunPresentation` through the same
  `presentationToView` → `envelopeToTableView` path fit/sim use). They are the
  NEW expected output, not the RP-0 baseline. The intentional deltas vs. the RP-0
  graph-done baseline (reviewers approve these — they are not regressions):

  1. **Headline summary**: the count-based `graph-done` verdict
     (`result.summary.errors === 0`) → the envelope verdict
     (`envelope.verdict.passed`) via the shared `viewRunSummary`.
  2. **Per-unit table ADDED**: graph's static output now includes the shared
     per-rule signal table (`Unit | Status | Errors | Warnings | Duration`),
     which the count-based `graphDoneView` never rendered.
  3. **Resolution caveat moved**: from a `graph-done` muted line to
     `RunPresentation.banners`, rendered as a muted line ABOVE the table. (The
     banner text is also the full production `resolutionBannerText` string — the
     RP-0 fixture used a truncated stand-in.)
  4. **NON-regression (NOT a delta)**: the summary `Duration` is the real
     host wall-clock (`1.2s` / `50ms`), NOT `0ms` — even though every graph unit
     carries `durationMs: 0`. `RunPresentation.durationMs` is threaded into
     `envelopeToTableView`'s `durationOverride` (RP-0 Task 0.4), winning over the
     unit-sum. Preserving the real duration is required behavior.

  The live final frame is brought into parity (same per-unit table) and pinned by
  `../graph-live-static-parity.test.tsx`.

## Regenerating

Only after an intentional, reviewed change:

```bash
UPDATE_GOLDENS=1 pnpm --filter=opensip-cli test golden-fixtures
```
