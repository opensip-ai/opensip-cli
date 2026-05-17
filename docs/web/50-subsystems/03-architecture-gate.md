---
status: current
last_verified: 2026-05-15
title: "Architecture gate"
audience: [contributors, ci-integrators]
purpose: "The baseline-and-compare workflow. Identity hash, line-shift invariance, partial-SARIF tolerance, CI integration patterns."
source-files:
  - packages/fitness/engine/src/gate.ts
  - packages/fitness/engine/src/sarif.ts
  - packages/fitness/engine/src/__tests__/gate.test.ts
  - packages/fitness/engine/src/cli/fit.ts
related-docs:
  - ../20-the-fit-loop/03-ignore-directives.md
  - ../20-the-fit-loop/04-output-gate-sarif.md
  - ../40-runtime/03-session-and-persistence.md
---
# Architecture gate

The gate is opensip-tools' answer to "we have legacy violations and we need to ship a regression detector before we can clean them up." Save a baseline today, compare next week, fail CI if anything new appeared. Ignore directives are too granular for hundreds of legacy sites; the gate handles the volume.

> **What you'll understand after this:**
> - The two-mode flow: `--gate-save` and `--gate-compare`.
> - The identity hash and why line numbers are excluded.
> - How partial-SARIF tolerance lets users hand-edit baselines.
> - The CI patterns that make the gate useful in practice.

---

## The two modes

```bash
opensip-tools fit --gate-save                # capture today's reality
opensip-tools fit --gate-compare              # CI gate from now on
opensip-tools fit --gate-compare --baseline path     # custom location
```

`--gate-save` runs the configured recipe, then writes the resulting findings as a SARIF document to the baseline path. The default path is `<project>/opensip-tools/.runtime/baseline.sarif` ([`packages/fitness/engine/src/gate.ts:89`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/fitness/engine/src/gate.ts)). Override with `--baseline <path>`.

`--gate-compare` runs the same recipe, parses the saved baseline, computes the diff, and prints a structured report:

```
opensip-tools gate compare

Added (1):
  ✗ no-console-log                          services/api/src/routes/payments.ts:88
      console.log is forbidden in production

Resolved (3):
  ✓ no-todos                                services/api/src/lib/parser.ts
  ✓ complex-function                        services/api/src/legacy/auth.ts
  ✓ file-length-limit                       services/api/src/util/big.ts

Unchanged (29):
  · ... and 24 more

✗ DEGRADED — 1 new violation
```

Exit code 1 if `degraded` (any added findings); 0 otherwise. CI gates on the exit code; humans read the diff.

The flags are mutually exclusive — passing both raises a configuration error.

---

## The identity hash

Two findings are "the same finding" iff `(filePath, ruleId, message)` matches exactly. The hash:

```ts
function hashViolation(filePath: string, ruleId: string, message: string): string {
  return createHash('sha256').update(`${filePath}\n${ruleId}\n${message}`).digest('hex');
}
```

[`packages/fitness/engine/src/gate.ts:243`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/fitness/engine/src/gate.ts).

Three things stay in the hash:

- **`filePath`** — moving a file is a change. A finding at `src/a.ts` is different from a finding at `src/b.ts`.
- **`ruleId`** — different rules produce different signal types. `fit:no-console-log` and `fit:no-debugger` are different findings even at the same line.
- **`message`** — the violation's specific text. A complexity check that reports `cc=22` is different from one reporting `cc=28` at the same site, because the *content of the violation changed* — that's a real signal worth surfacing as added/resolved.

One thing is **deliberately excluded**: the line number. A regex check that flags `console.log` at line 42 today and the same `console.log` at line 50 next week (because lines were inserted above it) is the *same* violation. Including the line in the hash would produce false positives — an "added" finding (line 50) and a "resolved" finding (line 42) for what's really one unchanged issue.

The trade-off is symmetric: if a *different* `console.log` is added at the same file with the exact same message, the hash collides and we treat it as unchanged. In practice this hasn't been a problem — messages are usually specific enough that two distinct violations have different messages, and a duplicate-message-same-file pair is rare and benign.

The line-shift invariance is exercised by [`packages/fitness/engine/src/__tests__/gate.test.ts:222`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/fitness/engine/src/__tests__/gate.test.ts) with explicit cases for the moved-line scenario and the changed-message scenario.

---

## What `compareToBaseline` actually does

[`packages/fitness/engine/src/gate.ts:127`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/fitness/engine/src/gate.ts):

```ts
export function compareToBaseline(output: CliOutput, baselinePath: string): GateCompareResult {
  // 1. Throw GateBaselineMissingError if baselinePath doesn't exist.
  // 2. Read + parse the SARIF document. Throw GateBaselineInvalidError on bad input.
  // 3. Extract baseline violations from SARIF runs[].results[].
  // 4. Extract current violations from output.checks[].findings[].
  // 5. Hash both lists into Maps keyed by hash.
  // 6. Diff:
  //      added       = current.keys() - baseline.keys()
  //      resolved    = baseline.keys() - current.keys()
  //      unchanged   = current.keys() ∩ baseline.keys()
  // 7. Return { baselinePath, added, resolved, unchanged, degraded: added.length > 0 }
}
```

The diff is set arithmetic on hash-keyed collections. No fuzzy matching, no near-miss heuristic — the hashes match or they don't. This makes the gate's behavior easy to reason about: a one-line change to the message of a check makes every finding from that check appear as both added and resolved.

The `degraded` flag is `added.length > 0`. A run can resolve violations *and* add new ones, in which case it's still degraded — adding is the gate. Resolved counts are informational; they never cause the gate to fail.

---

## Partial-SARIF tolerance

The reader is forgiving. From [`packages/fitness/engine/src/gate.ts:287`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.9/packages/fitness/engine/src/gate.ts) (`extractViolationsFromSarif`):

- A run with no `results` array → skipped silently. (Maybe the user removed all findings from a run; that's not a parse error.)
- A run with `results` but missing `tool.driver` → still parsed, the result entries become violations.
- A result with no `locations` (a "global" finding without a file) → parsed with `filePath = ''`. The hash still works.
- A result with `region.startLine = 0` or missing → no line in the violation; the hash is unaffected because line numbers aren't in the hash anyway.

The `extractViolationsFromSarif` code path also tolerates extra fields the SARIF parser might inject (extensions, properties bags, etc.). It reads the four fields it needs and ignores the rest.

This permissiveness exists because **users sometimes hand-edit baselines.** A team might:

- Delete an entry from `runs[].results[]` because the violation has been intentionally fixed and they want the next compare to be clean.
- Add an entry by copy-pasting a result block to grandfather a violation they know about but can't fix yet.
- Bulk-replace a file path because they renamed a directory.

These edits are first-class operations. The gate parser refuses corrupt JSON or missing top-level fields (`runs` is required), but it doesn't enforce SARIF-spec strictness on individual results. The gate is for the team's workflow, not for SARIF-spec compliance.

---

## Where the gate lives in the lifecycle

```
opensip-tools fit --gate-compare
  → fitnessTool.action(opts)
       → if (opts.gateSave || opts.gateCompare) { runGateMode(args, cli); return; }
            → runGateMode:
                 → executeFit(args)              ← same fit run, no special path
                 → if save: saveBaseline(output, baselinePath)
                 → else:    compareToBaseline(output, baselinePath)
                            renderGateCompareOutput(result)
                            cli.setExitCode(result.degraded ? 1 : 0)
```

The gate is a post-processing layer on top of the standard `executeFit()` run. It doesn't change which checks ran, which targets were resolved, or how filtering applied. It just takes the same `CliOutput` the renderer would have shown and runs the diff.

This is why ignore directives are compatible with the gate: a directive suppresses a violation *before* the violation enters `CliOutput`, so the baseline doesn't see it and the compare doesn't see it. A new directive added today removes a finding from the current run; the gate reports it as resolved (since it was in the baseline). A directive removed today re-introduces a finding; the gate reports it as added.

---

## CI integration patterns

Three shapes that work in practice:

### Pattern 1 — committed baseline, branch comparison

The team commits `<project>/opensip-tools/baseline.sarif` to git. PRs fail if they introduce a regression vs. main's baseline.

```yaml
# .github/workflows/ci.yml
- run: opensip-tools fit --gate-compare --baseline opensip-tools/baseline.sarif
```

After a tech-debt sprint that resolves violations, regenerate the baseline and commit it:

```bash
opensip-tools fit --gate-save --baseline opensip-tools/baseline.sarif
git add opensip-tools/baseline.sarif
git commit -m "chore: regenerate baseline after debt cleanup"
```

This is the strict shape — every PR must not regress, but the baseline can shrink in dedicated commits.

### Pattern 2 — branch-comparison with rolling baseline

CI saves a baseline on every main-branch run; PRs compare against the most recent main baseline (cached as a CI artifact, fetched at the start of each PR run).

```yaml
on:
  pull_request:
jobs:
  fit:
    steps:
      - run: download-main-baseline opensip-tools/baseline.sarif
      - run: opensip-tools fit --gate-compare --baseline opensip-tools/baseline.sarif
```

Less strict — PRs are graded against a moving target, but the moving target only goes down (since main never adds violations, by construction).

### Pattern 3 — local-only baseline

The baseline lives in `.runtime/` (gitignored). Each developer's machine has a different baseline, regenerated as they work on long-lived branches. CI doesn't gate at all — `--gate-compare` is purely a local affordance.

This is the loosest shape. Useful for early adoption, where the team isn't yet ready to enforce the gate in CI but wants the regression-detection workflow as a personal tool.

---

## When *not* to use the gate

A few patterns the gate isn't a fit for:

- **Brand-new project, zero violations.** Just enable the checks. Don't grandfather what doesn't exist.
- **Single check, single violation.** An ignore directive is more granular and more documentable than a baseline entry for one site.
- **Teams without a coverage culture.** The gate trusts the team to actually fix grandfathered violations eventually. Without that follow-through, the baseline grows monotonically and the gate becomes a rubber stamp.
- **Cross-project baselines.** Each baseline is project-scoped (the file paths are project-relative). A monorepo-wide baseline works only if every project's `cwd` is the monorepo root.

---

## Where the example lands

For `acme-api`:

- They committed `<project>/opensip-tools/baseline.sarif` to git on day one when they had 142 pre-existing violations across the universal/typescript/python check packs.
- CI's PR job runs `opensip-tools fit --gate-compare --baseline opensip-tools/baseline.sarif`.
- A PR that introduces one new `console.log` produces an `Added (1)` line and exits 1. The PR fails until the `console.log` is removed (or marked with `// @fitness-ignore-next-line no-console-log`).
- A PR that resolves four violations produces `Resolved (4)` and exits 0. The team merges.
- Periodically, after debt-cleanup PRs land, an engineer runs `opensip-tools fit --gate-save --baseline opensip-tools/baseline.sarif` locally to regenerate the baseline. The baseline shrinks. The PR shrinking the baseline is reviewed; the new baseline is committed.

Today's count: 78 violations in the baseline. The 64-violation gap from day one's 142 is nine months of gradual improvement, gated all the way.

---

## What's next

- **[`../60-surfaces/01-cli-command-tree.md`](/docs/opensip-tools/60-surfaces/01-cli-command-tree/)** — every gate flag in the lookup-shaped reference.
- **[`../20-the-fit-loop/04-output-gate-sarif.md`](/docs/opensip-tools/20-the-fit-loop/04-output-gate-sarif/)** — the wider context of fit output paths the gate fits into.
- **[`../20-the-fit-loop/03-ignore-directives.md`](/docs/opensip-tools/20-the-fit-loop/03-ignore-directives/)** — when to use directives vs. baselining.
