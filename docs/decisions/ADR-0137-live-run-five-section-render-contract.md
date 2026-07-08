---
status: active
last_verified: 2026-07-08
owner: opensip-cli
---

# ADR-0137: Live-run five-section render contract and additive done-body seams

```yaml
id: ADR-0137
title: Live-run five-section render contract and additive done-body seams
date: 2026-07-08
status: active
supersedes: []
superseded_by: null
related: [ADR-0058, ADR-0100, ADR-0102, ADR-0135]
tags: [cli, cli-ui, live-view, render, suite]
enforcement: mechanizable
enforced-by: ['shipped:live-view-through-cli-live']
enforcement-reason: >
  The contract is enforced by the type system: `LiveRunDoneData` (cli-ui) exposes
  ONLY the named section slots (`summary`, `summaryNote`, `verboseExtra`,
  `attention`, `table`, `verboseLines`/`verboseFindings`, `warnings`) — there is no
  full-replacement `body` slot for a tool to bypass the sections. The
  `live-view-through-cli-live` fitness check (ADR-0058) + dependency-cruiser keep
  tools rendering through the shell rather than importing `ink` directly.
```

**Decision:** Every run surface — a single tool (`fit`/`graph`/`sim`/`yagni`), a
suite, or a third-party tool — renders as the SAME five fixed, ordered sections
owned by the shared live-run shell (ADR-0058): **(1) banner, (2) header
(title + a `label: value` metadata band + optional description + separator),
(3) body (the live `LiveProgress` surface / static result block), (4) summary
(the canonical `RunSummary`: `{PASS|FAIL|FAULT} (E Errors, W Warnings) | Duration`),
(5) footer hints.** A tool populates these sections ONLY through the shell's named
slots. Tool-specific content rides through **additive** done-body seams that sit
*with* the standard sections, never replacing one:

- `LiveRunDoneData.summaryNote` — one line rendered directly under the §4
  `RunSummary`, on every surface (e.g. the suite's one-line `Review:` verdict).
- `LiveRunDoneData.verboseExtra` — verbose-only detail rendered above the summary
  (e.g. the suite's per-step + risk tables).

There is no full-replacement done-`body` slot.

**Alternatives:** (a) A full-replacement `LiveRunDoneData.body` that a tool fills
with a bespoke aggregate — this existed for the suite and is REJECTED: it re-drew
the header title (dup of §2), re-listed the steps (dup of §3), buried
scope/run-id in the frame, and used a non-standard summary line, so the suite was
the one surface that drifted from `fit`/`graph`. A full-body escape hatch invites
exactly the per-tool divergence ADR-0058 set out to remove. (b) Per-tool bespoke
done frames — rejected for the same ADR-0058 duplication reason. (c) Push the
suite's extra content into `--verbose` only — rejected: the review verdict is a
default-surface signal, so it needs a shown-always slot (`summaryNote`).

**Rationale:** ADR-0058 extracted the shell and its primitives (`Banner`,
`RunHeader`, `LiveProgress`, `RunSummary`) but did not forbid a tool from
replacing the assembled done frame. The suite took that escape hatch and drifted;
the fix is to make the shell's sections the *only* way to render, with additive
slots for the genuinely tool-specific bits. The §4 `RunSummary` is the single
verdict headline (ADR-0135's one 3-way outcome), so a suite's `PASS (0 Errors,
0 Warnings) | Duration` is byte-identical to `fit`'s. Because the slots live on the
shell, any `tool-*` or third-party tool gets the same frame — and the same two
extension points — for free.

**Consequences:** `LiveRunDoneData.body` is removed; `summaryNote` + `verboseExtra`
are added. The suite live view (`renderSuiteLive`) and the suite's pipe view
(`viewSuiteRun`) render the five sections in order: header title + `Steps: N`
metadata band + the suite's own description; the step checklist/result block as §3;
the canonical `RunSummary` + one-line `Review:` verdict as §4; scope, run id, and
the per-step/risk tables move to `--verbose`. `RunHeader` skips a blank
description, so a section-4 tool that has no description shows none (no empty
line). A new run surface that needs a note under its summary uses `summaryNote`;
one that needs extra verbose detail uses `verboseExtra`; neither may re-introduce a
full-frame replacement.

**Related specs / ADRs:** ADR-0058 (the shared live-run shell + `cli-live` this
contract governs), ADR-0100 (suite per-step + aggregate output that §3/§4 render),
ADR-0102 (the §1 banner / activity mark), ADR-0135 (the one 3-way run outcome the
§4 summary headline shows).
