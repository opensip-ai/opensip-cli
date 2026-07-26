/**
 * Plugin, capability and host-wiring error definitions (Plan 01 Wave 1).
 *
 * Two distinct audiences share this file, and the axes differ accordingly:
 *
 * - **Plugin admission** (`PLUGIN.*`, `CAPABILITY.*`, `SYSTEM.PLUGINS.*`) — a third-party
 *   pack shipped something the host will not admit. `tool-author` responsibility, `public`
 *   exposure, `plugin-incompatible` exit: the pack author must read what is wrong.
 * - **Host wiring invariants** (`SYSTEM.SCOPE.*`, `CORE.CAPABILITY.REGISTRAR_NOT_WIRED`,
 *   `SYSTEM.IMPACT.*`) — the composition root failed to wire itself. Nobody outside this
 *   repository can act on those, so they keep `tool-author` / `redacted` and say so.
 */

import type { ErrorDefinition } from '../../error-definition.js';

/**
 * Plugin-admission cluster: a third-party pack shipped something the host will not admit.
 * The pack author is the only one who can act, and they must be able to read what is wrong.
 */
const PLUGIN_ADMISSION = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'plugin-incompatible',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'kind' | 'operatorAction'>;

/**
 * Host-wiring cluster: the composition root failed to wire itself. Nobody outside this
 * repository can act on these, so they stay `redacted` and say "report a bug" honestly
 * rather than pretending the operator has a fix.
 */
const HOST_WIRING_INVARIANT = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  kind: 'invariant',
  retry: 'never',
  severity: 'error',
  exposure: 'redacted',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const pluginCapabilityDefinitions = {
  /**
   * A plugin's error-catalog contribution is malformed or hostile.
   *
   * Covers all ten admission rejections in `tools/error-catalog.ts` — accessor property,
   * missing contribution, non-plain-object, unsupported schema version, bad owner, and the
   * inspection failure in the catch. One code per D9: the branch travels in
   * `metadata.condition`, because the ten rejections have one audience and one fix
   * ("correct the catalog you shipped").
   */
  'CORE.ERROR_CATALOG.INVALID': {
    ...PLUGIN_ADMISSION,
    code: 'CORE.ERROR_CATALOG.INVALID',
    kind: 'validation',
    operatorAction:
      "Correct the tool's errorCatalog contribution: it must be a plain data object at the supported schema version, owned by the contributing tool.",
    publicMetadataKeys: ['condition', 'field'],
  },

  /**
   * Two owners claim one error code.
   *
   * Detected on a provisional aggregate before the tool is committed to the registry, and
   * re-thrown on every subsequent read so a collision can never be swallowed by the cache.
   * `conflict` kind: neither catalog is malformed, they simply cannot coexist.
   */
  'CORE.ERROR_CATALOG.COLLISION': {
    ...PLUGIN_ADMISSION,
    code: 'CORE.ERROR_CATALOG.COLLISION',
    kind: 'conflict',
    operatorAction:
      'Two tools declare the same error code. Uninstall one, or ask its author to move the code under a namespace the tool owns.',
    publicMetadataKeys: ['code', 'owners'],
  },

  /**
   * A tool's fingerprint strategy threw, or returned a value that is not a fingerprint.
   *
   * `stampFingerprints` calls third-party code once per un-stamped signal inside a
   * host-owned post-pass that every tool's envelope construction runs through, previously
   * with no isolation and no return-type check. A strategy that throws must not take the
   * run's findings with it (ruling D7) — hence `warning` severity and a `success` exit
   * class: the signals are still credible, they are merely un-stamped, and the baseline
   * ratchet degrades rather than the scan failing.
   */
  'CORE.FINGERPRINT_STRATEGY.STAMP_FAILED': {
    code: 'CORE.FINGERPRINT_STRATEGY.STAMP_FAILED',
    source: 'application',
    defaultResponsibility: 'tool-author',
    kind: 'invariant',
    retry: 'never',
    severity: 'warning',
    exposure: 'public',
    exitClass: 'success',
    operatorAction:
      "The tool's fingerprint strategy failed; findings are reported without fingerprints and the baseline ratchet is degraded for this run. Report it to the tool author.",
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['condition', 'strategyId'],
  },

  /**
   * A capability pack exported the wrong shape for a declared contribution.
   *
   * The same condition is already handled conformantly one module over, where
   * `capability-export-reader` emits a structured `capability.discovery.bad_export`
   * diagnostic — this path threw a bare `TypeError` instead.
   */
  'CORE.CONTRIBUTION.SCHEMA_MISMATCH': {
    ...PLUGIN_ADMISSION,
    code: 'CORE.CONTRIBUTION.SCHEMA_MISMATCH',
    kind: 'validation',
    operatorAction:
      'Export the capability contribution in the documented shape (an array for list-valued contributions).',
    publicMetadataKeys: ['condition', 'exportName'],
  },

  /**
   * A filesystem probe during plugin discovery failed for a reason other than "absent".
   *
   * The systemic gap of this package: `existsSync` and friends swallow every errno to
   * `false`, so under `EACCES` or `EMFILE` a discovery walk reports **zero** tools, checks
   * or scenarios instead of failing — a silently shrinking analyzed surface with no
   * diagnostic at any level. `warning` severity because discovery degrades rather than
   * aborting, but it must be visible (D7).
   */
  'CORE.PLUGINS.FS_PROBE_FAILED': {
    code: 'CORE.PLUGINS.FS_PROBE_FAILED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'I/O',
    retry: 'caller-policy',
    severity: 'warning',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'A plugin discovery path could not be read, so some plugins may be missing from this run. Check the reported errno and the permissions on the named directory.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['errno', 'condition'],
  },

  /**
   * A pack listed as required could not be loaded.
   *
   * Previously `throw new ErrorCtor(...)` where the constructor defaulted to `TypeError`, so
   * an unresolvable entry point crossed the boundary untyped and `normalizeFailure` could
   * only call it `CORE.SYSTEM.UNKNOWN_FAILURE` — severity fatal, exposure operator-only.
   */
  'CORE.PLUGINS.REQUIRED_PACK_LOAD_FAILED': {
    ...PLUGIN_ADMISSION,
    code: 'CORE.PLUGINS.REQUIRED_PACK_LOAD_FAILED',
    kind: 'compatibility',
    operatorAction:
      'A required pack has no readable entry point. Reinstall the package, or remove it from the plugins list.',
    publicMetadataKeys: ['condition', 'packageName'],
  },

  /**
   * A pack's declared entry point resolves outside its own package directory.
   *
   * `security` kind: this is a containment check. The npm leg of the same resolver already
   * performs it; the authored-sidecar leg did not, which is the asymmetry the ledger flagged.
   */
  'CORE.PLUGINS.ENTRY_ESCAPES_PACKAGE': {
    ...PLUGIN_ADMISSION,
    code: 'CORE.PLUGINS.ENTRY_ESCAPES_PACKAGE',
    kind: 'security',
    operatorAction:
      "Point the pack's entry field at a file inside its own package directory; entries that escape the package are refused.",
    publicMetadataKeys: ['condition', 'packageName'],
  },

  /**
   * A manifest-declared capability domain has no real registrar wired.
   *
   * Throwing rather than dropping the contribution is right — a silently discarded
   * capability is worse than a loud refusal — but the condition deserved its own subcode
   * instead of the bare `SYSTEM_ERROR` default it had.
   */
  'CORE.CAPABILITY.REGISTRAR_NOT_WIRED': {
    ...HOST_WIRING_INVARIANT,
    code: 'CORE.CAPABILITY.REGISTRAR_NOT_WIRED',
    operatorAction:
      'The tool that declares this capability domain never wired its registrar. Report it to the tool author with the run id.',
    publicMetadataKeys: ['domain'],
  },

  /** Code that requires a `RunScope` ran outside one — a host composition-root wiring bug. */
  'CORE.SCOPE.NOT_ENTERED': {
    ...HOST_WIRING_INVARIANT,
    code: 'CORE.SCOPE.NOT_ENTERED',
    operatorAction:
      'This code path requires an entered RunScope. Capture the run id and report a bug.',
  },

  /** `scope.capabilities` was absent where the bootstrap contract requires it. */
  'CORE.SCOPE.CAPABILITIES_MISSING': {
    ...HOST_WIRING_INVARIANT,
    code: 'CORE.SCOPE.CAPABILITIES_MISSING',
    operatorAction:
      'The RunScope was constructed without capabilities. Capture the run id and report a bug.',
  },

  /**
   * A reusable impact index was paired with a catalog of a different generation.
   *
   * An internal invariant, so the exit-class stakes are low — but it was a native `Error`
   * subclass with no definition and no structural brand, invisible to both the detector and
   * `normalizeFailure`.
   */
  'CORE.IMPACT.INDEX_GENERATION_MISMATCH': {
    ...HOST_WIRING_INVARIANT,
    code: 'CORE.IMPACT.INDEX_GENERATION_MISMATCH',
    operatorAction:
      'The impact index does not match the graph catalog generation. Rebuild the graph and retry.',
  },

  /**
   * A worker process could not be spawned.
   *
   * [D14] The ledger records the *existing* synchronous catch as unreachable — `fork`
   * reports `EMFILE` / `EPERM` / a bad exec path asynchronously via the child `error` event.
   * The definition is registered here so the asynchronous path (Task 1.8) has a real code to
   * carry; the unreachable synchronous arm is removed rather than left as decoration.
   */
  'CORE.WORKER.SPAWN_FAILED': {
    code: 'CORE.WORKER.SPAWN_FAILED',
    source: 'infrastructure',
    defaultResponsibility: 'environment',
    kind: 'resource',
    retry: 'caller-policy',
    severity: 'error',
    exposure: 'public',
    exitClass: 'runtime',
    operatorAction:
      'A worker process could not be started. Check the reported errno, process limits, and available memory, then retry.',
    stability: 'public',
    lifecycle: 'active',
    publicMetadataKeys: ['errno', 'condition'],
  },
  /**
   * A tool tried to overwrite an existing `RunScope` key.
   *
   * The guard tests `key in scope`, not own-property, so prototype members like `dispose` are
   * protected from shadowing too — a tool cannot capture the scope by redefining a method.
   */
  'CORE.SCOPE_CONTRIBUTION.COLLISION': {
    ...PLUGIN_ADMISSION,
    code: 'CORE.SCOPE_CONTRIBUTION.COLLISION',
    kind: 'conflict',
    operatorAction:
      'Rename the scope contribution; a tool may not overwrite a key the host or another tool already owns.',
    publicMetadataKeys: ['key'],
  },

  /** A tool tried to contribute a scope key the host reserves. */
  'CORE.SCOPE_CONTRIBUTION.FORBIDDEN_KEY': {
    ...PLUGIN_ADMISSION,
    code: 'CORE.SCOPE_CONTRIBUTION.FORBIDDEN_KEY',
    kind: 'security',
    operatorAction: 'Choose a scope contribution key outside the host-reserved namespace.',
    publicMetadataKeys: ['key'],
  },

  /** A tool's scope contribution is not a usable shape. */
  'CORE.SCOPE_CONTRIBUTION.INVALID': {
    ...PLUGIN_ADMISSION,
    code: 'CORE.SCOPE_CONTRIBUTION.INVALID',
    kind: 'validation',
    operatorAction: 'Contribute scope values as plain data; see the tool contract for the shape.',
    publicMetadataKeys: ['key'],
  },
  /**
   * `enterScope` was called while a different scope was already current.
   *
   * A host wiring bug: concurrent or nested work must use `runWithScope(scope, fn)`, which
   * scopes the value to one async context, rather than a shared `enterScope` that would let
   * two commands observe each other's run state.
   */
  'CORE.SCOPE.REENTRANT': {
    ...HOST_WIRING_INVARIANT,
    code: 'CORE.SCOPE.REENTRANT',
    operatorAction:
      'Use runWithScope(scope, fn) for nested or concurrent work. Capture the run id and report a bug.',
  },
  /**
   * A recipe selector arm is unusable: an unknown arm type, or an arm that needs a `match`
   * matcher and was given none.
   *
   * One code for both (D9) — a recipe author fixes either the same way, in the same file, and
   * `metadata.condition` says which. `redacted`: the message quotes the author's selector, and
   * no end user can act on it.
   */
  'CORE.SELECTOR.INVALID': {
    ...HOST_WIRING_INVARIANT,
    code: 'CORE.SELECTOR.INVALID',
    operatorAction:
      'Correct the recipe selector: use a known arm type, and supply a `match` matcher for arms that require one.',
    publicMetadataKeys: ['condition', 'arm'],
  },
} as const satisfies Record<string, Omit<ErrorDefinition, 'owner'>>;
