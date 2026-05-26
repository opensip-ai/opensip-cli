# 07 — Observability / OTel / metrics / pyroscope audit

**Cadence:** Quarterly, plus before any release that adds new code paths users will ask about ("why is X slow / why did Y fail").
**Mode:** `/loop` (autonomous; fixes-as-found until clean).
**Output:** `docs/plans/findings/yyyy-mm-dd-findings-<service-or-package-name>.md`
**Worktree per package:** `yyyy-mm-dd-findings-<service-or-package-name>`

---

## Prompt

/loop Perform an observability, OTel, metrics, and pyroscope audit. Fix
all issues discovered working in a worktree named
yyyy-mm-dd-findings-<service-or-package-name>. Repeat until no issues
remain then cancel the loop, commit your changes, merge with main, and
delete the worktree. Append any findings into
docs/plans/findings/yyyy-mm-dd-findings-<service-or-package-name>.md
Restart every 10 minutes. Perform this on the same set of packages.
