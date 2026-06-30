---
status: active
last_verified: 2026-06-30
owner: opensip-cli
---

# ADR-0102: Coffee cup canonical logo and live activity mark

```yaml
id: ADR-0102
title: Coffee cup canonical logo and live activity mark
date: 2026-06-30
status: active
supersedes: []
superseded_by: null
related: [ADR-0058, ADR-0072]
tags: [brand, cli-ui, banner, live-view]
enforcement: not-mechanizable
enforcement-reason: >
  This is a brand and UX direction. It is enforced through cli-ui ownership,
  review, docs, and tests around the shared live-run shell rather than a source
  invariant that a fitness check can reliably prove.
```

**Decision:** The OpenSIP coffee cup is the canonical OpenSIP CLI logo mark. The
legacy large/medium/small OPENSIP wordmark banners are removed from the
user-facing banner surface. The `mini` identity card is the stable banner model:
plain coffee cup mark plus product/version/tagline/URL/project context.

Animated personality belongs in the live-run body, not in the static identity
banner. When a command is actively running, `cli-ui` may render a fixed-width
left activity column containing a smaller coffee cup animation while the right
column remains the tool-defined live surface. The first animation direction is
steam-only motion over the same cup body, preserving the mark:

```text
Frame 1    Frame 2    Frame 3
  ⋮ ⋮      ⋮   ⋮        ⋮
 ▟███▙     ▟███▙      ▟███▙
 ▐███▌     ▐███▌      ▐███▌
  ▀▀▀       ▀▀▀        ▀▀▀
```

The cup animation may have `sm`, `md`, and `lg` sprite sizes so the shared
live-run shell can choose an appropriate scale for terminal width and command
surface. Size selection should be host/shared-shell owned, not a per-tool art
choice.

**Alternatives:**

- **Keep OPENSIP wordmark banners as equal first-class choices.** Rejected. The
  product brand has converged on the coffee cup mark; carrying multiple banner
  identities creates maintenance and documentation drag without a current user
  need.
- **Animate the existing static banner.** Rejected. The live shell deliberately
  renders the banner once through Ink `<Static>` to avoid duplicate-banner and
  frame-height bugs. Motion belongs in the dynamic live-run body.
- **Make the cup mascot with eyes/body the default running indicator.** Rejected
  for the first pass. It is promising as a later expressive mode, but steam
  animation is the cleaner default because it keeps the brand mark intact.
- **Let each tool define its own cup animation.** Rejected. Tool-specific art
  would drift. The shared shell owns the activity mark; tools keep owning the
  right-side progress/content surface.

**Rationale:** The current `mini` banner already made the coffee cup the most
recognizable mark in the CLI. Treating the cup as the canonical logo simplifies
the brand system and gives the live UI a single object to animate. Steam motion
adds life during long-running checks without changing the logo into a mascot or
making warning/error states feel unserious.

The left-column activity mark also fits the existing `@opensip-cli/cli-ui` and
`@opensip-cli/cli-live` split: the shell owns chrome and progress affordances;
tools define the substantive run content. That preserves one shared visual
language across `fit`, `graph`, `sim`, `yagni`, and future tools.

**Consequences:**

- New banner or live-run UI work should use the coffee cup mark as the canonical
  identity. Do not add new OPENSIP wordmark banner variants.
- The `lg` / `md` / `sm` wordmark banner choices are removed from `ui.banner`,
  documentation, and tests. Stale values normalize to the coffee-cup banner at
  render time and are rejected by the config schema.
- The static `mini` banner should remain non-animated and should continue to
  respect `--quiet`, non-TTY, `--json`, and `NO_COLOR` behavior.
- The animated activity cup must use fixed-width/fixed-height frames so the
  right-side live content does not shift.
- The activity cup should be suppressed in quiet, JSON, non-TTY, and narrow
  terminal modes.
- The live-run shell must not add a second Ink `<Static>` surface for the
  animated cup; it belongs in the existing dynamic frame.
- Expressive faces, stick bodies, dancing, and success poses remain backlog
  explorations, not the default activity indicator.

**Related specs / ADRs:** Builds on [ADR-0058](ADR-0058-shared-live-run-shell.md)
(shared live-run shell). Compatible with [ADR-0072](ADR-0072-i18n-posture.md)
because the activity mark is non-textual chrome.

**Fitness check:** No check warranted. This is a brand/UX posture, and the most
important invariants are visual review items: fixed frame dimensions, shell-owned
rendering, and preserving quiet/non-TTY/JSON behavior.
