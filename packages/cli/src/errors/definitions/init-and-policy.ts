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
  /**
   * The init authored-state transaction refused to proceed.
   *
   * One code across ~199 refusals in the authored-state plane, because the operator's action
   * genuinely is the same for all of them: init will not modify the authored state further, and
   * the named path needs inspection or a fresh `init`. What differs between them is WHICH
   * invariant broke, and each call site already says so precisely — "a foreign replay
   * publication temporary is present", "the replay manifest bytes disagree with the durable
   * journal", "authored preparation can no longer be aborted safely".
   *
   * Every one of those sentences was being replaced by "The operation failed." The code was
   * `SYSTEM.INIT.AUTHORED_TRANSACTION`, a head no catalog declared, so it resolved to
   * `SYSTEM_ERROR` — `exposure: 'redacted'` — and the projection discarded the message. This is
   * the single largest instance of that loss in the codebase.
   *
   * `integrity` and `configuration`: these are fail-closed refusals over on-disk state, not
   * malfunctions, and the operator resolves them by fixing or clearing that state.
   */
  'CLI.INIT.AUTHORED_TRANSACTION_UNSAFE': {
    ...USER_INPUT,
    code: 'CLI.INIT.AUTHORED_TRANSACTION_UNSAFE',
    kind: 'integrity',
    defaultResponsibility: 'environment',
    operatorAction:
      'Init refused to modify the authored project state; nothing further was written. The message names the invariant that failed — inspect that path, or re-run `opensip init` to start a fresh attempt.',
    publicMetadataKeys: ['condition'],
  },
  /**
   * The selected runtime-promotion source could not be verified against its authority.
   *
   * The class that raises this extended bare `Error`, so it carried no code and normalized to
   * `SYSTEM_ERROR` — message redacted. That matters more here than in most places: this failure
   * decides, through its `releaseSafe` flag, whether the process-owned runtime lease may be
   * released. An operator seeing "The operation failed." had no way to tell a source that could
   * not be verified from one that left the lease unsafe to release.
   *
   * `integrity` and `environment`: the artifacts on disk disagree with the authority that
   * should describe them, and the operator resolves it by inspecting or re-running, not by
   * changing an argument.
   */
  'CLI.INIT.PROMOTION_SOURCE_UNVERIFIED': {
    ...USER_INPUT,
    code: 'CLI.INIT.PROMOTION_SOURCE_UNVERIFIED',
    kind: 'integrity',
    defaultResponsibility: 'environment',
    operatorAction:
      'The runtime-promotion source could not be verified against its recorded authority. Re-run `opensip init`; if it repeats, the runtime directory needs inspection.',
    publicMetadataKeys: ['condition', 'releaseSafe'],
  },
} as const;
