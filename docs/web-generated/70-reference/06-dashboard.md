---
status: current
last_verified: 2026-05-26
release: v2.0.x
title: "Dashboard"
audience: [users, contributors]
purpose: "The HTML report — what it shows, when it opens, how it's generated, and where it lives."
source-files:
  - packages/dashboard/src/generator.ts
  - packages/dashboard/src/index.ts
  - packages/dashboard/src/overview.ts
  - packages/dashboard/src/checks.ts
  - packages/dashboard/src/sessions.ts
  - packages/dashboard/src/code-paths.ts
  - packages/dashboard/src/code-paths/
  - packages/cli/src/open-dashboard.ts
  - packages/fitness/engine/src/cli/dashboard.ts
related-docs:
  - ../80-implementation/03-session-and-persistence.md
  - ./01-cli-commands.md
  - ../40-graph/01-stages-and-catalog.md
---
# Dashboard

The dashboard is a self-contained HTML report of every fit and sim run on the local machine. No server, no database, no asset hosting — a single directory you can email or commit, fully functional offline.

> **What you'll understand after this:**
> - When the dashboard opens automatically vs. manually.
> - What the HTML report contains (the four panels).
> - How the static HTML is generated and how data flows in.
> - Where the dashboard's source lives.

---

## When it opens

Two triggers, both opt-in:

1. **`--open` flag.** `opensip-tools fit --open` (or `sim --open`) runs the recipe, then launches the dashboard if conditions allow.
2. **Explicit `dashboard` command.** `opensip-tools dashboard` opens the most recent run's report regardless of any pending fit run.

The launcher's `decideOpen` ([`packages/cli/src/open-dashboard.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/cli/src/open-dashboard.ts)) returns `shouldOpen: true` only when **all** of these hold:

- The user requested it (`--open` was passed).
- Output isn't `--json` (machine-readable runs don't open browsers).
- Stdout is a TTY (pipeline / log redirect — don't open).
- The `CI` environment variable is unset (GitHub Actions, GitLab CI, CircleCI, etc. — never open).
- Not an SSH session without a display (`SSH_CONNECTION`/`SSH_CLIENT` set without `DISPLAY`/`WAYLAND_DISPLAY`).

The HTML file is always written. If any guard skips the browser launch, the user can navigate to it manually.

---

## What it shows

Four top-level tabs (`Overview`, `Fitness`, `Simulation`, `Code Paths`). The Fitness and Simulation tabs each carry three subtabs (`Overview`, `Catalog`, `Recipes`) — the per-tool `Overview` subtab shows that tool's session list. Every panel module lives under [`packages/dashboard/src/`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/); the top-of-page tool-tab switcher is wired by [`tool-tabs.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/tool-tabs.ts).

### Overview

The default landing panel. Shows:

- The most recent run's pass/fail summary, score, and timing.
- A trend graph of scores over the last N runs.
- The breakdown by category (security, quality, architecture, etc.).
- Quick links into the other panels.

Source: [`packages/dashboard/src/overview.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/overview.ts).

### Sessions list (per-tool Overview subtab)

A list of every past run, sorted reverse-chronological. Click into one to see its full detail — every check that ran, every finding, every directive applied, every check that was skipped or errored.

Per-run detail expands into a tree: check → file → finding. Each finding shows the rule id, severity, line, and (when present) the suggestion text.

Source: [`packages/dashboard/src/sessions.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/sessions.ts). Rendered inside each per-tool tab's Overview subtab; the tab switcher is in [`tool-tabs.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/tool-tabs.ts).

### Catalog (per-tool Catalog subtab)

Every check that was registered for the current project, with per-check stats:

- How many runs it's been included in.
- How often it passed vs. failed.
- The most recent run that included it.

Filterable by tag, by source pack, by pass-rate. Useful for spotting the noisiest checks (high failure rate) and the dormant ones (haven't run in weeks — maybe a recipe drift).

Source: [`packages/dashboard/src/checks.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/checks.ts).

### Recipes (per-tool Recipes subtab)

The configured recipes, with per-recipe stats. Same shape as the catalog but a level up: how often each recipe has run, its pass rate, its average duration.

Source: [`packages/dashboard/src/recipes.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/recipes.ts).

### Code Paths panel

The Code Paths panel is the dashboard's interactive call-graph explorer. It's powered by the catalog produced by `opensip-tools graph` and surfaces seven curated views, each answering a real developer question with a clear next step. The pipeline that builds the underlying catalog is documented in [`40-graph/01-stages-and-catalog.md`](/docs/opensip-tools/40-graph/01-stages-and-catalog/).

The panel is language-agnostic — it consumes the generic v3 `Catalog` shape and works against TypeScript, Python, Rust, Go, and Java catalogs alike. Per-edge `confidence` is carried on `GraphCallEdge` and is available to views; today it's read but not surfaced as a UI badge, so reachability views on tree-sitter catalogs will look the same as TypeScript ones even though the underlying edges are lower-fidelity. See the per-rule fidelity table in [`02-rules-and-gating.md`](/docs/opensip-tools/40-graph/02-rules-and-gating/) for what this means in practice.

The seven views (each with the same row-click → universal Function Card flow). The non-Search views are paginated at 10 rows per page rather than capped — every function in the catalog (after filter chips apply) is reachable by paging through the table:

- **Hot functions** — sorted by inbound caller count. "Who depends on `logger`?"
- **Big functions** — sorted by `endLine - line`. "What should I split during this refactor?"
- **Wide functions** — sorted by `params.length`, with a parameter thumbnail. "Where would a config-object refactor pay off?"
- **Coupling heat map** — N×N package-by-package call density matrix; click a cell for the actual call sites. "Is `core` really the bottom layer?"
- **Untested production code** — production functions with no static caller from any test file, sorted by inbound count. "What's the highest-risk gap?"
- **Cycles / SCCs** — Tarjan's SCC over the call graph, every component of size ≥ 2. "Where's the tightest knot?"
- **Search** — fuzzy match over `simpleName`, bound to the persistent search input at the top of the panel.

The **Universal Function Card** is the cross-cutting drill-down: every clickable function name in any view opens the same overlay with name + location, body length, kind, params, return type, callers grouped by package, callees (resolved + external), an "Open in editor" deep link (`vscode://` or `cursor://` — opt in via `dashboard.editor` in [`opensip-tools.config.yml`](/docs/opensip-tools/70-reference/03-configuration/); falls back to "Copy path" when unset), and a "Trace from entry" BFS.

Filter chips above the view tabs apply to every view: package multi-select, kind multi-select, and a production/test toggle (default: production-only).

Source: [`packages/dashboard/src/code-paths.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/code-paths.ts) and the per-view files under [`packages/dashboard/src/code-paths/`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/code-paths/).

### Tool tabs

The dashboard supports both fit and sim runs. The top-of-page tab switcher (Overview / Fitness / Simulation / Code Paths) filters the panels by tool. Sim runs are sparser today; the panel shapes are the same. Source: [`tool-tabs.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/tool-tabs.ts).

---

## How it's generated

Static HTML. The generator ([`packages/dashboard/src/generator.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/generator.ts)) assembles:

1. The base HTML scaffold (head, body shell, the panel containers).
2. The CSS, inlined via `<style>` (from [`css.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/css.ts)).
3. Session and catalog data (checks, recipes), inlined directly into the panel `<script type="module">` blocks as `const sessions = …` / `const catalog = …` literals — there's no separate `<script type="application/json">` for these.
4. The graph catalog (v0.3 Code Paths panel) when present, embedded as `<script type="application/json" id="graph-catalog">…</script>` and consumed by the Code Paths panel JS at init time. This one *does* use the `application/json` idiom because it's loaded across module boundaries.
5. The JS panels, inlined via `<script type="module">…</script>` (from each panel's `dashboard*Js()` function).

The output is one self-contained `latest.html`. No CDN, no external script tags, no fetch calls, no asset directory. You can save the file and open it in three weeks on a plane.

Why static, no server? A few reasons:

- **Audit trail.** A static HTML you can email or commit is reviewable. A live dashboard that fetches from a backend is not.
- **No port conflicts.** Static files don't ask for `localhost:3000`.
- **No moving parts.** No daemon to crash, no cache to stale, no auth to misconfigure.

The cost: dynamic features (filtering, sorting, expand-collapse) are JS in the browser, against the embedded JSON. That works fine up to ~thousands of sessions; beyond that, the page is slow to load. Past a certain scale the right answer is a real backend; for the typical opensip-tools project (dozens of sessions per week), static HTML is plenty.

---

## Extending the dashboard

The dashboard package exposes three contributor-facing seams. New
data, new ranked views, and new session-aware deep-link tabs each go
through one of them — none requires forking the generator or
sprinkling globals.

### `DashboardInput` — the input contract

`generateDashboardHtml({ … })` accepts a single options object; the
shape is the `DashboardInput` interface re-exported from
`@opensip-tools/dashboard`. Today it carries `sessions`,
`checkCatalog`, `recipeCatalog`, `graphCatalog`, and
`editorProtocol`. Future tool-shaped data — alarm history,
dependency graphs, simulation traces — extends the interface as new
optional fields. Don't grow positional parameters; add a new
optional field to `DashboardInput` and surface it in the generator's
top-of-page `<script>` block via the existing
`serializeOptionalBlob(id, value, kind)` helper (in
[`packages/dashboard/src/generator.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/generator.ts)).

### `defineRankedView` — the rank-and-render skeleton

The four ranked views in Code Paths (`hot`, `big`, `wide`,
`untested`) share one rank-and-render skeleton: walk
`indexes.byBodyHash.values()`, apply chip filters and an optional
view-specific predicate, compute a numeric metric, sort
descending, and hand the result to `renderFunctionRows`. That
skeleton lives in
[`code-paths/view-template.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/code-paths/view-template.ts);
each view file is ~30 lines of declarative config (`id`, `label`,
`help`, `metric`, optional `predicate` / `preamble` / `rowExtras`,
`columns`, `headingText`, `emptyMessage`).

A new ranked view that fits this shape is one config and one
registration in [`code-paths.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/code-paths.ts).
Bespoke views (Coupling, SCCs, Search) have different shapes and
keep their own emitters.

### `registerTabActivator` — session-aware tab navigation

The Overview tab's row-click handler routes by `session.tool`. For
tabs that need session-aware behavior (jumping to a specific row,
selecting a subtab, scrolling into view), register an activator
into the shared `tabActivators` map at module init:

```js
// inside dashboardCodePathsJs() or any future tab's emitter
if (typeof registerTabActivator === 'function') {
  registerTabActivator('graph', openCodePathsSession);
}
```

The Overview row click then calls `activateTabForSession(session)`;
if a matching activator exists, it runs and the default top-level
tab switch is suppressed. `code-paths.ts` is the worked example.
New session-aware tabs (`fit`, `sim` detail panels, etc.) plug in
the same way — the registry decouples Overview from "tab X happens
to be loaded into this page".

The registry helpers (`registerTabActivator`,
`activateTabForSession`) are declared in the shared JS emitted by
[`shared.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/dashboard/src/shared.ts) and
are available wherever any tab JS runs.

---

## Where it lives

```
<project>/opensip-tools/.runtime/reports/latest.html
```

Single rolling file. Each generation overwrites the previous file — the dashboard is "show me the most recent state of the project", not a per-run archive. Per-run history lives in the session store (`.runtime/sessions/`); the Sessions panel inlines the **most recent 20 sessions** (`loadSessions(20)` in [`packages/fitness/engine/src/cli/dashboard.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.3.2/packages/fitness/engine/src/cli/dashboard.ts)) so historical runs are browsable inside the HTML up to that bound. The session store's auto-pruning cap (`MAX_SESSIONS = 100`) means the directory itself rarely holds much more than that.

The HTML file is fully self-contained — no asset directory, no CDN, no fetches. Email a stakeholder the file and they can open it on their machine without opensip-tools installed. Useful for: post-incident reports, security review handoffs, compliance audits.

The runtime dir is gitignored. If you want to archive a specific snapshot, copy `latest.html` somewhere else before re-running.

---

## What the dashboard isn't

A few common mis-expectations, listed once:

- **Not real-time.** The dashboard reflects the most recent run on disk. Re-running fit produces a new session record; the dashboard re-reads on load. There's no streaming, no auto-refresh.
- **Not multi-machine.** Sessions are local to the project's runtime dir. A team that wants centralized reporting points `--report-to` at OpenSIP Cloud, which is a separate product (and not open-source).
- **Not authentication-aware.** The static file is readable by anyone who can read it. Treat the report as the same sensitivity as your project's source files.
- **Not editable.** It's a generated artifact. Re-run fit to update; don't hand-edit the HTML.

---

## Where the example lands

For `acme-api` after the nightly CI run:

- The session record at `<project>/opensip-tools/.runtime/sessions/2026-05-17T03-15-22-123Z-fit-default.json` carries the full result.
- The HTML report at `<project>/opensip-tools/.runtime/reports/latest.html` is regenerated. The Sessions panel inside the HTML inlines the most recent 20 session records, so a developer opening it later sees the new run alongside its 19 immediate predecessors.
- A developer running `opensip-tools dashboard` locally opens the file in their browser. The Sessions panel shows the run; the Overview panel shows the score trend.

In CI, `--open` is suppressed (no TTY), so no browser opens — but the HTML file is still written. Teams that want a per-run archive copy `latest.html` to a build-artifact path with a run-scoped filename before the next pipeline run overwrites it.

---

## What's next

- **[`../80-implementation/03-session-and-persistence.md`](/docs/opensip-tools/80-implementation/03-session-and-persistence/)** — the session and report file lifecycle.
- **[`./01-cli-commands.md`](/docs/opensip-tools/70-reference/01-cli-commands/)** — `dashboard`, `--open`, and `sessions list/purge` flags.
