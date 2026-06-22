---
status: active
last_verified: 2026-06-22
owner: opensip-cli
---

# ADR-0054: External Tool Fault-Isolation Boundary

```yaml
id: ADR-0054
title: External Tool Fault-Isolation Boundary
date: 2026-06-16
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0027, ADR-0028, ADR-0029, ADR-0030, ADR-0052]
tags: [tools, plugins, isolation, cli, architecture, config, saas]
enforcement: mechanizable
enforcement-reason: >
  The capstone (M4-G) has landed: external-provenance tool runtime NEVER imports
  in the host process. The boundary is enforced repo-wide on every PR.
  `hostRuntimeImportPolicyFor` is narrowed to `{ source: 'bundled' }` — a
  non-bundled host import is a COMPILE error, not a runtime guard; external
  runtimes load only behind the worker-owned dispatch plane via the distinct
  `workerRuntimeImportPolicyFor`. The strengthened `host-tool-runtime-import-boundary`
  fitness check (run by `pnpm fit:ci`) asserts: `importToolRuntime` stays in the
  admission/discovery boundary, host imports pass a bundled policy, and the worker
  policy is confined to the worker plane. A bootstrap test
  (`host-no-external-runtime-import.test.ts`) proves host discovery synthesizes a
  manifest-derived Tool with no runtime import (a sentinel confirms non-import)
  while the worker imports the real runtime, plus a `@ts-expect-error` proves the
  bundled-only policy type.
```

**Decision:** External-provenance tool runtime code must not load or execute in
the CLI host process. The host may read static manifests as data; tool runtime
modules, command handlers, lifecycle hooks, deep config validation, and
capability registrars execute in a worker process behind a structured IPC
protocol. Bundled first-party tools are the trusted computing base and may keep
in-process execution for compatibility and development.

This ADR records the platform boundary and migration contract. It does not claim
that external-tool sandboxing has already landed.

**Alternatives:**

- *Keep importing admitted external tool runtimes in the host and rely on
  ToolCliContext seams.* Rejected: seams are a syscall vocabulary, not a syscall
  boundary. A runtime import can run top-level code before any seam exists, and
  in-process code can still call `process.exit`, spin the event loop, mutate
  globals, or crash native code.
- *Use lint, fitness checks, and runtime guards as the boundary.* Rejected:
  those protect cooperating first-party source. They do not constrain compiled
  JavaScript loaded from npm, a user-global tool, or a project-local sidecar.
- *Worker-isolate command handlers but keep host-side Zod composition for
  third-party config.* Rejected: arbitrary Zod schemas are executable code
  (refinements, transforms, closures). Composing them in the host reintroduces
  the load-time hole under a config label.
- *Treat user-global tools as trusted because the user installed them.* Rejected:
  user intent authorizes running code, not sharing the kernel process. Trust is
  provenance of code, not provenance of intent.
- *Worker threads or `vm` contexts as the boundary.* Rejected for the same reason
  ADR-0028 rejected them for live engines: they do not provide an OS process
  failure boundary, and they cannot contain `process.exit`, native crashes, OOM,
  or CPU-bound infinite loops.

**Rationale:** opensip-cli already has the shape of the boundary but not the hard
trap. Static manifests are explicitly designed so the host can inspect tool
identity, command names, compatibility epoch, and declared capabilities without
importing the runtime module. Today, registration still imports admitted runtime
modules in the host to obtain `commandSpecs`, lifecycle hooks, config Zod blocks,
capability registrars, report/session hooks, and command handlers. That means an
external tool can still kill or freeze the CLI before the host-owned seams can
mediate anything.

ADR-0028 provides the required primitive: a forked CLI worker re-enters normal
bootstrap, streams progress over IPC, returns a slim serializable result, and
turns child failure into structured parent-side failure. Extending the graph live
worker path to sharded runs validates that primitive on a first-party coordinator
workload: the render parent becomes a pure renderer/supervisor, while the worker
owns both the shard pool and the synchronous coordinator work.

**Current implementation scope:** The change that introduces this ADR applies
the worker primitive to first-party graph live rendering only. It moves sharded
live graph coordination out of the Ink render process; it does not remove
host-side `importToolRuntime(...)` for external tools, migrate external config or
tool command execution behind worker IPC, or claim sandboxing for installed /
authored Tool packages. It also does not move capability discovery or lifecycle
hooks behind worker RPC, or disable unsafe in-process fallback for external
provenance. Those are the migration workstreams below.

**2026-06-22 capstone (M4-G):** the transition guard is RETIRED — the boundary is
now final. The host NEVER imports an external-provenance tool runtime: discovery
registers a manifest-derived synthetic `Tool` (command shells lifted into the
serializable `ToolCommandManifest` + `pluginLayout` on the static manifest), and
the forked dispatch worker imports the real runtime when a command dispatches.
`hostRuntimeImportPolicyFor` is narrowed to `{ source: 'bundled' }` (a non-bundled
host import is a compile error); the worker-owned import uses the distinct
`workerRuntimeImportPolicyFor`. The `host-tool-runtime-import-boundary` fitness
check is now the capstone invariant guard (host imports bundled-only; the worker
policy confined to the worker plane), not a staging guardrail. The
`2026-06-17 transition guard` (host runtime imports under a named
`adr0054Transition` exception) is superseded — that exception no longer exists.

**Config semantics:** Config validation is a two-pass contract.

- The host performs a coarse, serializable manifest-declared pass before fork.
  This pass is authoritative for namespace ownership, top-level block presence,
  unknown keys, primitive types, and docs/init scaffolding. JSON Schema-shaped
  descriptors are the intended currency.
- The worker performs tool-owned deep validation after runtime load. This pass is
  authoritative for semantic constraints, cross-field rules, refinements, and
  transforms. Failure crosses IPC as a tool/config error; it must never crash the
  host.

**Trust tiers:** Bundled first-party tools are kernel modules: they are part of
the trusted computing base and may keep in-process execution or the
`OPENSIP_CLI_NO_WORKER` fallback for development and compatibility. Installed,
project-local, and user-global tools are userspace: they run out-of-process by
default, and the unsafe in-process fallback must not apply to them unless a
future explicit developer-only override says so in its name and warning text.

**Consequences:**

- Manifest-first discovery becomes the host contract. The host reads manifests
  and static descriptors; it does not import external runtime code to discover
  commands, config, dashboards, sessions, or capability domains.
- Command metadata and command bodies split cleanly. The manifest carries the
  command shell (`name`, description, aliases, flags/args/output metadata once
  that descriptor is added); the worker loads the runtime command handler.
- ToolCliContext becomes the syscall/RPC surface. Privileged effects such as
  rendering, JSON output, SARIF writes, signal delivery, diagnostics, session
  contribution, baselines, and datastore-mediated host planes cross as structured
  requests or final results. The host remains the only process that performs the
  privileged effect.
- Lifecycle hooks move worker-side for external tools. `initialize`,
  `contributeScope`, `collectReportData`, `sessionReplay`,
  `fingerprintStrategy`, and `capabilityRegistrars` must either become
  serializable manifest declarations, worker-executed code whose effects return
  over IPC, or bundled-only host hooks.
- The external in-host import can be deleted only after the last host consumer of
  the runtime object has migrated. The capstone invariant is: no
  `importToolRuntime(...)` for external-provenance tools in the host process.
- Resource control belongs to the supervisor: wall-clock timeout, cancellation,
  heartbeat, max IPC payload size, max captured output, and child process memory
  limits should be enforced by the host-owned worker plane.

**Migration workstreams:**

- Command shells: lift the host-mounted `CommandSpec` shell into a serializable
  manifest descriptor while keeping handlers worker-owned.
- Config: add manifest-declared structural descriptors and route semantic
  validation through worker IPC.
- Capabilities and lifecycle: replace host-side runtime hook execution for
  external tools with manifest data or worker RPC results.
- Guardrails: add a bootstrap test and fitness check for the capstone invariant,
  then make `OPENSIP_CLI_NO_WORKER` first-party-only by default.

**Related specs / ADRs:** Generalizes the ADR-0028 worker transport into the
target tool fault-isolation primitive. Interacts with ADR-0023 config
composition, ADR-0027 parity, ADR-0029 capability discovery, ADR-0030 authored
tool discovery, and ADR-0052 bootstrap sequencing.

## Build Plan (sequenced)

This section turns the four migration workstreams into concrete, ordered,
independently-shippable increments. The ordering is dependency-driven: each
increment ends green (typecheck + test + lint + dogfood) and leaves the boundary
in a *valid* intermediate state — never half-built. The capstone (M4-G, deleting
the host import) lands LAST, only after every host consumer of the runtime object
has a worker/RPC path.

The grounding facts (verified against the tree at this ADR's `last_verified`):

- The worker PRIMITIVE exists: `createSubprocessProgressRun` /
  `runOffThreadOrInProcess` in `packages/core/src/runtime/subprocess-transport.ts`
  forks `descriptor.command` (the CLI entry, `process.argv[1]`) with
  `descriptor.argv` (a worker subcommand + spec path), streams a typed
  `WorkerMessage<TEvent,TResult>` over `serialization: 'advanced'` IPC, turns
  child throw/`process.exit`/crash/premature-exit into a structured parent-side
  rejection (`logFailed('ipc_error'|'spawn'|'exit_nonzero')`), and degrades to
  in-process on a synchronous fork failure or `OPENSIP_CLI_NO_WORKER=1`.
- The IPC message union is the single source of truth in
  `packages/core/src/runtime/progress-transport.ts`
  (`WorkerMessage<TEvent,TResult> = progress | result | error`).
- The host import seam is `importToolRuntime(dir, policy)` +
  `hostRuntimeImportPolicyFor(source)` in
  `packages/cli/src/bootstrap/admit-tool-package.ts`; the three permitted call
  sites are confined by the `host-tool-runtime-import-boundary` fitness check
  (`packages/fitness/checks-typescript/src/checks/architecture/`).
- The handler invocation site to intercept is `mountCommandSpec`'s action body,
  `const result = await spec.handler(optsWithArgs, ctx)` in
  `packages/cli/src/commands/mount-command-spec.ts` (`output`-dispatch follows in
  `dispatchOutput`).
- Provenance (`ToolProvenance.source: 'bundled' | 'installed' | 'project-local'
  | 'user-global'`) is captured at admission time
  (`AdmissionReport.provenance`), but is NOT carried on the `Tool` runtime
  object — it must be threaded from admission → mount.
- The `ToolCliContext` surface (`packages/core/src/tools/cli-context.ts`) is the
  ~20-seam host surface that becomes the IPC/RPC surface.

### Increment M4-A — Provenance threading (no behavior change)

**Goal:** make a tool's `ToolProvenance.source` reachable at the
`mountCommandSpec` action body so a later increment can branch
bundled/external. Today the registry holds `Tool` objects with no provenance.

**Design:** carry a `ToolProvenance` alongside each registered `Tool`. Two
viable shapes — pick the one that keeps the registry generic:

- a host-owned `Map<stableId, ToolProvenance>` built from the four admission
  collectors (`registerFirstPartyTools`, `discoverAndRegisterToolPackages`,
  `discoverAndRegisterAuthoredTools` already push onto a `provenance[]` sink),
  threaded into `mountAllToolCommands(registry, program, ctx, provenanceById)`
  → `mountOneTool` → `bindToolCliContext`; or
- a `provenance` field on the registry's per-tool record (if the registry stores
  records, not bare `Tool`s).

The provenance lookup resolves by `tool.metadata.id` (the stable UUID; the
collision guard at `register-tools-discovery.ts` already keys on it).

**Entry:** registry has no provenance link. **Exit:** `mountOneTool` (and thus
the action body, via a closed-over value or an added `CommandMountContext`
field) can read `provenance.source` for the tool it is mounting; all existing
tests pass unchanged; no dispatch behavior changes yet.

### Increment M4-B — IPC protocol for command dispatch

**Goal:** define the request/response + streaming protocol for running ONE tool
command in a worker, reusing the existing transport shape.

**Design (the IPC message protocol):** generalize the existing `WorkerMessage`
union rather than inventing a parallel one. The dispatch worker is a new
internal CLI subcommand (mirrors `graph-run-worker`):

```
opensip __tool-command-worker <specPath>
```

Parent → child (the request, written to a temp JSON spec file — the same
pattern graph uses; the path is `descriptor.argv[1]`):

```ts
interface ToolCommandWorkerSpec {
  readonly toolId: string;          // stable UUID — re-resolved + re-imported IN the worker
  readonly toolPackageDir: string;  // dir the worker importToolRuntime()s from
  readonly source: Exclude<ToolSource, 'bundled'>;  // external only; bundled never forks
  readonly commandName: string;     // which CommandSpec.name to run
  readonly opts: Record<string, unknown>;   // parsed opts (serializable; Commander output)
  readonly positionals: readonly unknown[]; // _args
  readonly cwd: string;
  // correlation rides env (OPENSIP_*), not the spec — symmetric to graph
}
```

Child → parent reuses `WorkerMessage<TEvent, TResult>` with two concrete
bindings:

- `TEvent` = a `HostRpcRequest` discriminated union (a streamed *upcall* — the
  worker asking the host to perform a privileged effect mid-run, see M4-D);
- `TResult` = a `ToolCommandResult` final-result shape (see M4-C).

The `error` arm already carries `message` / `stack` / `failureClass` — the
worker stamps `failureClass: 'tool-handler-throw'` (vs the transport's
`exit_nonzero` / `spawn` / `ipc_error`). Add an RPC-reply direction
(parent → child `process.send`) for the host's response to a streamed
`HostRpcRequest`; this is the one addition over the current fire-and-forget
fork (graph's worker never needed a reply). Each request carries a monotonic
`rpcId`; the worker awaits the matching `{ kind: 'rpc-reply', rpcId, value }`.

**Resource control (supervisor-owned, per the ADR's Consequences):** wall-clock
timeout (SIGKILL after N ms → `failureClass: 'timeout'`), max IPC payload size,
max captured output, and cancellation are enforced parent-side in the
supervisor. The existing transport already kills the child on settle.

**Entry:** no command-dispatch protocol. **Exit:** the spec/result/RPC types
compile in core (`progress-transport.ts` or a sibling), are pure-serializable,
and have unit tests for round-trip structured-clone safety. No wiring yet.

### Increment M4-C — The `ToolCliContext` seam → RPC mapping

This is the hard design. Every seam a handler can call is classified into one of
four transport strategies:

- **final-result-return (FRR):** the worker accumulates the value and returns it
  ONCE in `ToolCommandResult`; the host performs the effect after the worker
  resolves. Safe because these are idempotent, called at most once, plain-data.
- **host-RPC-request (RPC):** a streamed upcall (`HostRpcRequest`) — the worker
  blocks on a reply because the effect touches the datastore / network /
  filesystem / process exit code, which only the host may do.
- **streamed-event (EVT):** progress emitted many times during the run, mapped
  to the existing `progress` arm (no reply).
- **manifest-static (MS):** not a runtime call at all — resolved from the static
  manifest before fork, or computed worker-side from serializable inputs.

| Seam | Serializable? | Calls | Strategy | Notes |
| --- | --- | --- | --- | --- |
| `scope` (ToolScope) | partial (datastore() is a live thunk; registries are class instances) | many (read) | **RPC** (narrowed) | The worker re-bootstraps its OWN scope (project/config/registries) by re-entering CLI bootstrap, exactly like graph's worker. Only the **datastore-backed reads** become host RPC; project/config/parseCache are worker-local. The worker never ships a live `RunScope` across IPC. |
| `runSession.timing` (RunTimer) | yes (snapshots) | read | **MS** | Host owns timing (host-owned-run-timing). The worker gets `startedAt`/`startedAtEpochMs` in the spec for display-only elapsed; `complete()` is host-side. Tools never own the generic row. |
| `render(result)` | result is plain-data | once | **FRR** | Worker returns `result` in `ToolCommandResult.render`; host calls `ctx.render` (Ink runs host-side only). |
| `emitJson(value)` | yes | once | **FRR** | Returned as `ToolCommandResult.json`; host emits through `dispatchOutput`/the one outcome seam. |
| `emitEnvelope(envelope)` | yes (SignalEnvelope is plain-data) | once | **FRR** | Returned as `ToolCommandResult.envelope`; host wraps in `CommandOutcome`. |
| `emitError(detail)` | yes | once | **FRR** | Returned as `ToolCommandResult.error`; host emits + threads exitCode. |
| `emitRaw(value)` | yes | once | **FRR** | Returned as `ToolCommandResult.raw`; host writes the single raw line. |
| `setExitCode(code)` | yes | 0–1 | **RPC** (or FRR) | The exit code is host-owned. Simplest: return `ToolCommandResult.exitCode` (FRR) since handlers set it at most once and last-write-wins. Use RPC only if a handler must observe its own exit mid-run (none do today). The slice (M4-2) uses FRR. |
| `getExitCode()` | yes | 0–1 | **RPC** | Gate COMPARE re-affirm path. Worker upcalls; host returns the mirror. Rare; defer until a gate runs in a worker. |
| `deliverSignals(env, opts)` | env/opts/result all plain-data | once | **RPC** | Network egress (cloud sink + `--report-to`). Worker upcalls with the envelope; host performs egress and returns `SignalDeliveryResult`. Host also owns the exit-4 derivation. |
| `writeSarif(env, path)` | yes | once | **RPC** | Filesystem write. Worker upcalls; host writes. |
| `saveBaseline(tool, env)` | yes | once | **RPC** | Datastore write (`BaselineRepo`). Worker upcalls; host persists. |
| `compareBaseline(tool, env)` | yes (result is plain-data) | once | **RPC** | Datastore read + diff (host `diffBaseline`). Worker upcalls; host returns `GateCompareResult`. |
| `exportBaselineSarif(tool, path)` | yes | once | **RPC** | Datastore read + FS write. |
| `exportBaselineFingerprints(tool, path)` | yes | once | **RPC** | Datastore read + FS write. |
| `toolState.{get,put,delete,list}` | payloads are opaque JSON | 0+ | **RPC** | Datastore-backed per-tool state. All four upcall; host performs via `ToolStateRepo`. |
| `hostPlanes.governance.*` | plain-data | 0+ | **RPC** | All delegate to `toolState` → datastore. Each method is an upcall. |
| `hostPlanes.audit.*` | plain-data | 0+ | **RPC** | Same — datastore-backed; upcalls. |
| `hostPlanes.entitlements.*` | plain-data | 0+ | **RPC** | Same — datastore-backed; upcalls. |
| `logger` (Logger) | NO (class instance) | many | **RPC** (or local) | The worker has its OWN scope logger after re-bootstrap (writes its own JSONL with the inherited `runId` from `OPENSIP_RUN_ID`), so logging is worker-LOCAL — no upcall needed. Correlation env stitches the lines to the parent run. Only structured `CommandOutcome.diagnostics` milestones the host must own become RPC. |
| `registerLiveView(key, fn)` / `renderLive(key,args)` | fn is a closure (NOT serializable) | setup/once | **host-side only** | Ink/TTY rendering cannot leave the host. An external tool whose command declares `output: 'live-view'` either (a) runs its analysis in the worker and returns a `ToolCommandResult` the host renders statically, or (b) is denied a live view in the first external slice. Live-view-for-external-tools is explicitly OUT of the vertical slice; documented as a later increment. |
| `maybeOpenReport(opts)` | opts plain-data | once | **RPC** | FS + browser launch. Worker upcalls; host opens. |

Final-result shape:

```ts
interface ToolCommandResult {
  readonly output: CommandOutputMode;  // mirrors the spec so the host dispatches
  readonly render?: unknown;           // CommandResult for output:'command-result'
  readonly envelope?: unknown;         // SignalEnvelope for output:'signal-envelope'
  readonly json?: unknown;             // emitJson payload
  readonly raw?: unknown;              // emitRaw payload
  readonly error?: { message: string; exitCode: number; suggestion?: string; code?: string };
  readonly exitCode?: number;          // setExitCode last-write
  readonly session?: ToolSessionContribution;  // host persists after return
}
```

The host-side supervisor, on receiving `ToolCommandResult`, replays it through
the EXISTING seams (`ctx.render` / `ctx.emitEnvelope` / `dispatchOutput` /
`ctx.completeRun`) so the output contract stays byte-identical to the in-process
path. The worker-side `ToolCliContext` is a **shim**: each FRR seam records into
a result accumulator; each RPC seam does a synchronous-looking
`await hostRpc(request)` over IPC; `runSession`/`logger` are worker-local.

**Entry:** seams are called directly in-host. **Exit:** the mapping is encoded as
(a) a worker-side `ToolCliContext` shim that satisfies the full interface and (b)
a host-side RPC handler switch covering every RPC seam; both have unit tests; the
table above is the spec.

### Increment M4-D — Host-side supervisor + worker entry (the dispatch plane)

**Goal:** wire M4-A/B/C into a working out-of-process path for external command
dispatch.

**Design:**

- **Worker entry** (`__tool-command-worker`): a new internal `CommandSpec`
  registered as a host CLI subcommand (mirrors `graphRunWorkerCommandSpec`,
  `output: 'raw-stream'`, `rawStreamReason: 'worker-ipc'`). Its handler reads the
  spec file, `importToolRuntime(spec.toolPackageDir,
  hostRuntimeImportPolicyFor(spec.source))` **IN THE WORKER** (this is the
  isolation move — the untrusted runtime loads here, not in the host), finds the
  `CommandSpec` by `spec.commandName`, builds the worker-side `ToolCliContext`
  shim (M4-C), runs the handler, and posts `{ kind: 'result', value:
  ToolCommandResult }` — or `{ kind: 'error', ..., failureClass:
  'tool-handler-throw' }` on a throw. A `process.exit(1)` or crash in the
  handler is contained as the transport's premature-`exit` → structured
  rejection.
- **Host supervisor** (`dispatchExternalToolCommand`): forks via
  `runOffThreadOrInProcess`-style transport (but external tools have NO
  in-process fallback by trust tier — see M4-E), serves `HostRpcRequest`
  upcalls against the REAL host `ToolCliContext`, enforces the supervisor
  resource limits (timeout/cancel/payload caps), and on `result` replays the
  `ToolCommandResult` through the host seams.
- **Branch point:** in `mountCommandSpec`'s action body, replace
  `const result = await spec.handler(optsWithArgs, ctx)` with: if the tool's
  provenance (M4-A) is `'bundled'` → in-process today's path; else → `await
  dispatchExternalToolCommand({ spec, opts: optsWithArgs, positionals, ctx,
  provenance })`. Bundled stays byte-identical.

**Entry:** external tools import + run in-host. **Exit:** an external tool's
command runs in a worker; bundled tools unchanged; an integration test with a
fixture external tool proves (a) happy-path result crosses correctly and (b) a
handler `process.exit(1)` / throw / hang is a structured parent-side failure
while the host survives. (This increment is Deliverable 2's vertical slice — it
may land as the minimal FRR + `setExitCode` subset and grow the RPC seams
incrementally.)

### Increment M4-E — Config two-pass + trust-tier worker default

**Goal:** make config validation honor the boundary and make external tools
worker-by-default.

**Design (config two-pass, per the ADR's Config semantics):**

- *Host coarse pass (pre-fork):* a serializable, manifest-declared structural
  descriptor (JSON-Schema-shaped) validates namespace ownership, top-level block
  presence, unknown keys, and primitive types — WITHOUT importing the tool's Zod
  (Zod schemas are executable code: refinements/transforms/closures). This
  requires adding a `configSchema` structural descriptor to the static manifest.
- *Worker deep pass (post-load):* the tool's real Zod validates semantic
  constraints/cross-field rules after runtime load IN THE WORKER; a failure
  crosses IPC as a tool/config error (`failureClass: 'config-invalid'`), never
  crashing the host.

**Trust tier:** flip the unsafe in-process fallback so it applies to
`'bundled'` only. `OPENSIP_CLI_NO_WORKER` becomes first-party-only by default;
an external tool with no worker is a hard error, not a silent in-host run
(unless a future explicitly-named developer override says so).

**Entry:** config composed host-side; external fallback in-process. **Exit:**
external tool config validates two-pass; external tools never run in-host even
under `OPENSIP_CLI_NO_WORKER`; tests cover a malformed external config failing
at each pass.

### Increment M4-F — Capability + lifecycle RPC

**Goal:** stop importing external runtime for capability registrars and
lifecycle hooks.

**Design:** each external lifecycle hook (`initialize`, `contributeScope`,
`collectReportData`, `sessionReplay`, `fingerprintStrategy`,
`capabilityRegistrars`) becomes one of: a serializable manifest declaration, a
worker-executed call whose effects return over IPC (reuse the M4-D RPC plane),
or a bundled-only host hook. `fingerprintStrategy` in particular is a pure
function over a signal — it can run worker-side and return the fingerprint, or be
declared as a manifest-static strategy key (`'host-default' | 'message-hash' |
'byte-preserved'`) the host already knows how to apply.

**Entry:** host imports external runtime to read hooks. **Exit:** no external
lifecycle hook executes in-host; report/session/capability data flows over RPC
or manifest; tests cover an external tool contributing report data + a capability
domain without a host import.

### Increment M4-G — Capstone guardrail (delete the host import)

**Goal:** the capstone invariant — no `importToolRuntime(...)` for
external-provenance tools in the host process.

**Design:**

1. After M4-D/E/F, the host's only remaining `importToolRuntime` consumers for
   external tools are the discovery/registration legs. Move external runtime
   load entirely behind the worker boundary: discovery reads the manifest
   (static) to register the command shells; the worker imports the runtime when a
   command actually dispatches. The host registry holds manifest-derived command
   descriptors for external tools, not imported `Tool` objects.
2. Tighten `hostRuntimeImportPolicyFor`: remove the `adr0054Transition: true`
   branch so a non-bundled source can no longer produce a host import policy
   (the type makes the external host-import unrepresentable).
3. Update the `host-tool-runtime-import-boundary` fitness check / add a bootstrap
   test asserting `importToolRuntime` is reachable ONLY for `source: 'bundled'`
   in the host, and that the worker-owned dispatch plane is the only path for
   external sources. Make `OPENSIP_CLI_NO_WORKER` first-party-only (M4-E
   completes this).

**Command-shell manifest descriptor (prerequisite, lands with M4-G or just
before):** lift the host-mounted `CommandSpec` shell (`name`, `description`,
`aliases`, `parent`, `commonFlags`, `options`, `args`, `scope`, `output`,
`visibility` — everything EXCEPT the `handler` function) into a serializable
`ToolCommandDescriptor` on the static manifest, so the host can mount an external
tool's commands from the manifest alone (no runtime import). The `handler` stays
worker-owned and loads only at dispatch time.

**Entry:** external runtime still imported in-host at discovery. **Exit:** the
capstone invariant holds and is mechanized; `pnpm fit:ci` enforces it; the ADR's
`enforcement` upgrades from `partially-mechanizable` to `mechanizable` for the
capstone. **LANDED (2026-06-22):** the command-shell descriptor +
`pluginLayout` are serializable on `ToolCommandManifest`; discovery synthesizes a
manifest-derived `Tool` in the host (no import) and imports the runtime only in
the worker; `hostRuntimeImportPolicyFor` is bundled-only (type-enforced);
`workerRuntimeImportPolicyFor` carries the external worker import; the
strengthened fitness check + `host-no-external-runtime-import.test.ts` bootstrap
test mechanize the invariant. The bundled tools' manifests carry the full command
shell, generated from their runtime `commandSpecs` by
`scripts/build-tool-command-manifests.mjs` with a `pnpm tool-manifests:check`
drift gate (in `pnpm lint`), so bundled≡installed parity (the GA acceptance bar)
holds when a bundled package is presented as installed.

### Sequencing summary

```
M4-A provenance threading      ─┐ (no behavior change)
M4-B IPC protocol               ─┤ (types only)
M4-C seam→RPC mapping (shim)    ─┤ (worker shim + host RPC switch)
M4-D supervisor + worker entry  ─┘ → VERTICAL SLICE (Deliverable 2)
M4-E config two-pass + trust tier
M4-F capability + lifecycle RPC
M4-G command-shell descriptor + capstone guardrail  → invariant mechanized
```

A-D are the dispatch plane; E-F remove the remaining host-import consumers; G is
the capstone. Each increment is independently green and never leaves the boundary
half-built. **G has landed (2026-06-22):** external runtimes no longer import
in-host at all — the host synthesizes a manifest-derived `Tool` and the worker is
the only external import path. The named `adr0054Transition` exception is gone
(replaced by the bundled-only host policy + the worker-plane `inDispatchWorker`
policy); the boundary is now the final fault-isolation boundary, mechanized by the
fitness check + bootstrap test.
