/**
 * `@opensip-cli/output` error definitions (Plan 01).
 *
 * A substrate catalog under ruling D1: the owner id is the npm package name.
 *
 * The machine-output layer refused two conditions with bare `Error`s. Both propagate to the
 * failure reporter, which — finding no code — resolved them to `CORE.SYSTEM.UNKNOWN_FAILURE`:
 * severity `fatal`, exposure `operator-only`. The messages at those sites are unusually
 * actionable (they name the exact seam a tool author must fix), and `operator-only` exposure
 * threw all of that away and printed "an unexpected internal failure occurred" instead.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

/** Substrate catalogs are keyed on the npm package name (ruling D1). */
export const OUTPUT_ERROR_OWNER_ID = '@opensip-cli/output';

export const outputErrorCatalog = defineErrorCatalog(
  {
    id: OUTPUT_ERROR_OWNER_ID,
    displayName: '@opensip-cli/output',
    packageName: OUTPUT_ERROR_OWNER_ID,
  },
  {
    /**
     * A tool handed the gate plane signals it cannot diff: one with no fingerprint, or two
     * sharing a fingerprint.
     *
     * One code across all three refusals (D9) — the tool author fixes every one of them in the
     * same place, its `stampFingerprints` call — with `metadata.condition` naming which.
     *
     * `tool-author` and `invariant`: nothing the operator did causes this, and no retry helps.
     * The plane fails closed rather than dropping the offending signal, because a
     * last-writer-wins merge would silently under-count the ratchet and report a clean gate for
     * findings it never compared.
     */
    'OUTPUT.GATE.FINGERPRINT_INVALID': {
      code: 'OUTPUT.GATE.FINGERPRINT_INVALID',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'The tool emitted signals the gate cannot compare. Report it to the tool author: signals must be stamped with unique fingerprints before the gate seam.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'ruleId', 'fingerprint'],
    },

    /**
     * A caller's egress request is unusable — today, an idempotency key that is absent, empty
     * or over its bound.
     *
     * Refused rather than substituted: an egress chunk sent under a made-up idempotency key
     * defeats the deduplication the key exists to provide, which surfaces later as duplicated
     * evidence that is far harder to explain than a refusal here.
     */
    'OUTPUT.EGRESS.REQUEST_INVALID': {
      code: 'OUTPUT.EGRESS.REQUEST_INVALID',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Supply a non-empty idempotency key of at most 256 characters for each egress chunk.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['field'],
    },
  },
);
