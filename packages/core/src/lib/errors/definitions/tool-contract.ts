/**
 * Tool-contract admission error definitions (Plan 01 Wave 1).
 *
 * This group carries the wave's single most damaging demotion. Seventeen `TOOL.IDENTITY.*`
 * code literals across `tools/identity.ts`, `tools/define-tool.ts` and `tools/identity-index.ts`
 * use the head `TOOL`, which `legacyFamilyCode` does not map — so `definitionFromLegacyCode`
 * sends every one of them to `CORE.SYSTEM.UNKNOWN_FAILURE`: severity `fatal`, exposure
 * `operator-only`, responsibility `unknown`, action "capture the run id and report a bug".
 * A tool author's malformed manifest was therefore reported as an internal invariant, and
 * `buildToolIdentityIndex` runs during host bootstrap, so a name collision between two
 * installed tools aborted the whole CLI as an operator-only fatal.
 *
 * Per ruling D11 the fix is registration under a mapped head, never adding `TOOL` to the
 * `legacyFamilyCode` switch. All of these are `tool-author` responsibility with `public`
 * exposure: the author needs to read what is wrong with their manifest.
 */

import type { ErrorDefinition } from '../../error-definition.js';

/** Shared axes for tool-authoring rejections: the author reads it, the author fixes it. */
const TOOL_AUTHORING = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  kind: 'validation',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'plugin-incompatible',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const toolContractDefinitions = {
  /** A tool name, alias, or layout key is not kebab-case. Highest-frequency identity check. */
  'CORE.TOOL_IDENTITY.INVALID_NAME': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.INVALID_NAME',
    operatorAction:
      'Rename the tool identity value to kebab-case (lowercase letters, digits, and single hyphens).',
    publicMetadataKeys: ['field', 'value'],
  },

  /**
   * Two installed tools claim the same name or alias.
   *
   * Runs during host bootstrap, so this used to abort the entire CLI with an operator-only
   * fatal that named neither tool. `public` exposure and the two owning package names are
   * what make it fixable.
   */
  'CORE.TOOL_IDENTITY.CONFLICT': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.CONFLICT',
    operatorAction:
      'Two installed tools claim the same name or alias. Uninstall one, or ask its author to rename it.',
    publicMetadataKeys: ['field', 'value'],
  },

  /** A subcommand's declared parent does not match the tool that registered it. */
  'CORE.TOOL_IDENTITY.PARENT_MISMATCH': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.PARENT_MISMATCH',
    operatorAction:
      'Set the command parent to the tool that declares it, or move the command to the declared parent tool.',
    publicMetadataKeys: ['field', 'value'],
  },

  /** A registered tool has no `identity` block at all. */
  'CORE.TOOL_IDENTITY.REQUIRED': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.REQUIRED',
    operatorAction:
      'Add an `identity` block to the tool definition; it is the single source of truth for the tool name and aliases.',
    publicMetadataKeys: ['field'],
  },

  /**
   * The shipped manifest disagrees with the runtime tool.
   *
   * The old site passed **no** code at all, so every drift collapsed to the generic
   * `VALIDATION_ERROR` and an operator could not tell an id mismatch from an alias mismatch
   * from a command-set mismatch. `field` is allowlisted precisely to restore that.
   */
  'CORE.TOOL_MANIFEST.DRIFT': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_MANIFEST.DRIFT',
    operatorAction:
      'Regenerate the tool manifest so it matches the runtime tool definition, then reinstall the tool.',
    publicMetadataKeys: ['field', 'expected', 'actual'],
  },

  /** A command spec is not an object — the entry guard of untrusted spec admission. */
  'CORE.COMMAND_SPEC.NOT_AN_OBJECT': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_SPEC.NOT_AN_OBJECT',
    operatorAction: 'Pass a plain object to defineCommand.',
  },

  /** A command spec has no usable `name`. Runs before a name exists to quote. */
  'CORE.COMMAND_SPEC.MISSING_NAME': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_SPEC.MISSING_NAME',
    operatorAction: 'Give the command spec a non-empty `name`.',
  },

  /**
   * A command spec declares an accessor property.
   *
   * A hostile-plugin guard: refusing accessors is what guarantees no getter runs during
   * admission. It surfaced as an untyped `TypeError`, which normalizes to `runtime` rather
   * than to a plugin-compatibility rejection.
   */
  'CORE.COMMAND_SPEC.ACCESSOR_REJECTED': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_SPEC.ACCESSOR_REJECTED',
    operatorAction:
      'Declare command spec fields as plain data properties; getters and setters are rejected during admission.',
    publicMetadataKeys: ['field'],
  },

  /**
   * A runtime command inventory declares itself incomplete but gives no reason.
   *
   * The documented contract says reasons are required when incomplete; admitting
   * `{ complete: false, reasons: [] }` is how MCP came to report an incomplete inventory
   * whose cause was unrecoverable.
   */
  'CORE.COMMAND_INVENTORY.INCOMPLETE_WITHOUT_REASON': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_INVENTORY.INCOMPLETE_WITHOUT_REASON',
    operatorAction:
      'Supply at least one reason code whenever a runtime command inventory reports incomplete or partial coverage.',
  },

  /**
   * A leaf's `packageIdentity` is unbounded or malformed.
   *
   * The bound was gated on `leaf.owner === 'tool'`, so a leaf self-declaring `owner: 'host'`
   * carried an arbitrary identity into the frozen inventory and out to MCP evidence.
   * Validation keyed on a self-declared discriminator is the shape this code retires.
   */
  'CORE.COMMAND_INVENTORY.PACKAGE_IDENTITY_INVALID': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_INVENTORY.PACKAGE_IDENTITY_INVALID',
    operatorAction:
      'Supply a bounded, well-formed package identity on every command inventory leaf, regardless of its declared owner.',
    publicMetadataKeys: ['field'],
  },

  /** A leaf's `provenanceSource` is unbounded, unsafe, or carries control characters. */
  'CORE.COMMAND_INVENTORY.PROVENANCE_SOURCE_INVALID': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_INVENTORY.PROVENANCE_SOURCE_INVALID',
    operatorAction:
      'Supply a bounded provenance source name containing no control characters on every command inventory leaf.',
    publicMetadataKeys: ['field'],
  },

  /** A command inventory is structurally invalid and cannot be frozen. */
  'CORE.COMMAND_INVENTORY.INVALID': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_INVENTORY.INVALID',
    operatorAction:
      'Correct the runtime command inventory shape; see the named field in the message.',
    publicMetadataKeys: ['field', 'condition'],
  },

  /** Two inventory leaves claim the same command path. */
  'CORE.COMMAND_INVENTORY.DUPLICATE_PATH': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_INVENTORY.DUPLICATE_PATH',
    operatorAction: 'Give each command inventory leaf a distinct command path.',
    publicMetadataKeys: ['field', 'value', 'condition'],
  },

  /** A leaf claims a static handler it is not entitled to claim. */
  'CORE.COMMAND_INVENTORY.HANDLER_CLAIM_INVALID': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_INVENTORY.HANDLER_CLAIM_INVALID',
    operatorAction:
      'Only claim a static handler from the package that declares it; correct the leaf handler claim.',
    publicMetadataKeys: ['field', 'value', 'condition'],
  },

  /**
   * The command inventory exceeds its bound.
   *
   * `resource` rather than `validation`: the bound is an anti-DoS work limit over untrusted
   * plugin input, so the honest axis is exhaustion.
   */
  'CORE.COMMAND_INVENTORY.LIMIT_EXCEEDED': {
    ...TOOL_AUTHORING,
    code: 'CORE.COMMAND_INVENTORY.LIMIT_EXCEEDED',
    kind: 'resource',
    operatorAction:
      'Reduce the number of declared commands, or split them across tools; the inventory bound protects host bootstrap.',
    publicMetadataKeys: ['bound', 'condition'],
  },

  /**
   * A registry rejected a duplicate id under its `throw` duplicate policy.
   *
   * Used by the fitness and simulation recipe registries. `user` responsibility, because
   * project-local recipes and checks are user-authored — a duplicate is something the user
   * can see and fix in their own `opensip-cli/` directory.
   */
  'CORE.REGISTRY.DUPLICATE': {
    ...TOOL_AUTHORING,
    code: 'CORE.REGISTRY.DUPLICATE',
    defaultResponsibility: 'user',
    exitClass: 'configuration',
    operatorAction:
      'Two entries share one id. Rename or remove the duplicate named in the message, then re-run.',
    publicMetadataKeys: ['field', 'value'],
  },

  /**
   * Two registry entries collide on name across tools, languages, checks, recipes or targets.
   *
   * The default code was a legacy-grammar dotted subcode inheriting `VALIDATION_ERROR` axes
   * only through the family fallback.
   */
  'CORE.REGISTRY.NAME_COLLISION': {
    ...TOOL_AUTHORING,
    code: 'CORE.REGISTRY.NAME_COLLISION',
    defaultResponsibility: 'user',
    exitClass: 'configuration',
    operatorAction:
      'Two entries claim the same name. Rename one of the entries named in the message, then re-run.',
    publicMetadataKeys: ['field', 'value'],
  },

  /**
   * A persisted task-context manifest failed schema validation.
   *
   * `parseTaskContextManifest` was a bare `schema.parse(value)`, so a third-party `ZodError`
   * escaped the public contracts boundary on every invalid manifest. This is the read-back
   * path for persisted evidence (suite / MCP replay), i.e. data that has already been on
   * disk — `environment` responsibility, because the user did not hand-author it.
   */
  'CORE.TASK_CONTEXT.MANIFEST_INVALID': {
    ...TOOL_AUTHORING,
    code: 'CORE.TASK_CONTEXT.MANIFEST_INVALID',
    defaultResponsibility: 'environment',
    exitClass: 'runtime',
    operatorAction:
      'The stored task-context manifest is not readable by this version. Re-run the tool that produced it to regenerate the evidence.',
    publicMetadataKeys: ['field'],
  },
  /** Two aliases on one tool are the same string. */
  'CORE.TOOL_IDENTITY.DUPLICATE_ALIAS': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.DUPLICATE_ALIAS',
    operatorAction: 'Remove the repeated alias; each alias must appear once.',
    publicMetadataKeys: ['field', 'value'],
  },

  /** A tool lists its own name among its aliases. */
  'CORE.TOOL_IDENTITY.NAME_IN_ALIASES': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.NAME_IN_ALIASES',
    operatorAction: 'Remove the tool name from its own alias list; the name is already reserved.',
    publicMetadataKeys: ['field', 'value'],
  },

  /** The shipped alias set disagrees with the runtime identity's aliases. */
  'CORE.TOOL_IDENTITY.ALIAS_DRIFT': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.ALIAS_DRIFT',
    operatorAction:
      'Regenerate the tool manifest so its aliases match the runtime identity, then reinstall.',
    publicMetadataKeys: ['field', 'expected', 'actual'],
  },

  /** A subcommand was declared without the primary command that owns it. */
  'CORE.TOOL_IDENTITY.PRIMARY_REQUIRED': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.PRIMARY_REQUIRED',
    operatorAction: 'Declare the primary command before declaring subcommands under it.',
    publicMetadataKeys: ['field'],
  },

  /**
   * A tool claimed a namespace, layout domain, or session-tool role the host reserves.
   *
   * `security` kind: the namespace boundary is what stops one tool impersonating the host or
   * another tool. One code for the three refusals (D9) — same audience, same fix, and the
   * specific reservation travels in `metadata.field`.
   */
  'CORE.TOOL_IDENTITY.RESERVED': {
    ...TOOL_AUTHORING,
    code: 'CORE.TOOL_IDENTITY.RESERVED',
    kind: 'security',
    operatorAction:
      'Choose a name, namespace, or layout domain outside the host-reserved set; the reserved value is named in the message.',
    publicMetadataKeys: ['field', 'value'],
  },
  /**
   * The agent catalog cannot be assembled honestly: the runtime command inventory is
   * incomplete, a tool overlay is stale, or an entry point is internal-only.
   *
   * `redacted` and `tool-author`: the agent catalog is the machine discovery surface, and every
   * one of these means the HOST assembled something it should not publish. Serving a catalog
   * that silently omits commands is worse than refusing — an agent would treat the gap as
   * "this tool has no such command" rather than "ask again".
   *
   * One code (D9); `metadata.condition` names which of the three.
   */
  'CORE.AGENT_CATALOG.UNPUBLISHABLE': {
    ...TOOL_AUTHORING,
    code: 'CORE.AGENT_CATALOG.UNPUBLISHABLE',
    kind: 'invariant',
    exposure: 'redacted',
    exitClass: 'runtime',
    operatorAction:
      'The agent catalog could not be assembled completely. Capture the run id and report a bug; re-running after a full `opensip graph` may clear a stale overlay.',
    publicMetadataKeys: ['condition'],
  },
} as const satisfies Record<string, Omit<ErrorDefinition, 'owner'>>;
