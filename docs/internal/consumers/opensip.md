---
status: current
last_verified: 2026-05-28
---
# Consumer: opensip

[opensip](https://github.com/opensip-ai/opensip) — the engineering substrate / SaaS product that this organization also owns — is the primary downstream consumer of opensip-tools. This document captures what opensip depends on, the hidden contracts that implies, and the operational notes contributors should know before making breaking changes.

> **Why this doc exists.** opensip-tools is a public OSS project; we cannot mention opensip prominently in the website docs without conflating "platform" with "one specific consumer." But internally, the relationship is load-bearing: a breaking change here can break opensip's prod ingestion. Contributors need that awareness.

---

## Two distinct integration modes

opensip consumes opensip-tools in two structurally different ways. They have different version trains and different breakage profiles.

### Mode 1 — content packs (existing, since v1.x)

opensip's `package.json` includes entries like:

```json
"@opensip-tools/checks-typescript": "^1.3.1",
"@opensip-tools/checks-universal": "^1.3.1"
```

These are **content packs** — the package ships YAML/JSON check definitions that opensip's `fit` tooling loads via `opensip-tools.config.yml` at runtime. opensip's source code never `import { ... }` from these packages; they are read as data files.

**Hidden contract:** the on-disk shape of check definitions (slug, scope, tags, analyze function signature) and the `opensip-tools.config.yml` schema. Changing either is breaking for opensip even if no exported TS symbol moved.

**Blast radius of a break:** opensip's fitness gate misreports — high-noise but not data-corrupting. Detectable in opensip's CI within minutes.

### Mode 2 — CLI binary spawn (new, v2.x)

opensip's `package.json` additionally pins:

```json
"@opensip-tools/cli": "^2.0.0"
```

opensip's catalog-ingestion path calls `spawn('opensip-tools', ['graph', '--catalog-output', ...])` to produce a JSON catalog file, which `CatalogIngestor` then upserts to Postgres. This is the first time opensip has had a **runtime production dependency** on opensip-tools (all prior deps were content packs loaded as data, not commands invoked at runtime).

The PATH resolution works because `@opensip-tools/cli` declares `"bin": { "opensip-tools": "./dist/index.js" }`. pnpm symlinks `node_modules/.bin/opensip-tools` and prepends `node_modules/.bin/` to PATH at runtime, so `spawn('opensip-tools', ...)` resolves to our binary inside opensip's containers.

**Hidden contracts:**

1. The `opensip-tools` bin name. Renaming it (or moving the bin entry) breaks opensip silently — the spawn fails at runtime, not at build time.
2. The `graph --catalog-output <path>` subcommand and flags. The catalog JSON schema written to that path is the API surface.
3. Exit-code semantics (per `packages/contracts/src/exit-codes.ts`). opensip's subprocess port parses these.
4. The structured-log shape on stderr (Pino JSON lines). opensip captures these into Loki for diagnostics.

**Blast radius of a break:** opensip's catalog ingestion fails. Per-tenant pipelines stall. User-visible. **Treat changes to any of the four contracts above as breaking changes requiring a major-version bump and coordination with opensip.**

---

## Operational notes

### Transitive dependency footprint

`@opensip-tools/cli` pulls a substantial transitive graph: `@opensip-tools/graph`, `graph-typescript`, `graph-python`, `graph-go`, `graph-rust`, `graph-java`, `@opensip-tools/contracts`, `core`, `datastore`, `fitness`, `cli-ui`. opensip's container image weight increases by roughly 5–10 MB versus the content-pack-only setup. This is acknowledged on the opensip side and is not a problem we need to solve — but be aware that adding a heavy transitive dep to `@opensip-tools/cli` cascades into opensip's container size.

### Independent version trains

`@opensip-tools/checks-typescript` (content) and `@opensip-tools/cli` (binary) ship on separate version trains. opensip can bump one without the other. Bumping `cli` to a new major does not disturb the pinned `checks-typescript` version. This is intentional — content-pack changes and CLI changes have different review cadences and different breakage profiles.

### Engine subprocess has no OpenTelemetry SDK

When opensip spawns the engine, the parent side has full span coverage (opensip wraps the spawn in a `withSpanResult(...)`). The child side is opaque — the engine runs `discover → inventory → edges → indexes → rules → render` synchronously with no spans. opensip sees engine duration as a single ~30-second span with no children.

This is acknowledged as a known gap. The intended shape — env-var-gated opt-in OTel with W3C TraceContext propagation, so standalone CLI users see no change while embedding consumers get per-stage spans — is roughly a 1–2 day implementation. **Trigger condition:** the first time we cannot answer a production support question with the parent span alone — likely 2–4 weeks after opensip ships against the consolidated substrate.

### Stable engine output paths

opensip writes the catalog JSON to a path it controls, then reads it back. We do not own the disk location — but we do own the JSON shape. Treat `engine/src/types.ts:CatalogEntry` (and related types) as an external contract.

---

## Before making a change that touches consumer contracts

If a PR touches any of the following, coordinate with opensip:

- The `opensip-tools` bin name or location
- `graph` subcommand flags, including `--catalog-output`
- Catalog JSON schema (entry types, edge types, hint shapes)
- Exit codes (`packages/contracts/src/exit-codes.ts`)
- Structured-log shape on stderr (Pino field names, log levels)
- Check definition shape or `opensip-tools.config.yml` schema

The coordination cost is one conversation — usually small. Skipping the conversation has cost zero up front and high cost in the hours after the next opensip release pulls the breaking change.
