# Assessments

Curated, reusable prompts for periodic codebase audits. Each file is a
self-contained prompt — copy it into a Claude Code session (or `/loop`
where the prompt opts in) to run that assessment against the repo.

## When to run

| Cadence | Run |
|---|---|
| Per minor release / quarterly | `01-architecture-audit` then `02-architecture-cross-cutting` |
| Quarterly                     | `03-bugs-and-correctness`, `04-performance`, `05-security`, `06-resiliency`, `07-observability` |
| Ad-hoc, after large refactors | Any subject-specific audit (`03`–`07`) against the changed packages |

## Workflow shape

Audits 03 through 07 are `/loop`-driven and self-contained — they create a
worktree per package, fix issues, append findings to
`docs/plans/findings/yyyy-mm-dd-findings-<package>.md`, merge with main, and
delete the worktree. They run unattended until no issues remain.

Audit 01 produces per-package architecture reports under
`docs/plans/architecture/`. Audit 02 reads those reports and synthesises
cross-cutting recommendations across packages.

## How to extend

When adding a new assessment:

1. Pick the next `NN-` prefix.
2. Keep the prompt short and concrete — what to read, what to write, where
   the output goes, what counts as a finding.
3. Specify the output path so subsequent assessments can ingest the report.
4. Reference (don't duplicate) the layered architecture rules in
   `CLAUDE.md` and the existing fit/depcruise gates — these prompts cover
   the human-judgment audits that fit checks can't.

## Relation to fit checks

Anything that can be expressed as a per-PR gate should become an
`@opensip-tools/checks-*` entry, not an assessment prompt. Assessments are
for things that require human judgment (Is this abstraction earning its
weight? Is this layering still coherent?) or cross-cutting analysis
(Pattern usage across services).

The dogfood loop: when an assessment surfaces the same kind of finding
repeatedly across audits, that's a candidate for promotion to a check.
