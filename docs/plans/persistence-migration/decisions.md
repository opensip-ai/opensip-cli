# Architectural decisions — persistence migration

This document holds the long-form reasoning behind the decisions in [`plan.md`](./plan.md). It exists because opensip-tools does not have the OpenSIP backend's plan-improvements pipeline (which normally absorbs cross-cutting architectural reasoning); without that machinery, the rationale needs a durable home so future contributors can trace decisions back to their premises.

For decision *summaries*, see `plan.md` § Design Principles. This file goes deeper.

---

## 1. Why SQLite + Drizzle, not raw SQL

The default move for "we need a database" is `better-sqlite3.prepare(...)` with hand-written SQL strings. Zero dependencies beyond the driver, maximally flexible, no ORM baggage. For a project the size of opensip-tools, that's a real option to consider honestly.

We pick **Drizzle** anyway. Four arguments:

### Type safety at the query layer

Schemas-as-TypeScript means the queries themselves type-check against the schema. Rename a column → every query referencing it breaks at compile time. Add a `NOT NULL` → every insert missing that column fails to compile.

With raw SQL strings, the same rename is a runtime error discovered either by tests (assuming full coverage of every query path — unlikely) or by users (likely). For a codebase that already enforces strong typing via dependency-cruiser, ESLint, and a 0-error lint policy (see `CLAUDE.md`), dropping type safety at the persistence boundary would be a deliberate downgrade.

### Drizzle is the *light* ORM

Drizzle is explicitly designed against the Prisma/TypeORM pattern. No runtime metadata system. No codegen in the hot path. No N+1-by-default object hydration. No DSL barrier — queries read like SQL with type-checked identifiers.

If "ORM" means "Prisma's object graph plus magic," we're not adopting that. Drizzle is closer to a typed `better-sqlite3.prepare`.

### Schema migrations as first-class artifacts

`drizzle-kit generate` produces migration SQL from schema diffs. Migrations are checked in, applied in order at DataStore open. With raw SQL, the migration story is either hand-written migration files (now maintaining schema state in two places), a homegrown migration runner (don't), or "we just DROP TABLE and recreate" (works only as long as it's all cache — falls apart for sessions data, which is accreting and durable).

Drizzle gives us the migration story without us having to invent it.

### Refactor safety scales with the schema

The catalog schema alone has 4 tables and an open-ended set of view queries (dashboard's SCC, coupling, hot, trace derivations). Across all of opensip-tools we'll end up with 8–12 tables and 30+ query shapes. The catalog perf follow-up will add more.

At that surface area, refactor safety isn't a nice-to-have. Renaming `bodyHash` → `body_hash_sha256` in raw SQL means grepping dynamic strings across the codebase and hoping you got every one. In Drizzle, the rename is a single schema edit and the TypeScript compiler points at every query that needs updating.

### Honest assessment of the margin

The case for Drizzle over raw `better-sqlite3.prepare` is narrower than it would be for a project that needed dialect portability (we don't — see below). If opensip-tools were 3 tables and 5 query shapes, raw SQL would be a defensible call. At the actual scale — 8+ tables, 30+ query shapes, rich dashboard derivations, an evolving schema — the four arguments above each earn their weight.

If the codebase ever simplifies dramatically (e.g., the dashboard moves out into the SaaS product), this decision is worth revisiting.

### When we'd reach for raw SQL anyway

Drizzle ships a `sql` template-literal escape hatch precisely so the ORM doesn't become a cage. We'll use it for:

- **Recursive CTEs** for graph traversal (SCC, reachability). SQLite supports them; Drizzle's typed query builder doesn't model them ergonomically.
- **Performance-tuned aggregates** in the dashboard derivation layer if Drizzle's generated SQL is materially worse than hand-tuned. Profile-driven, not speculative.
- **Index hints / pragmas** that don't fit the query-builder model.

Scoped exceptions inside a Drizzle-typed codebase, not a reason to skip Drizzle.

### What we rejected

- **Prisma** — runtime engine, codegen in hot path, opinionated relations. Wrong tool.
- **TypeORM** — decorator/metadata-driven; mismatches explicit-is-better-than-implicit posture.
- **Kysely** — credible alternative. Drizzle wins narrowly on first-class migrations and schema-as-const composing cleanly with multi-package schema ownership.

---

## 2. Why SQLite only, no Postgres

opensip-tools is the **open source, embedded** CLI under the opensip.ai umbrella. The separate **opensip** SaaS product (different codebase) handles cloud, multi-tenant, and web-UI concerns. opensip-tools stays lightweight: single-binary install, no network dependencies, file-based config, SQLite-only persistence.

Concretely:

- No Postgres backend. No dialect portability layer. No CI matrix against two dialects.
- Integration with opensip-the-SaaS happens at the **external contract** surface — SARIF, `--json`, potentially a `--report-to` upload — not at the persistence layer. opensip-tools produces data; opensip-the-SaaS ingests that data through its own pipelines.

The CLAUDE.md "SaaS-ready" rule applies to opensip-tools in the narrow sense of *producing clean export surfaces*, not in the broader sense of *being a SaaS itself*. That distinction was established explicitly in conversation; without it, this design would carry significant speculative complexity (dialect-portable schemas, dual backend testing, env-var-driven backend selection) that earns nothing.

Schema choices in the migration freely use SQLite-native features — `INTEGER PRIMARY KEY AUTOINCREMENT`, JSON1 functions, `WITHOUT ROWID` tables, recursive CTEs — because we are not designing for portability.

---

## 3. Why no JSON-as-backend adapter

A natural-sounding alternative is to make the `DataStore` interface backend-agnostic such that both a JSON-file backend and a SQLite backend honor it, selected at runtime. This sounds like the adapter pattern applied symmetrically and gives users "flexibility."

We reject this. Two different things are called "adapter pattern" and they have opposite consequences:

**Adapter across implementations of the same paradigm** — same capabilities, same interface shape. opensip-tools already does this well (language adapters expose the same parse/walk/resolve surface; the Tool contract is implemented identically by fitness, simulation, and graph). The DataStore *could* later support a different SQLite driver or an in-process alternative without changing the interface. These adapters add value: the interface stays rich; every implementation honors it fully.

**Adapter across paradigms (JSON files ⇄ relational DB)** — different paradigms, different capabilities. The interface must collapse to the **intersection** — effectively `get(key) / put(key, value) / list(prefix)`. Every capability we adopted SQLite for (indexed lookups, joins, transactions, partial reads, content-addressed dedup) is now off the interface.

Concretely: the dashboard's view derivations (SCCs, coupling, hot, trace) are joins. A JSON-backed `DataStore` either implements them in-memory after loading the whole catalog — which *is* today's perf problem — or bypasses the interface to talk to SQLite directly, at which point the abstraction is a lie.

Paradigm-bridging abstractions always degrade to lowest common denominator. The "flexibility" is illusory: you build the abstraction, then immediately route around it for every interesting use case.

This rejection also aligns with the v2-hard-cut principle: keeping JSON as a runtime-selectable backend is migration-state-as-runtime-flexibility — preserving the v1 paradigm as a perpetual option rather than completing the v2 cut.

**The principle:** one paradigm (relational), one dialect (SQLite), one query layer (Drizzle).

---

## 4. Why v2 is a hard cut with no data migration

v2 ignores any pre-existing JSON files under `.runtime/` and initializes a fresh SQLite database. Caches rebuild on next invocation. Session history is not preserved.

### Why no migration code

- **The `.runtime/` directory is already classified as ephemeral.** It is gitignored, "rebuildable" per CLAUDE.md. Migration code for state the project has declared ephemeral is incoherent.
- **A JSON → SQLite migrator has no reusable payoff.** opensip-tools is OSS embedded; there's no future migration this muscle would serve. (The SQLite → SaaS-Postgres migration that *would* matter is owned by the separate opensip codebase, and is a different problem shape: schema replication, not file parsing.)
- **SemVer was made for this.** v1 → v2 with a documented storage break is the standard OSS contract.
- **The maintenance surface of migration code** — malformed-file handling, partial recovery, fallback paths — is real and avoids no real harm.

Users who depend on v1 layout stay on v1.x. CHANGELOG documents the break prominently.

---

## 5. Why a new `@opensip-tools/datastore` package

The `DataStore` interface and SQLite backends live in a **new package**, not in core or contracts. Reasoning:

- **Core stays a strict kernel.** Adding Drizzle and better-sqlite3 (a native module) to core would fundamentally change its character. CLAUDE.md describes core as "errors, logger, IDs, language adapters, plugin loader, Tool contract." Once "kernel" is violated, the boundary doesn't come back.
- **Contracts stays about contracts.** The existing `persistence/store.ts` migrates to *use* datastore; its session-shaped types stay in contracts as the contract surface for tools. But bundling persistence *implementations* with contract types overloads the package.
- **Single dependency surface.** The native module concern (better-sqlite3) is isolated to one package. Other packages depend on the typed DataStore interface.
- **The 18th-package cost is trivial.** Release tooling already handles ordered publish; one more package adds no real friction.

Datastore is paradigm-agnostic infrastructure. Domain schemas live with their owning packages (sessions in contracts, catalog in graph, file-cache in fitness). Adding a new tool means adding a new schema module; no datastore changes.

---

## 6. What stays files vs. moves to SQLite

The rule, restated for posterity:

**Internal runtime state with query-shaped access patterns moves to SQLite.** Tool-produced data — what the tools find, measure, or compute — lives in the DB. That's the data of interest, the substrate for the dashboard.

**Configuration, source, and exports stay as files.** Two categories with different reasons, both file-shaped:

- **Source / config** (recipes, custom checks, `opensip-tools.config.yml`, scenarios, `~/.opensip-tools/config.yml`) — the *inputs* humans author. Files because git, editors, and PRs are how humans collaborate on source.
- **Exports of tool data** (HTML dashboard reports, SARIF, CLI `--json`, JSONL logs) — not storage; *renderings of the data* for external consumers (browsers, code-scanning integrations, log aggregators). Underlying findings live in SQLite; these formats are the export channel.

The mental model:

```
  humans + git              SQLite                 external systems
  ─────────────             ──────                 ────────────────
  recipes.yml      ──▶      [tools run]    ──▶    latest.html
  config.yml                 findings                results.sarif
  checks/*.mjs               catalog                 --json stdout
                             sessions                logs/*.jsonl
                             baselines
```

The "uninstall is precise" property from CLAUDE.md — `rm ~/.opensip-tools/config.yml` plus `rm -rf opensip-tools/.runtime/` removes all opensip-tools state — holds because user-global state stays as a single config file. The SQLite database lives inside the per-project `.runtime/` dir, so the property is preserved.

---

## 7. Why one master plan, no sub-plans yet

The plan structure (a directory with `plan.md` and per-phase files) follows the backend-plan skill format. We considered splitting into multiple plans (one per tool, one per concern) and chose against it:

- The decisions are interlinked. DataStore interface shape, Drizzle choice, schema ownership model, rollout sequence all depend on each other. Splitting prematurely loses cross-references and risks two split plans making conflicting decisions.
- The per-domain details (catalog schema, session schema, fit-cache schema) aren't deep enough to warrant their own plans yet. Splitting now would produce thin per-domain docs that mostly restate what's in the master.

The natural future split is **catalog perf work**, anticipated as `docs/plans/graph-catalog-perf/`. That follow-up plan exists because the perf work (sharded reads, view derivations to SQL, content-addressed dedup) is a different kind of work (optimization, not migration) and is large enough to warrant its own design surface. It is explicitly out of scope here.

The current code references a `docs/plans/graph-performance-improvements.md` from `cache/write.ts:13` that does not exist; that reference will be fulfilled by the catalog-perf follow-up plan (under its anticipated name).
