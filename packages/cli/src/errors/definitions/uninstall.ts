/**
 * Safety refusals from the destructive `uninstall` paths.
 *
 * Every definition here guards a recursive delete. That makes them the sharpest case in Plan 01:
 * each refusal message already names the exact condition AND the fix ("project path is a symbolic
 * link … Pass a real directory"), and every one of them was thrown as a bare `Error`. A bare
 * `Error` normalizes to `SYSTEM_ERROR`, whose exposure is `redacted`, so the public projection
 * replaced all of that with **"The operation failed."**
 *
 * So the person holding a half-uninstalled project was told nothing, about a command that
 * deletes things. These are `exposure: 'public'` precisely so the instruction survives.
 *
 * They are `configuration` exit-class, not `runtime`: nothing malfunctioned. The command
 * inspected the filesystem, found a state it refuses to delete through, and stopped. The operator
 * fixes the path and re-runs — which is the definition of a configuration failure here.
 */

import { USER_INPUT } from './axes.js';

import type { ErrorDefinition } from '@opensip-cli/core';

/**
 * A containment or shape refusal the USER can correct: a symlinked root, a project path that is
 * not a directory. `security` kind because the refusal exists to stop a recursive delete from
 * following a link out of the tree it was scoped to.
 */
const REMOVAL_REFUSED = {
  ...USER_INPUT,
  kind: 'security',
  exposure: 'public',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

export const uninstallDefinitions = {
  /**
   * A managed layout leaf (`opensip-cli/`, `opensip-cli/.runtime/`) is a symlink.
   *
   * Deleting through it would recurse into whatever it points at, which is outside the tree the
   * user asked to remove. `metadata.condition` names which leaf, so the operator does not have to
   * parse the message to find out.
   */
  'CLI.UNINSTALL.REFUSED_SYMLINK_LEAF': {
    ...REMOVAL_REFUSED,
    code: 'CLI.UNINSTALL.REFUSED_SYMLINK_LEAF',
    operatorAction:
      'A managed directory is a symbolic link. Replace it with a real directory, or remove the link yourself, then re-run uninstall.',
    publicMetadataKeys: ['condition', 'path'],
  },

  /**
   * The project path itself is a symlink, or is not a directory at all.
   *
   * One code for both (D9): the operator does the same thing — point the command at a real
   * project directory — and `metadata.condition` distinguishes `symlink` from `not-a-directory`.
   * The ledger calls this the highest-value message in the file, and it was being thrown away.
   */
  'CLI.UNINSTALL.REFUSED_PROJECT_ROOT': {
    ...REMOVAL_REFUSED,
    code: 'CLI.UNINSTALL.REFUSED_PROJECT_ROOT',
    operatorAction:
      'The project path is not a real directory. Pass a real project directory to uninstall.',
    publicMetadataKeys: ['condition', 'path'],
  },

  /**
   * The user-level root is a symlink.
   *
   * Separate from the project-root refusal because the recovery differs: this one is about the
   * user's own OpenSIP state directory, not a project they named on the command line.
   */
  'CLI.UNINSTALL.REFUSED_SYMLINK_USER_ROOT': {
    ...REMOVAL_REFUSED,
    code: 'CLI.UNINSTALL.REFUSED_SYMLINK_USER_ROOT',
    operatorAction:
      'The OpenSIP user directory is a symbolic link. Replace it with a real directory, or remove the link yourself, then re-run.',
    publicMetadataKeys: ['condition', 'path'],
  },

  /**
   * A resolved deletion target lies outside every allowed root.
   *
   * THE containment invariant for recursive deletion — checked immediately before the `rmSync`
   * loop. It is the one refusal in this file that is not about a mistake the user made, and the
   * one where a silent, uninformative failure would be worst: it means the plan tried to delete
   * something outside the project and the cache.
   *
   * `integrity` rather than `security` because the target set is host-computed, so a failure here
   * says the plan is wrong, not that the user pointed somewhere unsafe.
   */
  'CLI.UNINSTALL.TARGET_ESCAPES_ROOTS': {
    ...REMOVAL_REFUSED,
    code: 'CLI.UNINSTALL.TARGET_ESCAPES_ROOTS',
    kind: 'integrity',
    defaultResponsibility: 'tool-author',
    // Overrides the exitClass REMOVAL_REFUSED inherits from USER_INPUT: this is a
    // tool-author invariant breach, not a user mistake, so it exits like
    // CLI.HOST.WIRING_INVALID (runtime → exit 1), not like an ordinary bad-path refusal.
    exitClass: 'runtime',
    operatorAction:
      'Uninstall refused: a removal target resolved outside the project and cache roots. Nothing was deleted. Report this with the run id.',
    publicMetadataKeys: ['condition', 'bucket'],
  },

  /**
   * User-level uninstall could not complete and could not fully undo itself.
   *
   * This is the single classification point for roughly twenty-two distinct fail-closed
   * conditions across the user-removal transaction — marker conflicts, journal corruption,
   * ownership mismatches, interrupted publication. They funnel through one helper, and it threw a
   * bare `Error` carrying no code, no axes, and no `cause`, so which of the twenty-two happened
   * was unrecoverable from the outside.
   *
   * `metadata.condition` carries the specific reason (D9); the shared code is the honest part —
   * the operator's action really is the same for all of them.
   */
  'CLI.UNINSTALL.USER_RECOVERY_UNSAFE': {
    ...REMOVAL_REFUSED,
    code: 'CLI.UNINSTALL.USER_RECOVERY_UNSAFE',
    kind: 'integrity',
    defaultResponsibility: 'environment',
    operatorAction:
      'User-level uninstall stopped in a state it will not modify further. Re-run to resume; if it repeats, the named path needs manual inspection.',
    publicMetadataKeys: ['condition', 'path'],
  },
} as const;
