---
status: current
last_verified: 2026-07-15
release: v0.8.0
title: "Report"
audience: [users, contributors]
purpose: "The HTML report — what it shows, when it opens, how it's generated, and where it lives."
source-files:
  - packages/dashboard/src/generator.ts
  - packages/dashboard/src/index.ts
  - packages/dashboard/src/client/overview.ts
  - packages/dashboard/src/client/checks.ts
  - packages/dashboard/src/client/sessions.ts
  - packages/dashboard/src/code-paths.ts
  - packages/dashboard/src/client/
  - packages/cli/src/open-report.ts
  - packages/cli/src/report-compose.ts
  - packages/core/src/lib/paths.ts
  - packages/fitness/engine/src/cli/report-data.ts
related-docs:
  - ../80-implementation/03-session-and-persistence.md
  - ./01-cli-commands.md
  - ../40-graph/01-stages-and-catalog.md
---
# Report

The report is a self-contained HTML snapshot generated from bounded locally
stored evidence for fit, sim, graph, yagni, and installed external tools.
Generation reads the active local datastore; viewing the finished file needs no
server, database, asset hosting, or network connection.

> **What you'll understand after this:**
> - When the report opens automatically vs. manually.
> - What the HTML report contains (the top-level tabs and their subtabs).
> - How the static HTML is generated and how data flows in.
> - Where the report renderer's source lives.

---

## When it opens

There are two triggers. Analysis-triggered generation is opt-in; the explicit
report command opens by default:

1. **`--open` flag.** `opensip fit --open` (or `sim --open`) runs the recipe, then launches the report if conditions allow. `opensip audit --open` and `opensip suite run audit --open` generate the report after suite persistence and select that parent Run in Change Impact. Other `opensip suite run <name> --open` runs open the ordinary report without inventing a Change Impact selection.
2. **Explicit `report` command.** `opensip report` regenerates the current
   snapshot from stored evidence, writes it, and opens it by default unless
   `--no-open` or `--json` is selected.

The launcher's `decideReportOpen` ([`packages/cli/src/open-report.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/cli/src/open-report.ts)) returns `shouldOpen: true` only when **all** of these hold:

- The user requested it (`--open` was passed).
- Output isn't `--json` (machine-readable runs don't open browsers).
- Stdout is a TTY (pipeline / log redirect — don't open).
- The `CI` environment variable is unset (GitHub Actions, GitLab CI, CircleCI, etc. — never open).
- Not an SSH session without a display (`SSH_CONNECTION`/`SSH_CLIENT` set without `DISPLAY`/`WAYLAND_DISPLAY`).

Analysis and audit `--open` hooks apply that policy before composing the HTML;
when the request is suppressed, they neither generate nor launch a report. The
explicit `opensip report` command is different: it always composes the file and
opens it by default unless `--no-open` or `--json` is selected. Use `opensip
report --no-open` as a CI artifact step when a file is required. Browser/report
failure never changes an audit verdict or exit code.

---

## What it shows

Six first-party top-level tabs (`Overview`, `Change Impact`, `Fitness`, `Simulation`, `Code Graph`, `YAGNI`) are available when their data exists. An `External Tools` tab appears when the report includes sessions from installed Tool plugins that are not claimed by a first-party tab, such as `gitleaks`, `semgrep`, `ruff`, `osv-scanner`, or `trivy`. The Fitness and Simulation tabs each carry three subtabs (`Sessions`, `Catalog`, `Recipes`). The Code Graph (graph) tab carries four subtabs (`Sessions`, `Catalog`, `Recipes`, `Explore`). The YAGNI tab carries two subtabs (`Sessions`, `Detectors`). Browser panel modules live under [`packages/dashboard/src/client/`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/); the top-of-page tool-tab switcher is registered through [`tool-tabs-registrations.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/tool-tabs-registrations.ts) and rendered by [`tool-tabs.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/tool-tabs.ts).

### Change Impact

Change Impact is a stored-evidence view of canonical audit Runs. It does not run
Git, parse source, traverse the graph, or infer trust in the browser. Report
composition selects a parent `StoredRun.id`, follows that Run's graph-impact
`RunStep.sessionId`, and validates the linked graph-owned session projection.
Latest/timestamp matching is never used. An optional `runId` in the report's
closed `#change-impact/<id>` selection chooses a loaded Run; an invalid or
missing ID falls back without becoming an arbitrary URL target.

The panel renders the persisted review brief, exact step verification state,
changed-to-impacted summary, bounded entity/package rows, review risks, and
recommended actions. Under **Review risks and actions** it shows two capped
lists from the host-owned brief:

- **Top risks** — severity-ordered `reviewBrief.topRisks[]` (may include retained
  findings that are not net-new).
- **New findings** — `reviewBrief.newFindings[]`, the baseline-marked net-new
  list. These two lists can diverge: a lower-severity net-new finding can fall
  out of the top-risk cap while still appearing under New findings.

Exact step verification, correlations, degradations, recommended actions, and
verification commands follow the same stored-only rule. Stored impact list caps
are 200 changed files, 200 changed functions, 500 impacted functions, 500
impacted files, 100 packages, and 20 commands; every list carries an exact
omitted count and the whole UTF-8 projection is capped at 1 MiB. Truncation and
omitted metadata are visible states, never interpreted as zero.

Code Paths drill-down is enabled only when the stored catalog identity matches
the embedded current catalog and a qualified-name/path/line occurrence resolves
uniquely. Missing, legacy, or mismatched identity leaves the stored rows
readable but non-interactive. The identity compares bounded build/language/mode
facets and SHA-256 digests, never raw path-bearing catalog keys or fingerprints.

Availability and trust are separate. The panel distinguishes a faulted step,
missing RunStep/session link, unavailable persistence, legacy payload,
`impactStatus: omitted-overflow`, malformed projection, partial/unknown trust,
source truncation, and verified zero impact. Only an available projection whose
retained and omitted impacted counts are all zero can render zero impact; less
than full trust still says “no stored impact found,” not complete safety. The
full emitted envelope verification remains authoritative; stored trust is a
bounded display copy.

All evidence crosses the self-contained HTML boundary through safe JSON
serialization and escaped/text-only DOM construction. The feature adds no
network call, model call, source text, diff body, absolute project root,
environment value, or secret. See
[ADR-0156](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/docs/decisions/ADR-0156-bounded-stored-impact-proof.md).
Canonical command selection and human-only `audit --open` behavior are defined
by [ADR-0155](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/docs/decisions/ADR-0155-canonical-audit-command.md); Run and
RunStep identity remains authoritative per
[ADR-0143](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/docs/decisions/ADR-0143-host-owned-run-step-ledger.md).

### Overview

The default landing panel. Shows:

- The most recent run's pass/fail summary, score, and timing.
- A trend graph of scores over the last N runs.
- The breakdown by category (security, quality, architecture, etc.).
- Quick links into the other panels.

Source: [`packages/dashboard/src/client/overview.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/overview.ts).

### Sessions list (per-tool Overview subtab)

A list of every past run, sorted reverse-chronological. Click into one to see its full detail — every check that ran, every finding, every directive applied, every check that was skipped or errored.

Per-run detail expands into a tree: check → file → finding. Each finding shows the rule id, severity, line, and (when present) the suggestion text.

Source: [`packages/dashboard/src/client/sessions.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/sessions.ts). Rendered inside each per-tool tab's Overview subtab; the tab switcher is in [`tool-tabs.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/tool-tabs.ts).

### Catalog (per-tool Catalog subtab)

Every check that was registered for the current project, with per-check stats:

- How many runs it's been included in.
- How often it passed vs. failed.
- The most recent run that included it.

Filterable by tag, by source pack, by pass-rate. Useful for spotting the noisiest checks (high failure rate) and the dormant ones (haven't run in weeks — maybe a recipe drift).

Source: [`packages/dashboard/src/client/checks.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/checks.ts).

### Recipes (per-tool Recipes subtab)

The configured recipes, with per-recipe stats. Same shape as the catalog but a level up: how often each recipe has run, its pass rate, its average duration.

Source: [`packages/dashboard/src/client/recipes.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/recipes.ts).

### Code Paths panel

The Code Paths panel is the dashboard's graph-tool surface. It's powered by the catalog produced by `opensip graph`. The pipeline that builds the underlying catalog is documented in [`40-graph/01-stages-and-catalog.md`](/docs/opensip-cli/40-graph/01-stages-and-catalog/).

Like the Fitness and Simulation tabs, the Code Paths tab carries subtabs:

- **Sessions** — recent graph runs and their per-rule findings (shared session table).
- **Catalog** — the registered graph rules, with default severity and source.
- **Recipes** — the configured graph recipes (named rule subsets).
- **Explore** — the interactive catalog browser (the views below).

The **Explore** subtab is language-agnostic — it consumes the shared `Catalog`
shape and works against TypeScript, Python, Rust, Go, and Java catalogs alike.
Per-edge `confidence` is carried on `GraphCallEdge` and is available to views;
today it's read but not surfaced as a UI badge, so reachability views on
tree-sitter catalogs look the same as TypeScript ones even though the underlying
edges are lower-fidelity. See the per-rule fidelity table in
[`02-rules-and-gating.md`](/docs/opensip-cli/40-graph/02-rules-and-gating/) for what this
means in practice.

The Explore subtab has three views (each with the same row-click → universal Function Card flow):

- **Graph** — a node-link topology rendering of the call graph (Cytoscape.js +
  dagre/cose/breadthfirst layouts), with **SCC cycle highlighting** folded in.
- **Coupling** — the N×N package-by-package call-density matrix; click a cell for the actual call sites. "Is `core` really the bottom layer?"
- **Functions** — one sortable, paginated, filter-aware function table. Its
  columns cover body length (lines, the default sort), inbound callers,
  parameter count (width), and kind/package/file. It carries an in-table
  **name filter** plus a **Test-only** toggle that narrows to production
  functions reached only from tests. Paginated at 10 rows per page — every
  function in the catalog (after filters) is reachable by paging.

The **Universal Function Card** is the cross-cutting drill-down: every clickable function name in any view opens the same overlay with name + location, body length, kind, params, return type, callers grouped by package, callees (resolved + external), an "Open in editor" deep link (`vscode://` or `cursor://` — opt in via `dashboard.editor` in [`opensip-cli.config.yml`](/docs/opensip-cli/70-reference/03-configuration/); falls back to "Copy path" when unset), and a "Trace from entry" BFS.

Filter chips apply across the Explore views: package multi-select, kind multi-select, and a production/test toggle (default: production-only).

Source: [`packages/dashboard/src/code-paths.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/code-paths.ts) and the per-view browser modules under [`packages/dashboard/src/client/`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/) (`view-graph.ts`, `view-coupling.ts`, `view-distribution.ts`).

### Tool tabs

The report supports audit Run evidence plus fit, sim, graph, yagni, and installed Tool plugin runs. The top-of-page tab switcher filters the panels by view/tool. Change Impact joins a parent Run to its graph session; fit and sim use the shared Sessions/Catalog/Recipes shape, graph uses Code Graph with catalog exploration, and YAGNI uses Sessions/Detectors. Installed external scanner adapters fall into `External Tools`: their sessions render with the same Overview rows, run detail, verdicts, timing, findings, and tool badges as built-in tools, without requiring a custom dashboard module for each scanner. Source: [`tool-tabs.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/tool-tabs.ts) and [`tool-tabs-registrations.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/tool-tabs-registrations.ts).

---

## How it's generated

Static HTML. The generator ([`packages/dashboard/src/generator.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/generator.ts)) assembles:

1. The base HTML scaffold (head, body shell, the panel containers).
2. The CSS, inlined via `<style>` (from [`css.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/css.ts)).
3. Session and catalog data (checks, recipes), inlined directly into the panel `<script type="module">` blocks as `const sessions = …` / `const catalog = …` literals — there's no separate `<script type="application/json">` for these.
4. The graph catalog (Code Paths panel) when present, embedded as `<script type="application/json" id="graph-catalog">…</script>` and consumed by the Code Paths panel JS at init time. This one *does* use the `application/json` idiom because it's loaded across module boundaries.
5. The JS panels, inlined via `<script type="module">…</script>` (from each panel's `dashboard*Js()` function).

The output is one self-contained `latest.html`. No CDN, no external script tags, no fetch calls, no asset directory. You can save the file and open it in three weeks on a plane.

Why static, no server? A few reasons:

- **Audit trail.** A static HTML you can email or commit is reviewable. A live report that fetches from a backend is not.
- **No port conflicts.** Static files don't ask for `localhost:3000`.
- **No moving parts.** No daemon to crash, no cache to stale, no auth to misconfigure.

The cost: dynamic features (filtering, sorting, expand-collapse) are JS in the browser, against the embedded JSON. That works fine up to ~thousands of sessions; beyond that, the page is slow to load. Past a certain scale the right answer is a real backend; for the typical opensip-cli project (dozens of sessions per week), static HTML is plenty.

---

## Extending the report renderer

The `@opensip-cli/dashboard` package exposes three contributor-facing seams. New
data, new ranked views, and new session-aware deep-link tabs each go
through one of them — none requires forking the generator or
sprinkling globals.

### `DashboardInput` — the input contract

`generateDashboardHtml({ … })` accepts a single options object; the
shape is the `DashboardInput` interface re-exported from
`@opensip-cli/dashboard`. Today it carries `sessions`,
`checkCatalog`, `recipeCatalog`, graph catalog/rule/recipe data,
simulation scenario/recipe data, YAGNI detector data, and
`editorProtocol`. Future tool-shaped data — alarm history,
dependency graphs, simulation traces — extends the interface as new
optional fields. Don't grow positional parameters; add a new
optional field to `DashboardInput` and surface it in the generator's
top-of-page `<script>` block via the existing
`serializeOptionalBlob(id, value, kind)` helper (in
[`packages/dashboard/src/generator.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/generator.ts)).

### `defineRankedView` — the rank-and-render skeleton

The ranked **Functions** view in Code Paths is built on a
rank-and-render skeleton: walk `indexes.byBodyHash.values()`, apply
chip filters and an optional view-specific predicate, compute a
numeric metric, sort descending, and hand the result to
`renderFunctionRows`. That skeleton lives in
[`client/view-template.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/view-template.ts);
the view file is declarative config (`id`, `label`, `help`, `metric`,
optional `predicate` / `preamble` / `searchByName` / `filterToggle`,
`columns`, `headingText`, `emptyMessage`). The Functions view uses this
skeleton with sortable columns for the common size, caller, width, and
test-reachability questions.

A new ranked view that fits this shape is one config and one
registration in [`code-paths.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/code-paths.ts).
Bespoke views (Graph, Coupling) have different shapes and
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
`activateTabForSession`) are declared in
[`tab-activators.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/dashboard/src/client/tab-activators.ts) and
are available wherever any tab JS runs.

---

## Where it lives

| Project state | Report path |
|---|---|
| Zero-config project | `~/.opensip-cli/cache/ephemeral/<project-key>/reports/latest.html` |
| Initialized project | `<project>/opensip-cli/.runtime/reports/latest.html` |

`opensip report` resolves the same active local runtime as analysis and session
commands. A managed-cache report therefore works before initialization without
creating project files. The internal `ephemeral` path name means the whole cache
entry is automatically evictable, not that the report disappears when the
process exits.

Single rolling file. Each generation overwrites the previous file — the dashboard is "show me the most recent state of the project", not a per-run archive. Per-run history lives in the active runtime's SQLite session store (`datastore.sqlite`, read via `SessionRepo`); the Sessions panel inlines the **most recent 20 sessions** (`new SessionRepo(datastore).list({ limit: 20 })` in [`packages/cli/src/report-compose.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.8.0/packages/cli/src/report-compose.ts)) so historical runs are browsable inside the HTML up to that bound. Older sessions stay in the store until retention or `sessions purge` removes them.

The HTML file is fully self-contained — no asset directory, no CDN, no fetches. Email a stakeholder the file and they can open it on their machine without opensip-cli installed. Useful for: post-incident reports, security review handoffs, compliance audits.

The project runtime is gitignored; the zero-config runtime lives outside the
project in the managed user cache. Neither location is an archive. Copy
`latest.html` somewhere else before re-running if you need a durable snapshot.

---

## What the dashboard isn't

A few common mis-expectations, listed once:

- **Not real-time.** The dashboard is a self-contained snapshot of the data
  inlined when it was generated; it cannot re-read SQLite when opened. Run
  `opensip report` (or use a command mode that accepts `--open` and composes a
  report) to refresh it. There is no streaming or auto-refresh.
- **Not multi-machine.** Sessions are local to the active runtime on one
  machine. Opt-in Cloud delivery sends bounded signals or SARIF through the
  supported delivery paths; the local runtime, database, and generated HTML
  remain local.
- **Not authentication-aware.** The static file is readable by anyone who can read it. Treat the report as the same sensitivity as your project's source files.
- **Not editable.** It's a generated artifact. Re-run fit to update; don't hand-edit the HTML.

---

## Where the example lands

For an initialized `acme-api` project after nightly CI runs the analysis and
then `opensip report --no-open`:

- The session row persisted in `<project>/opensip-cli/.runtime/datastore.sqlite` (tool `fit`, recipe `default`, timestamped `2026-05-17T03:15:22.123Z`) carries the full result in its companion `session_tool_payload` row.
- The HTML report at `<project>/opensip-cli/.runtime/reports/latest.html` is regenerated. The Sessions panel inside the HTML inlines the most recent 20 session records, so a developer opening it later sees the new run alongside its 19 immediate predecessors.
- A developer running `opensip report` locally opens the file in their browser. The Sessions panel shows the run; the Overview panel shows the score trend.

An analysis command's `--open` is suppressed in CI, which prevents both report
composition and browser launch. The explicit `opensip report --no-open` step
above generates the HTML without attempting to launch a browser. Teams that
want a per-run archive can then copy `latest.html` to a build-artifact path with
a run-scoped filename before the next report generation overwrites it.

---

## What's next

- **[`../80-implementation/03-session-and-persistence.md`](/docs/opensip-cli/80-implementation/03-session-and-persistence/)** — the session and report file lifecycle.
- **[`./01-cli-commands.md`](/docs/opensip-cli/70-reference/01-cli-commands/)** — `report`, `--open`, `sessions list/purge/show`, and the new `agent-catalog` discovery surface (with agent ergonomics such as `--filter` / `--raw` / `--summary-only`).
