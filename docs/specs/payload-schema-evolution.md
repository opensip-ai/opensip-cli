# Spec: Payload Schema Evolution for Tool-Owned Payloads

## Objective

Introduce a deliberate, tool-owned but host-detectable mechanism for schema evolution of the opaque per-tool JSON payloads (primarily `StoredSession.payload` for session history/replay/dashboard, and analogously for `tool_state` payloads).

**Why:** Current payloads are completely opaque (`unknown`). Tools project live `SignalEnvelope` data into tool-specific shapes via `build*SessionPayload`. Replay uses a shared structural decoder (`decodeSessionPayload`) + per-tool projectors. There is no inner versioning. Evolution relies on informal "be additive" discipline. This has led to (and risks future) silent breakage on replays, loss of fidelity, and un-detectable future-shape payloads (see audit findings and recent stopgap `payload_version` column + `timestamp_iso` work in batch 6).

**Success looks like:**
- Tools can safely evolve their payload shapes with clear rules.
- Old payloads continue to replay (with `fidelity: 'projection'` and optional warnings).
- Future payloads written by newer tool versions are detected on older CLIs (via outer + inner version).
- The host and contracts remain ignorant of tool vocabulary.
- Third-party tools have clear, copy-pasteable guidance.
- Backward compatible for all existing persisted data (no forced rewrites of history).

Reframed requirements:
- Add inner `__version` field inside payloads.
- Define additive vs. breaking evolution rules.
- Update decode/replay paths to inspect version and project gracefully.
- Add storage-level support (leveraging the column we added) + migration path.
- Enforce via code + docs + optional architecture check.

## Scope

### In Scope
- Formal inner versioning convention (`__version`) for session payloads and toolState values.
- Evolution rules (safe additive changes vs. major bumps with deprecation).
- Updates to the shared decoder (`decodeSessionPayload`) and per-tool `build*SessionPayload` / `*ReplayFromSession` in fitness, graph, and simulation.
- Updates to `SessionRepo` hydrate/save and schema (if needed for outer version).
- Analogous (lighter) treatment for `tool_state` payloads via `ToolStateRepo`.
- Core helper (`extractPayloadVersion` or similar) and Result-based error handling for version mismatches.
- Documentation: implementation note, reference, "extending tools" guidance.
- Migration/backfill strategy for the new columns (builds on the 0010 migration from batch 6).
- Guardrails (e.g. fitness architecture check or type tests that new payloads declare a version).
- Full compatibility for pre-__version payloads (treat as v1 / projection).

### Out of Scope (and Why)
- Changes to core `Signal` / `SignalEnvelope` shape or their `schemaVersion: 2` (already governed by core).
- Baselines (`tool_baseline_entries.payload` stores full `Signal`s — host re-renders SARIF; out of scope for tool payload versioning).
- Graph catalog versioning (separate from session payloads).
- Automatic full rewrite of all historical rows on version bump (local SQLite cache; projection is preferred).
- Public API changes to `StoredSession`, `ToolSessionReplay`, or the `toolState` seam (must remain opaque `unknown`).
- Dashboard-specific rendering changes (it consumes the structural decoded form).
- Third-party tool enforcement (guidance only; they opt in via the same patterns).

## Technical Context

### Existing Architecture
- `StoredSession.payload` (contracts): `unknown`; tool-owned opaque blob. See `packages/contracts/src/session-types.ts:38`.
- Session persistence: `session_tool_payload` table (with the `payload_version` and `timestamp_iso` columns added in recent audit work). `SessionRepo` in `@opensip-cli/session-store`.
- Shared structural decode: `decodeSessionPayload(payload, opts: DecodeSessionPayloadOptions)` in `packages/session-store/src/session-payload-decode.ts`. Has per-tool knobs (`requireFilePath`, `requireViolationCount`, `allowMetadata`).
- Per-tool builders:
  - Fitness: `buildFitnessSessionPayload` + `fitReplayFromSession` (packages/fitness/engine/src/persistence/*)
  - Graph: `buildGraphSessionPayload` + `graphReplayFromSession` (packages/graph/engine/src/persistence/*) — stricter decode options.
  - Simulation: `buildSimulationSessionPayload` + `simReplayFromSession` (packages/simulation/engine/src/persistence/*)
- Tool state: `tool_state` table + `ToolStateRepo` (`packages/datastore/src/tool-state-repo.ts`). Completely opaque per `(tool, key)`. 256 KiB cap. No current versioning.
- Persist points: `persistFitSession`, `persistSession` (graph), `persistSimSession`, and callers in the engines + CLI result builders.
- Replay consumers: `sessions show` path, `ToolSessionReplay`, dashboard detail renderer.
- Recent audit work (batches 5-6): Added `payload_version` (default 1) + warning in hydrate; `timestamp_iso` for fidelity; basic migration 0010.

### Key Dependencies
- `@opensip-cli/contracts`, `@opensip-cli/session-store`, `@opensip-cli/datastore`
- Fitness / Graph / Simulation engines (persistence + replay modules)
- Core (for any shared helper, `currentScope` diagnostics for warnings, `Result` for errors)
- Existing `DecodeSessionPayloadOptions` and `DecodedSessionPayload` / `DecodedSessionCheck` / `DecodedSessionFinding` types.

### Constraints
- SaaS / embedded parity: Must work under multiple concurrent `RunScope`s (no globals that leak across runs).
- Backward compat: All existing payloads (pre-__version, v1) must continue to decode and replay without data loss or hard failure (graceful projection + warnings OK).
- Host ignorance: No new tool-specific types or vocabulary leak into contracts / session-store / core beyond the version extraction helper.
- Performance: Session payloads are small and local; no expensive migrations on every load.
- Dogfood: Changes must keep `pnpm fit:ci` / `pnpm graph:ci` green (no new fitness violations in architecture or error-handling categories).
- Layering: Follows existing charter — session-store owns structural decode + persistence; tools own semantics and build/replay logic.

## Design Decisions

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|-------------------------|
| Inner version field name & location | Top-level `"__version": number` inside the tool's payload JSON object (double-underscore to mark as infrastructure) | Matches existing internal marker convention (`@fitness-ignore-*` etc.); visible to any JSON reader; easy to extract without parsing the whole tool shape; tool can nest more detail if desired. | `version` (too generic, risk of collision inside tool data); separate metadata wrapper (adds nesting overhead for every payload); table-only (doesn't solve toolState or inner evolution). |
| Outer vs inner versioning | Keep/enhance the storage `payload_version` column (outer, host-visible) + new inner `__version` (tool-visible inside JSON) | Outer detects "newer CLI wrote this row" at the persistence layer (already partially implemented). Inner allows fine-grained tool evolution inside the blob without host coupling. Two-level gives both detectability and flexibility. | Single version only (either loses granularity or couples host to tool internals). |
| Evolution rules | Explicit documented rules: additive = safe (no bump); breaking = major bump + deprecation path. Tools responsible for projectors in their replay functions. | Keeps host ignorant while giving tools clear guidance and a safe path. Matches "tool owns the shape" charter. | Strict schema registry (heavy for local CLI, new failure modes). "Never break" (unrealistic for real tools). |
| Compatibility on load | Structural decoder stays tolerant. Per-tool replay functions inspect `__version` and project (or fall back). Warnings via diagnostics bus + logger for future versions or missing fields. | Leverages existing `decodeSessionPayload` + per-tool replay code. Old payloads get `fidelity: 'projection'`. | Hard fail on version mismatch (breaks history for users who upgrade CLI). |
| ToolState | Same `__version` convention inside objects for versioned keys. No seam API change. | Consistent story without forcing every toolState key to be versioned (some are truly schemaless). | Separate versioning for toolState (unnecessary duplication). |
| Enforcement | Optional but recommended architecture check (or compile-time test) that new payloads include `__version`. Documentation + examples in "extending" guide. | Low enforcement cost; high visibility for authors. Fits existing fitness check model. | Mandatory at write time in session-store (would require tool vocabulary in session-store — violates charter). |

## Success Criteria

- [ ] Every first-party tool session payload written after the change includes `"__version": 1` (or higher) at the top level of the object.
- [ ] `decodeSessionPayload` + the three `*ReplayFromSession` functions successfully round-trip all existing pre-__version payloads (with appropriate `fidelity` and no data loss for the structural fields they care about).
- [ ] Loading a payload with inner `__version` > what the current code knows emits a clear warning (via `logger` + `DiagnosticsBus` event) but does not throw or corrupt the replay.
- [ ] Tool authors (first and third party) have a single source of truth for the rules and an example in the extending docs.
- [ ] `pnpm typecheck && pnpm test && pnpm lint` pass for all touched packages.
- [ ] `pnpm fit:ci` and `pnpm graph:ci` remain green (no new violations).
- [ ] Old sessions (written before this change) continue to appear correctly in `sessions list` / `sessions show` / dashboard history with `fidelity: 'projection'`.
- [ ] The `payload_version` column (from prior work) + new inner version together give both storage-level and content-level visibility.

## Boundaries

- **Always:**
  - Preserve the opaque `unknown` contract for `StoredSession.payload` and `toolState` values.
  - Use `Result<T, E>` (or throw typed `ToolError` / `ValidationError`) for version-related errors in new paths.
  - All new public helpers must be exported from the appropriate barrel and follow existing naming.
  - Changes must be additive for existing persisted data.
  - Follow CLAUDE.md layering, no module-singleton state, per-`RunScope` isolation.

- **Ask first:**
  - Any change to the public shape of `DecodedSessionPayload`, `ToolSessionReplay`, or the `toolState` seam methods.
  - Adding a new required column to `session_tool_payload` or `tool_state` beyond what the prior migration already did.
  - New fitness architecture checks that would gate third-party tools.

- **Never:**
  - Leak tool-specific check/rule/scenario IDs or severity categories into contracts or the generic decoder.
  - Hard-require a specific `__version` value in the host (only tools enforce their own).
  - Console.log, generic `Error`, or direct `process.stdout` writes.
  - Changes that would cause `pnpm fit:ci` to start failing on mainline code.

## Open Questions

- [ ] Should we also emit the detected `__version` (outer + inner) on the `DecodedSessionPayload` and the replay result for agent observability? (Low risk, high value.)
- [ ] For toolState, do we want an optional `version` parameter on the `put` seam, or keep it purely inside the payload object? (Current proposal favors inside the object.)
- [ ] Do third-party tools need a machine-readable way (in their manifest or package.json) to declare "I use session payloads with this max supported version"? (Deferred; can be added later if real demand appears.)
- [ ] Exact warning event names and log levels for "future version" and "missing __version on old payload" — coordinate with observability conventions.

## Applicable Conventions

- **Errors:** Use `ValidationError` or `SystemError` (with specific codes like `VALIDATION.SESSION.PAYLOAD_FUTURE_VERSION`) for version issues. Return `Result` from new pure helpers.
- **Logging / Observability:** New events under `session.payload.*` and `tool_state.payload.*` namespaces. Use the `DiagnosticsBus` for run-visible events. Follow existing `evt` and `module` patterns (see recent audit fixes).
- **Config:** None (this is internal payload contract, not user config).
- **DI / RunScope:** Any new helpers must be pure or read scope only via `currentScope()` (e.g. for diagnostics). No new singletons.
- **Testing:** Vitest. Add unit tests for the version extraction helper, versioned round-trips in each tool's payload tests, and integration tests that persist v1, load on "v2" code (simulated), and assert warnings + projection. Follow existing patterns in `session-payload.test.ts` and `session-replay.test.ts` files.
- **Layering:** session-store owns the outer column + structural decode + generic hydrate. Tools own their `build*` / replay logic and inner `__version` meaning. Core can own the tiny extraction helper.
- **Migration:** Use the existing datastore migration pattern (new .sql + update journal/meta as needed). Leverage the column work from batch 6.

The spec is saved to `docs/specs/payload-schema-evolution.md`.

Please review and confirm:
1. Are the success criteria correct and testable?
2. Is the scope right (In Scope vs Out of Scope)?
3. Any open questions you can answer now, or adjustments to assumptions/constraints?
4. Ready to proceed to the backend-plan?

Once approved, I can create the detailed backend implementation plan (`/backend-plan`).