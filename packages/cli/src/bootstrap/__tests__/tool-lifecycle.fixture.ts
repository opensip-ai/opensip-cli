/**
 * tool-lifecycle — the NAMED, ordered tool-admission lifecycle (release
 * launch, §5.4). A thin sequencer/driver that documents + orders the existing
 * bootstrap calls into one canonical sequence, rather than re-architecting the
 * individual hooks (which keep their own homes and contracts).
 *
 * The 10 steps span two temporal phases of a CLI invocation:
 *
 *   ── STARTUP (once per process, composition root) ──────────────────────────
 *   1. DISCOVER  — enumerate tool sources: bundled first-party
 *      ({@link registerFirstPartyTools}) + on-disk packages
 *      ({@link discoverAndRegisterToolPackages} via
 *      `discoverToolPackagesFromAnchors`).
 *   2. COMPAT    — run each candidate's static `package.json#opensipTools`
 *      manifest through the `admitTool` compatibility gate. Bundled = fail-
 *      closed; installed = best-effort skip; project-local = trust-gated.
 *   3. TRUST     — deny-by-default trust check for project-local executable
 *      tools (`admitProjectLocalTool`), BEFORE any module import.
 *   4. IMPORT    — dynamic-`import()` an admitted installed/project-local
 *      package's entry, then VALIDATE the exported `tool` shape
 *      (`isValidTool`) and REGISTER it into the `ToolRegistry`
 *      (first-writer-wins). Steps 1-4 all complete inside {@link bootstrapCli}.
 *   8. MOUNT     — walk the registry and mount each tool's declared
 *      `commandSpecs` ({@link mountAllToolCommands}). Provenance stops mattering
 *      here, so bundled and installed tools share the identical mount path.
 *
 *   ── PER-RUN (per invocation, pre-action hook) ─────────────────────────────
 *   5. CONFIG    — compose every tool's `config` Zod block into one strict
 *      whole-document schema and validate the config file once
 *      (`composeAndValidateToolConfig`).
 *   6. SCOPE     — each tool contributes its per-run subscope
 *      (`tool.contributeScope()`); the kernel `Object.assign`s it onto the
 *      `RunScope` before `enterScope`.
 *   7. CAPABILITIES — wire the per-run capability registry: register each
 *      manifest's declared domains, then replace the deferred placeholder with
 *      the owning tool's real registrar (`wireCapabilityRegistry`).
 *   9. INITIALIZE — lazy, memoized `tool.initialize()` for the tool owning the
 *      invoked subcommand, exactly once per process, after `enterScope`
 *      (`maybeInitializeOwningTool`).
 *   10. DISPATCH — Commander invokes the command's action body; the
 *       `mountCommandSpec` pipeline (parse → handler → dispatch → error → exit)
 *       runs the tool's handler.
 *
 * Steps 5-7, 9, 10 are inherently per-invocation (they read the entered
 * `RunScope`) and live in `pre-action-hook.ts`; this module does NOT move them
 * — it names them so the full lifecycle has one documented source of truth and
 * drives the contiguous STARTUP steps (discover→…→register, then mount) through
 * one ordered entry point. The driver is intentionally THIN: it sequences the
 * pre-existing helpers, it does not reimplement them.
 */

/**
 * Canonical, ordered tool-lifecycle steps (launch, §5.4). The numeric
 * values are the step ordinals used in the JSDoc above and in
 * lifecycle-ordering tests; the string keys name each step. This is the single
 * source of truth for the sequence — a test asserts the STARTUP driver fires
 * its steps in this order.
 */
export const TOOL_LIFECYCLE_STEPS = {
  /** 1 — enumerate bundled + on-disk tool sources. */
  discover: 1,
  /** 2 — `admitTool` compatibility gate over the static manifest. */
  compat: 2,
  /** 3 — deny-by-default trust check for project-local executable tools. */
  trust: 3,
  /** 4 — import an admitted package, validate its shape, register it. */
  import: 4,
  /** 5 — compose + strict-validate every tool's config block. */
  config: 5,
  /** 6 — each tool contributes its per-run subscope. */
  scope: 6,
  /** 7 — wire the per-run capability registry (manifest domains → registrars). */
  capabilities: 7,
  /** 8 — mount each tool's declared commandSpecs. */
  mount: 8,
  /** 9 — lazy, memoized initialize() for the invoked subcommand's owner. */
  initialize: 9,
  /** 10 — Commander dispatches the action body through the mount pipeline. */
  dispatch: 10,
} as const;
