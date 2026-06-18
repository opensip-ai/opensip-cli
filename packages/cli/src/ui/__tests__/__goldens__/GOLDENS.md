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
- **RP-2 (graph):** graph's output is *intended* to change (unified onto the
  shared envelope table). The graph goldens here are the baseline RP-2 diffs
  against to enumerate every intentional delta — never an equality target.

## Regenerating

Only after an intentional, reviewed change:

```bash
UPDATE_GOLDENS=1 pnpm --filter=opensip-cli test golden-fixtures
```
