/**
 * Project initialization, runtime promotion, gate baselines and capability policy.
 *
 * One of the host catalog's definition modules. They are separate files because the catalog
 * outgrew the file-length bound as a single unit, not because the groups are independent —
 * `host-error-catalog.ts` assembles them into one catalog with one owner and one head.
 */

import { HOST_WIRING, USER_INPUT } from './axes.js';

export const initAndPolicyDefinitions = {
  /**
   * The baseline gate cannot run: no captured baseline, an unstamped signal, or baseline
   * identity that is missing or does not match the current strategy.
   *
   * `tool-author` for the stamping cases and `user` for the missing-baseline case is a real
   * split, but the ACTION is the same in both — capture a baseline, or fix the tool that
   * emitted un-stamped signals — so `metadata.condition` carries which, and the message says
   * who. `exitClass: 'configuration'` preserves the gate's existing exit 2.
   */
  'CLI.GATE.BASELINE_INVALID': {
    ...USER_INPUT,
    code: 'CLI.GATE.BASELINE_INVALID',
    operatorAction:
      'Run the tool with --gate-save to capture a baseline before comparing; if the message reports unstamped signals, report it to the tool author.',
    publicMetadataKeys: ['condition', 'tool'],
  },

  /**
   * Policy refused the operation.
   *
   * Kept distinct from every other configuration failure: a governance denial is not a
   * mistake to correct, and `permission` kind is what tells an agent not to retry or
   * work around it.
   */
  'CLI.POLICY.DENIED': {
    ...USER_INPUT,
    code: 'CLI.POLICY.DENIED',
    defaultResponsibility: 'operator',
    kind: 'permission',
    operatorAction:
      'Policy denied this operation. Change the policy deliberately, or run an operation the policy allows.',
    publicMetadataKeys: ['condition', 'tool'],
  },

  /**
   * Runtime evidence cannot be promoted safely.
   *
   * `security`: the promotion preflight found the manifest untrustworthy, and proceeding
   * would publish evidence we cannot vouch for.
   */
  'CLI.RUNTIME_PROMOTION.MANIFEST_UNSAFE': {
    ...USER_INPUT,
    code: 'CLI.RUNTIME_PROMOTION.MANIFEST_UNSAFE',
    defaultResponsibility: 'environment',
    kind: 'security',
    operatorAction:
      'Runtime evidence could not be promoted safely. Remove the runtime directory named in the message and re-run `opensip init`.',
    publicMetadataKeys: ['reason'],
  },

  /**
   * The runtime-promotion journal cannot be trusted: it is not canonically encoded, or names a
   * phase this version does not accept.
   *
   * Registered rather than left on the `SYSTEM.INIT.` literal, which was mapped by nothing and
   * so resolved to `UNKNOWN_FAILURE` — fatal, operator-only — for a condition the recovery path
   * BRANCHES on. The recovery code reads this to decide `journal-phase-invalid`, so a demotion
   * here does not merely misreport: it hides the distinction the caller is switching over.
   */
  'CLI.INIT.PROMOTION_JOURNAL_INVALID': {
    ...HOST_WIRING,
    code: 'CLI.INIT.PROMOTION_JOURNAL_INVALID',
    kind: 'integrity',
    exposure: 'public',
    operatorAction:
      'The promotion journal is not readable. Re-run `opensip init`; if it repeats, remove the runtime directory and initialize again.',
    publicMetadataKeys: ['condition'],
  },

  /**
   * Promotion stopped in a state that cannot be resumed automatically.
   *
   * Separate from `PROMOTION_JOURNAL_INVALID` because the operator does something different:
   * this one needs an explicit recovery pass rather than a retry.
   */
  'CLI.INIT.PROMOTION_RECOVERY_REQUIRED': {
    ...HOST_WIRING,
    code: 'CLI.INIT.PROMOTION_RECOVERY_REQUIRED',
    kind: 'conflict',
    exposure: 'public',
    operatorAction:
      'Runtime promotion needs recovery before it can continue. Re-run `opensip init` to resume it.',
    publicMetadataKeys: ['condition'],
  },
} as const;
