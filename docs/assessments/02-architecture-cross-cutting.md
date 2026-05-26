# 02 — Architecture cross-cutting recommendations

**Cadence:** Run immediately after audit 01 covers every package in scope.
**Mode:** Single-pass. Reads the prior reports + the codebase, writes one synthesis report.
**Prerequisite:** Per-package files must exist under `docs/plans/architecture/yyyy-mm-dd-architecture-*.md`.
**Output:** `docs/plans/architecture/yyyy-mm-dd-architecture-cross-cutting-recommendations.md`

---

## Prompt

Read the software architecture patterns audit files in
`docs/plans/architecture`. Each file was scoped to a particular
service/package. I want you to look for cross-cutting concerns within
those documents and then verify your findings by reviewing the codebase.
Write a report with recommendations in a file called
`docs/plans/architecture/yyyy-mm-dd-architecture-cross-cutting-recommendations.md`.
