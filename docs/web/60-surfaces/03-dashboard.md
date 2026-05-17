---
status: current
last_verified: 2026-05-15
title: "Dashboard"
audience: [users, contributors]
purpose: "The HTML report — what it shows, when it opens, how it's generated, and where it lives."
source-files:
  - packages/contracts/src/persistence/dashboard/generator.ts
  - packages/contracts/src/persistence/dashboard/index.ts
  - packages/contracts/src/persistence/dashboard/overview.ts
  - packages/contracts/src/persistence/dashboard/checks.ts
  - packages/contracts/src/persistence/dashboard/sessions.ts
  - packages/cli/src/open-dashboard.ts
  - packages/fitness/engine/src/cli/dashboard.ts
related-docs:
  - ../40-runtime/03-session-and-persistence.md
  - ./01-cli-command-tree.md
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

Three triggers, all opt-in:

1. **`--open` flag.** `opensip-tools fit --open` runs the recipe, then launches the dashboard if conditions allow.
2. **Auto-open config.** `cli.open: true` in `opensip-tools.config.yml` makes `--open` the default. The user can still override with `--no-open` (Commander's negation flag).
3. **Explicit `dashboard` command.** `opensip-tools dashboard` opens the most recent run's report regardless of any pending fit run.

The launcher checks three conditions before actually opening a browser ([`packages/cli/src/open-dashboard.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/cli/src/open-dashboard.ts)):

- The user requested it (one of the three triggers).
- Output isn't `--json` (machine-readable runs don't open browsers).
- Stdout is a TTY (CI runs don't open browsers).

If any check fails, the dashboard doesn't open. The HTML file is still written; the user can navigate to it manually.

---

## What it shows

Four primary panels, each with its own JS module under [`packages/contracts/src/persistence/dashboard/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/dashboard/).

### Overview

The default landing panel. Shows:

- The most recent run's pass/fail summary, score, and timing.
- A trend graph of scores over the last N runs.
- The breakdown by category (security, quality, architecture, etc.).
- Quick links into the other panels.

Source: [`packages/contracts/src/persistence/dashboard/overview.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/dashboard/overview.ts).

### Sessions

A list of every past run, sorted reverse-chronological. Click into one to see its full detail — every check that ran, every finding, every directive applied, every check that was skipped or errored.

Per-run detail expands into a tree: check → file → finding. Each finding shows the rule id, severity, line, and (when present) the suggestion text.

Source: [`packages/contracts/src/persistence/dashboard/sessions.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/dashboard/sessions.ts).

### Checks catalog

Every check that was registered for the current project, with per-check stats:

- How many runs it's been included in.
- How often it passed vs. failed.
- The most recent run that included it.

Filterable by tag, by source pack, by pass-rate. Useful for spotting the noisiest checks (high failure rate) and the dormant ones (haven't run in weeks — maybe a recipe drift).

Source: [`packages/contracts/src/persistence/dashboard/checks.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/dashboard/checks.ts).

### Recipes

The configured recipes, with per-recipe stats. Same shape as the checks catalog but a level up: how often each recipe has run, its pass rate, its average duration.

Source: [`packages/contracts/src/persistence/dashboard/recipes.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/dashboard/recipes.ts).

### Tool tabs

The dashboard supports both fit and sim runs. The top-of-page tab switcher (fit / sim) filters the four panels by tool. Sim runs are sparser today; the panel shapes are the same.

---

## How it's generated

Static HTML. The generator ([`packages/contracts/src/persistence/dashboard/generator.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/dashboard/generator.ts)) assembles:

1. The base HTML scaffold (head, body shell, the four panel containers).
2. The CSS, inlined via `<style>` (from [`css.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/contracts/src/persistence/dashboard/css.ts)).
3. The session data, embedded via `<script type="application/json" id="sessions-data">…</script>`.
4. The catalog data (checks, recipes), embedded the same way.
5. The JS panels, inlined via `<script type="module">…</script>` (from each panel's `dashboard*Js()` function).

The output is one self-contained `index.html` plus a tiny asset directory. No CDN, no external script tags, no fetch calls. You can save the file and open it in three weeks on a plane.

Why static, no server? A few reasons:

- **Audit trail.** A static HTML you can email or commit is reviewable. A live dashboard that fetches from a backend is not.
- **No port conflicts.** Static files don't ask for `localhost:3000`.
- **No moving parts.** No daemon to crash, no cache to stale, no auth to misconfigure.

The cost: dynamic features (filtering, sorting, expand-collapse) are JS in the browser, against the embedded JSON. That works fine up to ~thousands of sessions; beyond that, the page is slow to load. Past a certain scale the right answer is a real backend; for the typical opensip-tools project (dozens of sessions per week), static HTML is plenty.

---

## Where it lives

```
<project>/opensip-tools/.runtime/reports/<run-id>/index.html
```

One report per session, identified by run id. The `dashboard` command opens the most recent run's report; the URL bar shows the path so the user can bookmark a specific run.

Reports persist until manually deleted. The runtime dir is gitignored, so reports don't accumulate in source control. `sessions purge` clears session records but leaves report files alone — manual cleanup of `.runtime/reports/` is the answer if the directory grows too large.

The HTML file is fully portable. Email a stakeholder a tarball of the directory and they can open the report on their machine without opensip-tools installed. Useful for: post-incident reports, security review handoffs, compliance audits.

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

- The session record at `<project>/opensip-tools/.runtime/sessions/run_4kqj2x9p1f.json` carries the full result.
- The HTML report at `<project>/opensip-tools/.runtime/reports/run_4kqj2x9p1f/index.html` is generated alongside.
- A developer running `opensip-tools dashboard` locally opens it in their browser. The Sessions panel shows the run; the Overview panel shows the score trend.
- A reviewer wanting to audit the regression history opens individual run reports from the Sessions list. Each is a permanent, link-shareable artifact.

In CI, `--open` is suppressed (no TTY), so no browser opens — but the HTML file is still written. Some teams archive `<project>/opensip-tools/.runtime/reports/` as a CI artifact for compliance purposes.

---

## What's next

- **[`../40-runtime/03-session-and-persistence.md`](/docs/opensip-tools/40-runtime/03-session-and-persistence/)** — the session and report file lifecycle.
- **[`./01-cli-command-tree.md`](/docs/opensip-tools/60-surfaces/01-cli-command-tree/)** — `dashboard`, `--open`, and `sessions list/purge` flags.
