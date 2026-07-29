/**
 * Per-run plain command inventory (MCP audit evidence Phase 4).
 *
 * Captures the complete host + Tool declarative command surface as immutable
 * data on {@link RunScope} so MCP runtime wiring never retains live
 * `CommandSpec` handlers, Commander objects, or CLI context closures.
 *
 * Domain-neutral: core does not import contracts, MCP, or CLI.
 */

import { isPlainRecord } from '../lib/json-guards.js';

import {
  commandInventoryDuplicate,
  commandInventoryHandlerClaim,
  commandInventoryInvalid,
  commandInventoryLimitExceeded,
} from './command-inventory-error.js';
import {
  freezeStaticHandlerDescriptor,
  isSafeProjectRelativePosixPath,
  staticHandlerValidationError,
} from './command-spec-validate.js';
import {
  MAX_STATIC_HANDLER_DECLARATION,
  MAX_STATIC_HANDLER_PACKAGE,
  type StaticHandlerDescriptor,
} from './command-spec.js';

/** Inventory schema version — bump when leaf/group shape changes. */
export const RUNTIME_COMMAND_INVENTORY_VERSION = 1 as const;

/** Production cap: command leaves with handlers. */
export const MAX_RUNTIME_COMMAND_LEAVES = 2000;
/** Production cap: action-less groups (sessions, tools, suite containers). */
export const MAX_RUNTIME_COMMAND_GROUPS = 1000;
/** Production cap: aliases per command leaf. */
export const MAX_RUNTIME_COMMAND_ALIASES = 16;
/** Max characters for name / alias / owner label fields. */
export const MAX_RUNTIME_COMMAND_NAME = 256;
/** Max characters for a full canonical command path. */
export const MAX_RUNTIME_COMMAND_PATH = 1024;

/**
 * Immutable limits object for pure inventory validation.
 * Production passes the exported constants; unit tests inject small bounds.
 */
export interface RuntimeCommandInventoryLimits {
  readonly maxLeaves: number;
  readonly maxGroups: number;
  readonly maxAliases: number;
  readonly maxName: number;
  readonly maxPath: number;
}

/** Default production limits (frozen). */
export const DEFAULT_RUNTIME_COMMAND_INVENTORY_LIMITS: Readonly<RuntimeCommandInventoryLimits> =
  Object.freeze({
    maxLeaves: MAX_RUNTIME_COMMAND_LEAVES,
    maxGroups: MAX_RUNTIME_COMMAND_GROUPS,
    maxAliases: MAX_RUNTIME_COMMAND_ALIASES,
    maxName: MAX_RUNTIME_COMMAND_NAME,
    maxPath: MAX_RUNTIME_COMMAND_PATH,
  });

/** Who owns a command surface entry. */
export type RuntimeCommandOwner = 'host' | 'tool';

/**
 * One mounted command leaf (has a handler path) as plain data.
 * No functions, Commander objects, options parsers, or closures.
 */
export interface RuntimeCommandLeaf {
  /** Stable full path as Commander mounts it (e.g. `fit list`, `graph`, `tools install`). */
  readonly path: string;
  /** Primary command name segment. */
  readonly name: string;
  /** Alternate names. */
  readonly aliases: readonly string[];
  readonly owner: RuntimeCommandOwner;
  /** Tool canonical name when owner is `tool`; host label when owner is `host`. */
  readonly ownerLabel: string;
  readonly visibility: 'public' | 'internal';
  readonly scope: 'project' | 'none';
  readonly output: string;
  /** Admitted provenance source when applicable (bundled/installed/…). */
  readonly provenanceSource?: string;
  /** Admitted plugin package identity when applicable. */
  readonly packageIdentity?: string;
  /** Optional author-declared static handler claim. */
  readonly staticHandler?: StaticHandlerDescriptor;
}

/** Action-less command group (container without a leaf handler). */
export interface RuntimeCommandGroup {
  readonly path: string;
  readonly name: string;
  readonly owner: RuntimeCommandOwner;
  readonly ownerLabel: string;
  readonly visibility: 'public' | 'internal';
}

/**
 * Complete plain per-run command inventory.
 * `complete: false` means third-party/host facts were intentionally omitted.
 */
export interface RuntimeCommandInventory {
  readonly version: typeof RUNTIME_COMMAND_INVENTORY_VERSION;
  readonly complete: boolean;
  readonly leaves: readonly RuntimeCommandLeaf[];
  readonly groups: readonly RuntimeCommandGroup[];
  /** Stable reason codes when incomplete or partial. */
  readonly reasons: readonly string[];
}

/** Empty default inventory (always complete within the empty set). */
export const EMPTY_RUNTIME_COMMAND_INVENTORY: RuntimeCommandInventory = Object.freeze({
  version: RUNTIME_COMMAND_INVENTORY_VERSION,
  complete: true,
  leaves: Object.freeze([] as RuntimeCommandLeaf[]),
  groups: Object.freeze([] as RuntimeCommandGroup[]),
  reasons: Object.freeze([] as string[]),
});

function isSafeName(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
}

function isSafePath(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
}

/**
 * Validate and freeze a runtime command inventory.
 * Rejects N+1 counts, duplicate paths, invalid owner pairs, and text overflow.
 * Does not slice identities — fails closed on overflow.
 *
 * @throws {Error} When leaf/group counts exceed limits, paths duplicate, or text is invalid.
 * @throws {TypeError} When a leaf is not a plain object.
 */
export function createRuntimeCommandInventory(
  input: {
    readonly complete?: boolean;
    readonly leaves?: readonly RuntimeCommandLeaf[];
    readonly groups?: readonly RuntimeCommandGroup[];
    readonly reasons?: readonly string[];
  },
  limits: RuntimeCommandInventoryLimits = DEFAULT_RUNTIME_COMMAND_INVENTORY_LIMITS,
): RuntimeCommandInventory {
  const leaves = input.leaves ?? [];
  const groups = input.groups ?? [];
  const reasons = input.reasons ?? [];
  const complete = input.complete ?? true;

  if (leaves.length > limits.maxLeaves) {
    throw commandInventoryLimitExceeded(
      'max-leaves',
      `runtime command inventory exceeds maxLeaves (${String(limits.maxLeaves)}); got ${String(leaves.length)}.`,
      limits.maxLeaves,
    );
  }
  if (groups.length > limits.maxGroups) {
    throw commandInventoryLimitExceeded(
      'max-groups',
      `runtime command inventory exceeds maxGroups (${String(limits.maxGroups)}); got ${String(groups.length)}.`,
      limits.maxGroups,
    );
  }

  const paths = new Set<string>();
  const frozenLeaves: RuntimeCommandLeaf[] = [];
  for (const leaf of leaves) {
    validateLeaf(leaf, limits, paths);
    frozenLeaves.push(freezeLeaf(leaf));
  }
  const frozenGroups: RuntimeCommandGroup[] = [];
  for (const group of groups) {
    validateGroup(group, limits, paths);
    frozenGroups.push(
      Object.freeze({
        path: group.path,
        name: group.name,
        owner: group.owner,
        ownerLabel: group.ownerLabel,
        visibility: group.visibility,
      }),
    );
  }

  for (const reason of reasons) {
    if (typeof reason !== 'string' || !isSafeName(reason, limits.maxName)) {
      throw commandInventoryInvalid(
        'reason-string',
        'runtime command inventory reason must be a bounded non-empty string.',
        'reasons',
      );
    }
  }

  return Object.freeze({
    version: RUNTIME_COMMAND_INVENTORY_VERSION,
    complete,
    leaves: Object.freeze(frozenLeaves),
    groups: Object.freeze(frozenGroups),
    reasons: Object.freeze([...reasons]),
  });
}

/**
 * @throws {Error} When path/name/owner/scope/output/aliases/handler claims are invalid.
 * @throws {TypeError} When the leaf is not a plain object.
 */
function validateLeaf(
  leaf: RuntimeCommandLeaf,
  limits: RuntimeCommandInventoryLimits,
  paths: Set<string>,
): void {
  if (!isPlainRecord(leaf)) {
    throw new TypeError('runtime command leaf must be a plain object.');
  }
  if (!isSafePath(leaf.path, limits.maxPath)) {
    throw commandInventoryInvalid(
      'leaf-path',
      `runtime command leaf path invalid or overlong: '${leaf.path}'.`,
      'path',
    );
  }
  if (paths.has(leaf.path)) {
    throw commandInventoryDuplicate(
      'leaf-path',
      `runtime command inventory duplicate path '${leaf.path}'.`,
      leaf.path,
    );
  }
  paths.add(leaf.path);
  if (!isSafeName(leaf.name, limits.maxName)) {
    throw commandInventoryInvalid(
      'leaf-name',
      `runtime command leaf name invalid: '${leaf.name}'.`,
      'name',
    );
  }
  if (leaf.owner !== 'host' && leaf.owner !== 'tool') {
    throw commandInventoryInvalid(
      'leaf-owner',
      `runtime command leaf owner must be host|tool; got '${String(leaf.owner)}'.`,
      'owner',
    );
  }
  if (!isSafeName(leaf.ownerLabel, limits.maxName)) {
    throw commandInventoryInvalid(
      'leaf-owner-label',
      `runtime command leaf ownerLabel invalid: '${leaf.ownerLabel}'.`,
      'ownerLabel',
    );
  }
  if (leaf.visibility !== 'public' && leaf.visibility !== 'internal') {
    throw commandInventoryInvalid(
      'leaf-visibility',
      'runtime command leaf visibility invalid.',
      'visibility',
    );
  }
  if (leaf.scope !== 'project' && leaf.scope !== 'none') {
    throw commandInventoryInvalid('leaf-scope', 'runtime command leaf scope invalid.', 'scope');
  }
  if (typeof leaf.output !== 'string' || !isSafeName(leaf.output, limits.maxName)) {
    throw commandInventoryInvalid('leaf-output', 'runtime command leaf output invalid.', 'output');
  }
  validateLeafAliases(leaf, limits);
  validateLeafHandlerClaims(leaf);
}

/**
 * Validate the alias array shape and each alias string.
 *
 * @throws {Error} When aliases exceed the limit or contain invalid strings.
 */
function validateLeafAliases(
  leaf: RuntimeCommandLeaf,
  limits: RuntimeCommandInventoryLimits,
): void {
  if (!Array.isArray(leaf.aliases) || leaf.aliases.length > limits.maxAliases) {
    throw commandInventoryLimitExceeded(
      'max-aliases',
      `runtime command leaf aliases must be an array of at most ${String(limits.maxAliases)}.`,
      limits.maxAliases,
    );
  }
  for (const alias of leaf.aliases) {
    if (typeof alias !== 'string' || !isSafeName(alias, limits.maxName)) {
      throw commandInventoryInvalid(
        'leaf-alias',
        `runtime command leaf alias invalid: '${String(alias)}'.`,
        'aliases',
      );
    }
  }
}

/**
 * Validate optional package identity and static-handler descriptor claims.
 *
 * @throws {Error} When packageIdentity or staticHandler fields are invalid.
 */
function validateLeafHandlerClaims(leaf: RuntimeCommandLeaf): void {
  if (
    leaf.owner === 'tool' &&
    leaf.packageIdentity !== undefined &&
    (typeof leaf.packageIdentity !== 'string' ||
      !isSafeName(leaf.packageIdentity, MAX_STATIC_HANDLER_PACKAGE))
  ) {
    throw commandInventoryHandlerClaim(
      'package-identity',
      'runtime command leaf packageIdentity invalid.',
    );
  }
  if (leaf.staticHandler !== undefined) {
    const err = staticHandlerValidationError(leaf.staticHandler, leaf.name);
    if (err !== undefined) throw err;
    if (!isSafeProjectRelativePosixPath(leaf.staticHandler.path)) {
      throw commandInventoryHandlerClaim(
        'static-handler-path',
        'runtime command leaf staticHandler.path invalid.',
      );
    }
    if (leaf.staticHandler.declaration.length > MAX_STATIC_HANDLER_DECLARATION) {
      throw commandInventoryHandlerClaim(
        'static-handler-declaration',
        'runtime command leaf staticHandler.declaration overlong.',
      );
    }
  }
}

/**
 * @throws {Error} When group path/name/owner/visibility is invalid or path duplicates a leaf.
 */
function validateGroup(
  group: RuntimeCommandGroup,
  limits: RuntimeCommandInventoryLimits,
  paths: Set<string>,
): void {
  if (!isSafePath(group.path, limits.maxPath)) {
    throw commandInventoryInvalid(
      'group-path',
      `runtime command group path invalid: '${group.path}'.`,
      'path',
    );
  }
  if (paths.has(group.path)) {
    throw commandInventoryDuplicate(
      'group-path',
      `runtime command inventory duplicate path '${group.path}'.`,
      group.path,
    );
  }
  paths.add(group.path);
  if (!isSafeName(group.name, limits.maxName)) {
    throw commandInventoryInvalid(
      'group-name',
      `runtime command group name invalid: '${group.name}'.`,
      'name',
    );
  }
  if (group.owner !== 'host' && group.owner !== 'tool') {
    throw commandInventoryInvalid(
      'group-owner',
      'runtime command group owner must be host|tool.',
      'owner',
    );
  }
  if (!isSafeName(group.ownerLabel, limits.maxName)) {
    throw commandInventoryInvalid(
      'group-owner-label',
      'runtime command group ownerLabel invalid.',
      'ownerLabel',
    );
  }
  if (group.visibility !== 'public' && group.visibility !== 'internal') {
    throw commandInventoryInvalid(
      'group-visibility',
      'runtime command group visibility invalid.',
      'visibility',
    );
  }
}

function freezeLeaf(leaf: RuntimeCommandLeaf): RuntimeCommandLeaf {
  const frozen: RuntimeCommandLeaf = {
    path: leaf.path,
    name: leaf.name,
    aliases: Object.freeze([...leaf.aliases]),
    owner: leaf.owner,
    ownerLabel: leaf.ownerLabel,
    visibility: leaf.visibility,
    scope: leaf.scope,
    output: leaf.output,
  };
  if (leaf.provenanceSource !== undefined) {
    (frozen as { provenanceSource: string }).provenanceSource = leaf.provenanceSource;
  }
  if (leaf.packageIdentity !== undefined) {
    (frozen as { packageIdentity: string }).packageIdentity = leaf.packageIdentity;
  }
  if (leaf.staticHandler !== undefined) {
    (frozen as { staticHandler: StaticHandlerDescriptor }).staticHandler =
      freezeStaticHandlerDescriptor(leaf.staticHandler);
  }
  return Object.freeze(frozen);
}
