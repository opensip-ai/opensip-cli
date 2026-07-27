#!/usr/bin/env node
/**
 * @fileoverview Plan 01 Task A.4 — the migration lane's net-new ratchet.
 *
 * The seven `error-*` checks ship `disabled: true` and run only through the
 * `error-migration` recipe, because enabling them against the outstanding backlog would
 * take the dogfood gate red on day one and the checks would be waived rather than
 * adopted. This script is what makes the lane bite anyway: it re-runs the lane and fails
 * on **added** fingerprints only.
 *
 * WHY A TRACKED FILE RATHER THAN `--gate-save`
 * The database baseline plane is namespaced by TOOL (`saveBaseline(tool, envelope)`), and
 * `fit:ci` already owns the `fitness` namespace — a second `--gate-save` lane would
 * overwrite the dogfood gate's baseline. A git-tracked fingerprint file is reviewable in a
 * diff and visibly shrinks as each wave lands.
 *
 * WHAT A GREEN RATCHET PROVES (measured, do not overstate)
 * Only that no NEW violation of these seven patterns was introduced. Phase A.1/A.2
 * measured the checks at 0.65% recall against the human-reviewed ledger, so a green
 * ratchet says nothing about how much of a wave's slice is closed. Wave completion is
 * proven by the ledger, not by this script.
 *
 * RESOLVED FINGERPRINTS ARE REPORTED, NEVER AUTO-REMOVED. A silent shrink would hide a
 * check that stopped firing because it broke; rewriting the baseline requires `--update`.
 *
 * Usage:
 *   node scripts/error-migration-ratchet.mjs [--json] [--update] [--findings <fit-json>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const BASELINE_PATH = '.config/error-migration-baseline.json';
export const LANE_RECIPE = 'error-migration';

/**
 * Compare a lane run against the tracked baseline.
 * Pure so the behaviour can be tested without running the CLI.
 *
 * @param {readonly string[]} baseline
 * @param {readonly string[]} current
 */
export function diffFingerprints(baseline, current) {
  const base = new Set(baseline);
  const now = new Set(current);
  const added = [...now].filter((f) => !base.has(f)).sort();
  const resolved = [...base].filter((f) => !now.has(f)).sort();
  return { added, resolved, unchanged: [...now].filter((f) => base.has(f)).length };
}

/** @param {string} raw `fit --json` output */
export function fingerprintsFrom(raw) {
  const outcome = JSON.parse(raw);
  const envelope = outcome.envelope ?? outcome;
  const signals = envelope.signals ?? [];
  const withFp = signals.filter(
    (s) => typeof s.fingerprint === 'string' && s.fingerprint.length > 0,
  );
  return {
    fingerprints: [...new Set(withFp.map((s) => s.fingerprint))].sort(),
    // A signal with no fingerprint cannot be ratcheted; surface it rather than dropping it.
    unfingerprinted: signals.length - withFp.length,
    signals: withFp.map((s) => ({
      fingerprint: s.fingerprint,
      ruleId: s.ruleId,
      filePath: s.filePath,
      line: s.line,
    })),
  };
}

function runLane(root) {
  const args = [
    join('packages', 'cli', 'dist', 'index.js'),
    'fit',
    '--recipe',
    LANE_RECIPE,
    '--json',
  ];
  try {
    return execFileSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    // The lane config is ratchet-only, but a findings-bearing run may still exit non-zero
    // in other configurations; the JSON on stdout is the contract.
    if (typeof error?.stdout === 'string' && error.stdout.length > 0) return error.stdout;
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const asJson = argv.includes('--json');
  const update = argv.includes('--update');

  const baselinePath = join(REPO_ROOT, BASELINE_PATH);
  if (!existsSync(baselinePath)) {
    console.error(
      `[error-migration-ratchet] missing ${BASELINE_PATH} — capture it before enabling the lane in CI.`,
    );
    process.exitCode = 2;
    return;
  }
  const baselineDoc = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const findingsPath = flagValue('--findings');
  const raw = findingsPath ? readFileSync(findingsPath, 'utf8') : runLane(REPO_ROOT);
  const { fingerprints, unfingerprinted, signals } = fingerprintsFrom(raw);
  const { added, resolved, unchanged } = diffFingerprints(
    baselineDoc.fingerprints ?? [],
    fingerprints,
  );

  const byFp = new Map(signals.map((s) => [s.fingerprint, s]));
  const addedDetail = added.map((f) => byFp.get(f) ?? { fingerprint: f });

  if (update) {
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ ...baselineDoc, signalCount: fingerprints.length, fingerprints }, null, 2)}\n`,
    );
  }

  const report = {
    ok: added.length === 0,
    lane: LANE_RECIPE,
    baselineCount: (baselineDoc.fingerprints ?? []).length,
    currentCount: fingerprints.length,
    added: added.length,
    resolved: resolved.length,
    unchanged,
    unfingerprinted,
    updated: update,
    addedDetail: addedDetail.slice(0, 25),
  };

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `[error-migration-ratchet] baseline ${report.baselineCount} → current ${report.currentCount} (added ${report.added}, resolved ${report.resolved})`,
    );
    for (const s of addedDetail.slice(0, 25)) {
      console.log(`  NEW  ${s.ruleId ?? '?'}  ${s.filePath ?? '?'}:${s.line ?? '?'}`);
    }
    if (resolved.length > 0 && !update) {
      console.log(
        `  ${resolved.length} baseline entr${resolved.length === 1 ? 'y' : 'ies'} no longer fire. Re-run with --update to shrink the baseline (never automatic: a silent shrink would hide a check that broke).`,
      );
    }
    if (unfingerprinted > 0) {
      console.log(
        `  WARNING: ${unfingerprinted} signal(s) carried no fingerprint and cannot be ratcheted.`,
      );
    }
  }

  if (added.length > 0) {
    console.error(
      `[error-migration-ratchet] ${added.length} NEW error/resiliency violation(s) introduced — the migration lane blocks net-new debt.`,
    );
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirect) main();
