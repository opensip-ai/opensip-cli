---
status: active
last_verified: 2026-06-29
owner: opensip-cli
---

# ADR-0096: Host-owned datastore lifecycle

```yaml
id: ADR-0096
title: Host-owned datastore lifecycle
date: 2026-06-29
status: active
supersedes: []
superseded_by: null
related: [ADR-0006, ADR-0051, ADR-0080, ADR-0094]
tags: [datastore, sessions, retention, sqlite, host-boundary]
enforcement: mechanizable
enforcement-reason: >
  The project-local fitness guard no-tool-owned-session-timing rejects first-party
  tool references to host-owned session retention and SQLite reclaim primitives.
  Unit tests cover the CLI retention policy, SessionRepo count pruning, config
  defaults, and datastore maintenance primitives.
```

**Decision:** The CLI host owns the lifecycle of the project-local datastore and
generic run-session history. Tools may contribute opaque session payloads through
the run-plane seam, but they MUST NOT prune generic sessions, trigger SQLite
vacuum/reclaim, or decide when persisted run history is retained.

The host enforces session retention after a successful session write, using the
project `cli.sessions` policy:

- `keep` keeps the newest N session rows.
- `maxAgeDays` drops rows older than the age window.
- `maxSizeMb` bounds the SQLite file with a best-effort reclaim pass and a
  bounded last-resort prune.

Retention is best-effort. A prune, lock, or vacuum failure is logged but never
changes the tool's verdict or process exit code.

**Alternatives:**

- **Manual-only cleanup via `opensip sessions purge`.** Rejected. Manual cleanup
  is still useful, but default local-first operation should not let session
  history and WAL-backed SQLite files grow forever.
- **Tool-owned cleanup.** Rejected. It would make `fit`, `graph`, `sim`, and
  third-party tools reason about shared host storage and would reopen the timing
  ownership boundary ADR-0051 closed.
- **Delete and recreate the datastore when it grows.** Rejected. The datastore
  contains sessions, gate baselines, graph catalogs, and plugin/tool state; a
  coarse reset destroys unrelated evidence.
- **Run full `VACUUM` on every invocation.** Rejected. Full vacuum can be
  expensive and contends on the datastore write lock. The normal path uses
  incremental reclaim only after deleted rows; full vacuum is reserved for the
  size guard.

**Rationale:** The datastore is shared infrastructure. Session rows are generic
host evidence, graph catalogs are derived caches, and gate baselines are
host-owned proof. A single host lifecycle policy preserves those boundaries and
lets operators tune retention without teaching every tool about SQLite.

SQLite `auto_vacuum=INCREMENTAL` is enabled for file-backed stores so reclaimed
pages can be returned safely after row deletion. Existing stores are converted on
open with a one-time `VACUUM`; conversion failure is logged and non-fatal so a
tool run does not fail solely because maintenance could not run.

**Consequences:**

- `cli.sessions` is the public retention knob. Defaults are `keep: 200`,
  `maxAgeDays: 60`, and `maxSizeMb: 150`; `0` disables a dimension.
- `SessionRepo.pruneToCount()` is a repository primitive, not a tool API.
- File-backed `DataStore` exposes maintenance primitives for host lifecycle code;
  the in-memory store does not.
- First-party tools must not call retention/vacuum primitives directly. The
  architecture check rejects those imports/references under tool packages.
- Runtime size cleanup is bounded and conservative; it can warn when the file
  remains over the requested size instead of looping or changing the run verdict.

**Fitness check:** `opensip-cli/fit/checks/no-tool-owned-session-timing.mjs`
guards first-party tool packages from owning generic session timing, retention,
or SQLite reclaim.
