---
status: current
last_verified: 2026-06-07
release: v2.8.0
title: "Doc conventions"
audience: [contributors]
purpose: "Voice, frontmatter, diagrams, and verification trail conventions for the architecture doc set."
related-docs:
  - ../README.md
  - ./04-coding-standards.md
  - ./05-layer-policy.md
---
# Doc conventions

How the architecture docs are written and maintained. Read this if you're contributing a new doc, editing an existing one, or wondering what the "verification trail" line at the bottom is for.

---

## Voice

- **Second person, narrative.** "You'll see" / "you can grep for" / "your check will fire." Not "the user can" or "developers should."
- **Present tense for current behavior.** "The CLI walks the `ToolRegistry`" — not "the CLI will walk" or "the CLI walked."
- **Past tense for history.** "An earlier refactor moved `filterContent` out of `core`" — explicit about what's no longer the current shape.
- **Future tense, always labelled.** "Roadmap: a future tool may live at `kind: 'asm'`" — it's clear this isn't current behavior.
- **Assumes engineering fluency.** Don't re-explain `tsconfig`, `npm`, `glob pattern`, `ESM module`, or `JSON Lines`. Do explain opensip-tools-specific terms (Tool, Check, Recipe, Target) the first time they appear in a doc, with a link to [`../00-start/05-vocabulary.md`](/docs/opensip-tools/00-start/05-vocabulary/).
- **Prefer concrete over abstract.** "The fitness Tool's action handler in `tool.ts:118`" beats "the appropriate handler somewhere in fitness." Cite source files with line numbers when they help.

---

## Frontmatter

Every doc starts with YAML frontmatter:

```yaml
---
status: current               # current | draft | deprecated
last_verified: 2026-05-15     # ISO date — when the content was last verified against source
title: "Doc title"
audience: [contributors, plugin-authors, ci-integrators, users]
purpose: "One-line description of what this doc teaches."
source-files:
  - packages/foo/bar.ts       # the source files this doc references
related-docs:
  - ../00-start/05-vocabulary.md  # cross-links into the doc set
---
```

The fields:

| Field | Purpose |
|---|---|
| `status` | `current` for live docs, `draft` for in-progress, `deprecated` for retained-but-superseded docs. |
| `last_verified` | The date the content was checked against source. Older dates → likely-stale. |
| `title` | The doc's display title (also used in the README's reading-order list). |
| `audience` | Who this doc is for. The README's "How to read this" table cross-references this. |
| `purpose` | One-line elevator pitch. Shown in the README; should make a reader either click in or move on. |
| `source-files` | The source files the doc cites. Useful for spotting docs to re-verify after a source-file refactor. |
| `related-docs` | Cross-links into the rest of the doc set. Linear neighbors (next/previous in the reading order) plus topical neighbors. |

The frontmatter is part of the doc, not commentary on it. Treat it as load-bearing.

---

## Doc shape

Every doc follows a loose template:

```markdown
---
frontmatter
---
# Title

Lead paragraph: one to two sentences stating what this doc is.

> **What you'll understand after this:**
> - bullet
> - bullet
> - bullet

---

## Section 1
content
## Section 2
content

---

## Where the example lands

How the worked example (`acme-api`) interacts with this doc's topic.

## What's next

- `./NN-neighbor.md` — what the next doc covers.
```

The "What you'll understand after this" callout is the doc's promise to the reader. It's specific (not "you'll understand this topic better"); it's bulleted; it lives near the top. Three to five bullets is typical.

The "Where the example lands" section threads the worked example through the doc. Not every doc needs one — orientation and reference docs typically skip it. The runtime, fit-loop, and subsystem docs almost always have one.

The "What's next" section points to the linear neighbors plus the topical ones.

---

## Diagrams

ASCII boxes by default. They survive plain-text rendering, code review tools, and grep:

```
                ┌──────────────────────────────────────────────────┐
                │  3. Plugin load        core/plugins/discover.ts  │
                │                        fitness/plugins/          │
                └──────────────────────────────────────────────────┘
                            │
                            ▼
```

Mermaid where a real graph would help (large state machines, sequence diagrams across many actors). Use it sparingly — most explanations are clearer with a few ASCII boxes than a complex Mermaid graph.

No binary images unless unavoidable. They diff poorly, can't be searched, and break in many viewers. PNG screenshots of the dashboard are fine where the visual layout matters; everything else should be text.

---

## Cross-linking

Use Markdown links for prominent cross-links and inline code links for source-file references. Prefer real relative targets such as `[**Layer policy**](/docs/opensip-tools/80-implementation/05-layer-policy/)` or ``[`packages/core/src/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/core/src/index.ts)``.

Always link forward and back. A doc that depends on another doc's concept links to that doc; the linked-from doc, when relevant, links back to the dependent.

The link target uses absolute repository paths (`packages/core/src/index.ts`) rather than `~/.opensip-tools/...` paths or runtime paths.

---

## Source-file references

Cite source files with absolute repo paths, ideally with a line number when the line matters:

```markdown
[`packages/fitness/engine/src/gate.ts:243`](../../../packages/fitness/engine/src/gate.ts)
```

The relative-path link is what GitHub renders as a clickable file link. The line number in the link text is what helps the reader.

When you cite a source file, add it to `source-files:` in the frontmatter — that's how the doc's verification trail stays accurate.

---

## Verification trail

Most docs end with a "What's next" section. A few — especially the reference docs (`70-reference/`) — also have a "Verification trail" section:

```markdown
## Verification trail

Last verified at v2.8.0 against:

- `packages/` directory listing (30 packages …).
- Each package's `package.json` `description` and `name` field, read directly.
- The dep-cruiser config for layer rules.
```

This is the "what would I need to re-check to keep this doc current?" answer. When the next contributor updates the doc, they re-run the verification and bump the `last_verified` date.

---

## When to write a new doc

Most contributions don't need a new doc. The existing numbered docs (00–80) cover the architecture; new shape is rare.

You probably need a new doc if:

- You're adding a new subsystem (a third tool, a new layer, a deeply opt-in feature).
- An existing doc would balloon by 50%+ with the new content.
- The new content has its own coherent narrative arc.

You probably don't need a new doc if:

- The change is a new flag, a new field, or a new check pack.
- The change fits cleanly into an existing doc's scope.

Reference (70) and internals (80) docs are exceptions — those grow with the system, and a new entry typically slots in as a new section rather than a new doc.

---

## When to write a new section vs. a new doc

A doc is "small" if it's < 4 sections; "medium" if 4-8; "large" if > 8. A medium-to-large doc is harder to read; if you're adding a new section to one, ask whether the doc should split.

Splitting cost: another file, another README entry, another set of cross-links. Splitting benefit: each smaller doc reads in 5-10 minutes; readers can pin the link to the relevant slice.

Splitting is right when the new content has its own audience or its own reading order — see how the fit loop landed as four section-20 docs rather than one giant one.

---

## When to retire a doc

Mark it `status: deprecated` rather than deleting. The frontmatter `status: deprecated` shows up in the README under a "Deprecated docs" section (if present) so readers who land on a stale link aren't surprised.

Add a redirect note at the top:

```markdown
> **Deprecated.** This doc has been replaced by `../foo/bar.md`. Kept for historical context.
```

Delete only when no inbound link references the doc. The README's reading order is the source of truth for "active" docs.

---

## What's next

- **[`../README.md`](/docs/opensip-tools/)** — the doc set's table of contents.
- **[`04-coding-standards.md`](/docs/opensip-tools/80-implementation/04-coding-standards/)** — code conventions (the parallel to this doc, for source).
- **[`05-layer-policy.md`](/docs/opensip-tools/80-implementation/05-layer-policy/)** — the dep-cruiser rules.
