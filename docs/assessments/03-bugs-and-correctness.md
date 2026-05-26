# 03 — Bugs & correctness audit

**Cadence:** Quarterly, plus on-demand after major refactors.
**Mode:** `/loop` (autonomous; fixes-as-found until clean).
**Output:** `docs/plans/findings/yyyy-mm-dd-findings-<service-or-package-name>.md`
**Worktree per package:** `yyyy-mm-dd-findings-<service-or-package-name>`

---

## Prompt

/loop Perform a bug and correctness audit. Fix all issues discovered
working in a worktree named yyyy-mm-dd-findings-<service-or-package-name>.
Repeat until no issues remain then cancel the loop, commit your changes,
merge with main, and delete the worktree. Append any findings into
docs/plans/findings/yyyy-mm-dd-findings-<service-or-package-name>.md
Restart every 10 minutes. Perform this on the same set of packages.
