/**
 * `@opensip-cli/config` error definitions (Plan 01).
 *
 * A substrate catalog under ruling D1: the owner id is the npm package name, because this
 * package is not a Tool.
 *
 * All nine conditions come from ONE command — `opensip configure` migrating an existing
 * `opensip-cli.config.yml` to a newer schema — and they were `CONFIG.MIGRATION.*` string
 * literals with no catalog entry, alive only through the head-guessing the clean break
 * removed. Clustered per ruling D9 into the three answers a user actually needs, because a
 * user does the same thing for every member of each group and the specific branch is more
 * useful as bounded metadata than as nine codes to enumerate.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

import type { ErrorDefinition } from '@opensip-cli/core';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const CONFIG_ERROR_OWNER_ID = '@opensip-cli/config';

/** The user's own config file is the subject of every one of these. */
const USER_CONFIG = {
  source: 'application',
  defaultResponsibility: 'user',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'configuration',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'kind' | 'operatorAction'>;

export const configErrorCatalog = defineErrorCatalog(
  {
    id: CONFIG_ERROR_OWNER_ID,
    displayName: '@opensip-cli/config',
    packageName: CONFIG_ERROR_OWNER_ID,
  },
  {
    /**
     * The config file cannot be read at all: absent, not a regular file, unreadable, or
     * un-stattable.
     *
     * `not-found` rather than `I/O`: from the user's side these are one situation — "point me
     * at a config that exists" — and the errno-level distinction is diagnostic detail, which
     * is what `metadata.condition` is for.
     */
    'CONFIG.MIGRATION.UNREADABLE': {
      ...USER_CONFIG,
      code: 'CONFIG.MIGRATION.UNREADABLE',
      kind: 'not-found',
      operatorAction:
        'Check the --config path: the file must exist, be a regular file, and be readable by this user.',
      publicMetadataKeys: ['condition', 'errno'],
    },

    /**
     * The file was read but is not a config document this version can migrate: malformed
     * YAML, a top level that is not a mapping, or a document over the editable size bound.
     *
     * `integrity`, not `validation`: migration REWRITES the file, and rewriting a document we
     * could not fully parse would silently drop whatever we failed to understand. Refusing
     * protects the user's file.
     */
    'CONFIG.MIGRATION.UNMIGRATABLE_DOCUMENT': {
      ...USER_CONFIG,
      code: 'CONFIG.MIGRATION.UNMIGRATABLE_DOCUMENT',
      kind: 'integrity',
      operatorAction:
        'Fix the reported problem in opensip-cli.config.yml — it must be valid YAML with a mapping at the top level — then re-run.',
      publicMetadataKeys: ['condition', 'path'],
    },

    /**
     * The requested migration cannot be performed by this CLI: an unknown target version, or
     * a config newer than the installed CLI understands.
     *
     * `compatibility` kind, and the operator action is the one that actually resolves it —
     * upgrade, rather than edit the file.
     */
    'CONFIG.MIGRATION.VERSION_UNSUPPORTED': {
      ...USER_CONFIG,
      code: 'CONFIG.MIGRATION.VERSION_UNSUPPORTED',
      kind: 'compatibility',
      operatorAction:
        'Upgrade opensip-cli to a version that understands this config schema, or request a target version this CLI supports.',
      publicMetadataKeys: ['condition', 'requested', 'supported'],
    },
    /**
     * The user-level trust policy block cannot be trusted: it is already invalid, or the grant
     * being applied would make it invalid.
     *
     * One code, two conditions (D9) — the operator fixes the same file either way, and
     * `metadata.condition` says whether the document was already broken or the requested grant
     * would break it. Refused rather than repaired: silently dropping an unparsable trust block
     * would widen capability trust by accident, which is the one direction that must never
     * happen by default.
     */
    'CONFIG.POLICY.USER_DOCUMENT_INVALID': {
      code: 'CONFIG.POLICY.USER_DOCUMENT_INVALID',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction:
        'Correct the policy block in your global OpenSIP config before granting or revoking capability trust.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },
  },
);
