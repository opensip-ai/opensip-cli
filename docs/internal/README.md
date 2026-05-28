# docs/internal/ — charter

This directory holds documentation that is **open-source-visible but not website-published**. Anyone with a GitHub link can read it; nothing here ships to opensip.ai/docs/opensip-tools/.

That distinction matters because the website is the curated story we tell external readers. Internal docs are operational color for people who clone the repo: cross-repo consumer relationships, decision logs, contributor-only context.

## What belongs here

- **`consumers/`** — known downstream consumers of opensip-tools, what they depend on, what contract they expect us to honor, and any operational nits relevant to releases. Naming a specific consumer is load-bearing — that's why these docs aren't public.
- **`decisions/`** — architectural decision records (ADRs / DECs). One file per decision. Decisions live forever; superseded ones get marked Status: Superseded rather than deleted.
- **Operational notes** — runbooks, incident postmortems, contributor-only conventions that don't make sense out of context.

## What does NOT belong here

- **Anything user-facing** — quick-start, API surfaces, configuration reference. That goes in `docs/public/`.
- **Anything reader-friendly without context** — if a stranger to the project would learn something from it, it's probably public.
- **Implementation plans for pending work** — those go in `docs/plans/`. Internal decisions record what was *decided*; plans describe what *will be done*.
- **Generated output** — nothing in here is auto-generated. If a tool produces it, the tool puts it elsewhere.

## Boundary rule of thumb

> If you can write the fact about opensip-tools without naming a specific consumer (or other private context), it goes in `docs/public/`. If naming a specific consumer is load-bearing, it goes in `docs/internal/`.

Example: "The `@opensip-tools/cli` package exposes a `bin` entry intended to be spawn-invocable from other Node processes" — public. "opensip spawns it for catalog export, so changes to the catalog JSON shape are a breaking change for them" — internal.

## Relationship to other doc trees

```
docs/
├── public/          ← hand-edited, ships to website
├── internal/        ← hand-edited, this directory (repo-only)
├── plans/           ← hand-edited work queue
└── web-generated/   ← auto-generated from public/; do not edit
```

When updating an internal doc, ask: would this be more useful in `public/`? In `plans/`? If yes, move it. `internal/` is the catch-all only for things that genuinely don't fit either.

## Frontmatter convention

Internal docs use lightweight frontmatter — no website manifest cares about them, so the requirements are loose:

```markdown
---
status: current | superseded | draft
last_verified: YYYY-MM-DD
---
```

`decisions/` files additionally carry `decision_date`, `supersedes`, `superseded_by` as applicable.
