#!/usr/bin/env node
/**
 * verify-acceptance-verifier-consistency — a static guard against the class of
 * drift that false-failed the v0.8.2 release: the macOS qualifier's
 * expected-abnormal-terminal allowlist and the acceptance journeys are
 * maintained by hand in two places, so they silently disagree.
 *
 * This guards the two cheaply-checkable directions:
 *   1. No DANGLING allowlist entry — every journey id referenced by
 *      EXPECTED_NON_ZERO_EXIT / EXPECTED_POSITIVE_EXIT /
 *      EXPECTED_ABNORMAL_TERMINAL_COUNTS must exist in at least one shipped
 *      acceptance profile (catches renames/removals leaving stale entries).
 *   2. INTERNAL consistency — a journey with a `positive-exit` count in
 *      EXPECTED_ABNORMAL_TERMINAL_COUNTS must also declare its allowed exit
 *      code(s) via EXPECTED_NON_ZERO_EXIT or EXPECTED_POSITIVE_EXIT; a count
 *      without an exit allowlist is contradictory.
 *
 * It does NOT (and cannot cheaply) guard the FORWARD direction — a journey that
 * gains an intentional non-zero exit without being added to the allowlist, which
 * is what bit 0.8.2. That requires the journeys to DECLARE their intentional
 * terminals so the verifier derives its allowlist from one source; see the
 * tracked follow-up. Until then this catches the reverse + internal drift.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_ABNORMAL_TERMINAL_COUNTS,
  EXPECTED_NON_ZERO_EXIT,
  EXPECTED_POSITIVE_EXIT,
} from './verify-platform-acceptance.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE_DIR = join(REPO_ROOT, '.config', 'platform-acceptance');

/**
 * Pure consistency analysis. `allowlists` is the three verifier structures;
 * `profileJourneyIds` is the union of ids across shipped profiles. Returns a
 * list of issue strings (empty ⇒ consistent). No I/O — unit-tested directly.
 */
export function findConsistencyIssues(allowlists, profileJourneyIds) {
  const { nonZeroExit, positiveExit, abnormalCounts } = allowlists;
  const known = new Set(profileJourneyIds);
  const issues = [];

  const allowlistIds = new Set([...nonZeroExit.keys(), ...positiveExit, ...abnormalCounts.keys()]);
  for (const id of allowlistIds) {
    if (!known.has(id)) {
      issues.push(`dangling: verifier allowlist references '${id}', absent from every profile`);
    }
  }

  for (const [id, kinds] of abnormalCounts) {
    if ((kinds.get('positive-exit') ?? 0) > 0 && !nonZeroExit.has(id) && !positiveExit.has(id)) {
      issues.push(
        `internal: '${id}' expects a positive-exit terminal but declares no allowed exit code ` +
          '(add it to EXPECTED_NON_ZERO_EXIT or EXPECTED_POSITIVE_EXIT)',
      );
    }
  }
  return issues;
}

/** Union of journey ids across every shipped acceptance profile. */
function collectProfileJourneyIds() {
  const ids = new Set();
  for (const file of readdirSync(PROFILE_DIR)) {
    if (!file.endsWith('.json')) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(PROFILE_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    for (const journey of doc.journeys ?? []) {
      if (typeof journey?.id === 'string') ids.add(journey.id);
    }
  }
  return [...ids];
}

function main() {
  const issues = findConsistencyIssues(
    {
      nonZeroExit: EXPECTED_NON_ZERO_EXIT,
      positiveExit: EXPECTED_POSITIVE_EXIT,
      abnormalCounts: EXPECTED_ABNORMAL_TERMINAL_COUNTS,
    },
    collectProfileJourneyIds(),
  );
  if (issues.length > 0) {
    for (const issue of issues) process.stdout.write(`  ✗ ${issue}\n`);
    process.stdout.write(
      `\n[verify-acceptance-verifier-consistency] ${String(issues.length)} inconsistency(ies) ` +
        'between the qualifier allowlist and the acceptance profiles.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    '[verify-acceptance-verifier-consistency] OK — allowlist entries all resolve to a shipped ' +
      'journey and every positive-exit count has a matching exit allowlist.\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
