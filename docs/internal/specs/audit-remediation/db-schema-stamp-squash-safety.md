# Spec: Database schema stamp squash-safety

## Objective

Prevent false **"your cache is newer than the CLI"** (`DataStoreVersionError`) when migration journals are squashed or renumbered, without weakening the downgrade guard for genuinely newer databases.

**Success criteria:**

- Users upgrading across a squash boundary (e.g. v0.1.0 → v0.1.1+) are not told to delete `.runtime/` unless the on-disk schema is actually incompatible.
- `readSupportedDbVersion` no longer equates "supported version" solely with **journal entry count** after squashes.
- Forward migrations remain monotonic; Drizzle `migrate()` unchanged.
- Tests cover squash boundary + normal upgrade + genuine newer-db rejection.

## Background (verified)

| Component | Behavior |
|---|---|
| `readSupportedDbVersion` | `migrations/meta/_journal.json` → `entries.length` (`schema-version.ts:33-37`) |
| On open | `isDbNewerThanCli(dbVersion, supportedVersion)` → throw `DataStoreVersionError` (`factory.ts:57-64`) |
| After migrate | `writeUserVersion(supportedVersion)` (`factory.ts:75`) |
| History | v0.1.0 shipped 14 journal entries; squash at v0.1.1 → 1 entry. DB stamped `14` fails against `supportedVersion=1`. |

**Impact today:** Narrow (v0.1.0 adopters with persisted `.runtime/`); self-healing via delete. **Risk forward:** Any future squash repeats the trap.

## Requirements

### R1 — Monotonic schema stamp

Introduce a stamp that remains monotonic across both additive migrations and
journal squashes:

- `supportedVersion = SCHEMA_VERSION_OFFSET + bundledJournalEntryCount`.
- Additive migrations advance the stamp automatically as Drizzle adds journal entries.
- Future squashes update `SCHEMA_VERSION_OFFSET` so the post-squash result equals the pre-squash supported version.
- Persist `user_version` = supported stamp, not raw journal count.

OR embed in journal meta:

```json
{ "version": "2", "entries": [...] }
```

### R2 — Squash boundary special-case (transitional)

Until R1 ships, detect legacy stamps:

- If `dbVersion > supportedVersion` **and** the current supported version is past
  the v0.1.0 pre-squash range **and** `dbVersion <= 14` (last pre-squash count),
  treat as **adoptable legacy** → run `migrate()` + re-stamp to current supported
  version without throwing.

Hard-code boundary only with comment + test fixture referencing v0.1.0 journal count; remove after N releases or when telemetry shows zero affected DBs.

### R3 — Error message quality

When genuinely blocked:

- Distinguish "newer CLI required" vs "squash migration — rebuilding cache" vs "corrupt DB".
- Point to `opensip-cli/.runtime/` path from `resolveProjectPaths`.

### R4 — Tests

- Unit: `isDbNewerThanCli` matrix (legacy 14 vs current supported → adopt; current+1 vs current → error; equal → ok).
- Unit: fake journal with 1 then 2 entries proves additive migrations advance the stamp.
- Integration: open memory backend with fake `user_version`, assert migrate + stamp.

## Design options

| Option | Pros | Cons |
|---|---|---|
| **Offset + journal count** | Additive migrations increment automatically; squashes are explicit offset changes | Requires offset discipline on squash |
| **Logical schema id constant** | Clear, squash-proof | Easy to forget on additive migrations |
| **Journal `version` field** | Single source in migrations folder | Requires drizzle-kit discipline |
| **Squash-only special case** | Minimal code | Technical debt, easy to get wrong |

**Recommendation:** Offset + journal count (R1) + transitional R2 for v0.1.0→v0.1.1 boundary in same PR.

## Implementation plan

1. Add `SCHEMA_VERSION_OFFSET` and compute `supportedVersion = offset + entries.length`.
2. Implement `resolveDbVersionGuard(dbVersion, supported)` with squash boundary table.
3. Update `factory.ts` open path to use new guard.
4. Add tests + fixture journal snippets (v0.1.0 count documented in test name).
5. Release note: "upgrading from v0.1.0 may rebuild local cache once."

## Non-goals

- Multi-tenant hosted datastore migration orchestration.
- Changing SQLite backend choice.

## Acceptance tests

- [ ] Legacy `user_version=14` + current build → opens, migrates, re-stamps without `DataStoreVersionError`.
- [ ] `user_version=99` + supported `1` → still throws (genuinely newer).
- [ ] Fresh DB → stamps to logical version after migrate.

## Open questions

1. Should logical schema id live in `packages/datastore` only or be visible to CLI error messages?
2. Bump logical id on every additive migration, or only on squash/incompatible events?
3. Telemetry event when squash boundary adoption runs?

## References

- `packages/datastore/src/schema-version.ts`
- `packages/datastore/src/factory.ts`
- `packages/datastore/migrations/meta/_journal.json`
- Architecture audit: `docs/internal/coop/agents-log.md`
