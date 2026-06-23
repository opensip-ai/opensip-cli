/**
 * baseline-seams — the host implementations behind the four `ToolCliContext`
 * baseline/ratchet seams (ADR-0036): `saveBaseline`, `compareBaseline`,
 * `exportBaselineSarif`, `exportBaselineFingerprints`.
 *
 * The host owns persistence (`BaselineRepo`), the pure diff (`diffBaseline` from
 * `@opensip-cli/output`), SARIF re-render, and the git-trackable JSON export.
 * The seams are **read-only** of `signal.fingerprint`: the tool stamps its
 * envelope's signals (`stampFingerprints`) at envelope-construction time and the
 * plane NEVER re-fingerprints. Factored out of `cli-context.ts` to keep that
 * file within its size budget.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  ConfigurationError,
  type GateCompareResult,
  type Logger,
  SeverityPolicy,
  type Signal,
} from '@opensip-cli/core';
import { BaselineRepo, type DataStore } from '@opensip-cli/datastore';
import { diffBaseline } from '@opensip-cli/output';

import { writeEnvelopeSarif } from './deliver-envelope.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

/** The four host baseline/ratchet seam implementations, bound to a datastore resolver. */
export interface BaselineSeams {
  readonly saveBaseline: (tool: string, envelope: unknown) => Promise<void>;
  readonly compareBaseline: (tool: string, envelope: unknown) => Promise<GateCompareResult>;
  readonly exportBaselineSarif: (tool: string, path: string) => Promise<void>;
  readonly exportBaselineFingerprints: (tool: string, path: string) => Promise<void>;
}

/** Thrown (→ exit 2) when a gate compare/export runs before any baseline was saved. */
function missingBaseline(tool: string): ConfigurationError {
  return new ConfigurationError(
    `No baseline found for '${tool}' in the project SQLite store. If this is a first ` +
      `run — or you upgraded across a release that changed the baseline schema (the ` +
      `per-tool baseline tables were dropped and recaptured, ADR-0036) — run ` +
      `\`opensip-cli ${tool} --gate-save\` to (re)capture one. The git-trackable ` +
      `JSON fingerprint baseline (graph-baseline-export) is a file, not a DB row, and ` +
      `is untouched.`,
    { code: 'CONFIGURATION.GATE.BASELINE_MISSING' },
  );
}

/** Assert each signal carries a fingerprint — the plane never stamps (ADR-0036). */
// @graph-ignore-next-line graph:always-throws-branch -- not throw-dominated: returns the mapped entries; the throw is a guard fired only when a tool hands unstamped signals (a contract violation the plane must surface).
function requireStampedEntries(
  tool: string,
  signals: readonly Signal[],
): { fingerprint: string; payload: Signal }[] {
  return signals.map((s) => {
    if (!s.fingerprint) {
      throw new ConfigurationError(
        `saveBaseline(${tool}): signal ${s.ruleId} is not fingerprint-stamped. The tool must ` +
          `stamp its signals (stampFingerprints) before the seam — the plane never fingerprints.`,
        { code: 'CONFIGURATION.GATE.UNSTAMPED_SIGNAL' },
      );
    }
    return { fingerprint: s.fingerprint, payload: s };
  });
}

/**
 * Build the four baseline seams over a lazy datastore resolver. `getDatastore`
 * throws when accessed outside a project scope (the host's existing contract).
 */
export function buildBaselineSeams(deps: {
  readonly getDatastore: () => DataStore;
  readonly logger: Logger;
}): BaselineSeams {
  const { getDatastore, logger } = deps;
  const repoFor = (): BaselineRepo => new BaselineRepo(getDatastore());

  return {
    // Sync-bodied (SQLite is synchronous) but typed Promise to match the seam
    // contract; a sync throw still rejects for an `await`ing caller.
    saveBaseline: (tool, envelope) => {
      const env = envelope as SignalEnvelope;
      const entries = requireStampedEntries(tool, env.signals);
      repoFor().save(tool, entries);
      logger.info({
        evt: 'cli.baseline.save.complete',
        module: 'cli:baseline-seams',
        tool,
        count: entries.length,
      });
      return Promise.resolve();
    },

    compareBaseline: (tool, envelope) => {
      const repo = repoFor();
      if (!repo.exists(tool)) return Promise.reject(missingBaseline(tool));
      const env = envelope as SignalEnvelope;
      return Promise.resolve(diffBaseline(env.signals, repo.load(tool)));
    },

    /** @throws {ConfigurationError} (→ exit 2) when no baseline exists for `tool`. */
    exportBaselineSarif: async (tool, path) => {
      const repo = repoFor();
      if (!repo.exists(tool)) throw missingBaseline(tool);
      const capturedAt = repo.capturedAt(tool);
      /* v8 ignore next 3 -- defensive: exists() returned true above (same as fingerprints export) */
      if (capturedAt === undefined) {
        throw new ConfigurationError(
          `Baseline meta row for '${tool}' missing after exists() reported present.`,
          { code: 'CONFIGURATION.GATE.BASELINE_INCONSISTENT' },
        );
      }
      const signals = repo
        .load(tool)
        .map((r) => r.payload)
        .filter((s): s is Signal => s !== null);

      // Compute a minimal but truthful verdict/summary from the captured signals
      // so that SARIF consumers (and any envelope-level logic) see consistent
      // counts instead of an all-zeroes synthetic. This is a reconstruction of
      // historical findings; "passed" here means "the captured set contained no
      // error-severity findings" (matching the spirit of the run verdict).
      let errors = 0;
      let warnings = 0;
      for (const s of signals) {
        if (SeverityPolicy.isError(s.severity)) errors += 1;
        else warnings += 1;
      }
      const summary = {
        total: signals.length,
        passed: signals.length - errors,
        failed: errors,
        errors,
        warnings,
      };

      // SARIF export RECONSTRUCTS (no stored envelope): formatSignalSarif derives
      // results from `signals` + the driver name from `tool` only, so the other
      // envelope fields are mostly inert filler. We now populate a plausible
      // verdict so downstream SARIF or machine consumers are not misled.
      // The runId/createdAt make it obvious this is a reconstruction from a
      // previously captured baseline (units and per-unit facts like filesValidated
      // are not recoverable without storing the full original envelope).
      const synthetic: SignalEnvelope = {
        schemaVersion: 2,
        tool,
        runId: `baseline:${tool}`,
        createdAt: new Date(capturedAt).toISOString(),
        verdict: {
          score: signals.length === 0 ? 1 : summary.passed / summary.total,
          passed: errors === 0,
          summary,
        },
        units: [],
        signals,
      };
      await writeEnvelopeSarif(synthetic, path);
    },

    /** @throws {ConfigurationError} (→ exit 2) when no baseline exists for `tool`. */
    exportBaselineFingerprints: async (tool, path) => {
      const repo = repoFor();
      if (!repo.exists(tool)) throw missingBaseline(tool);
      const capturedAt = repo.capturedAt(tool);
      /* v8 ignore next 3 -- defensive: exists() returned true above */
      if (capturedAt === undefined) {
        throw new ConfigurationError(
          `Baseline meta row for '${tool}' missing after exists() reported present.`,
          { code: 'CONFIGURATION.GATE.BASELINE_INCONSISTENT' },
        );
      }
      const rows = repo.load(tool);
      const fingerprints = rows.map((r) => r.fingerprint).sort((a, b) => a.localeCompare(b));
      const file = {
        version: '1',
        tool,
        capturedAt: new Date(capturedAt).toISOString(),
        // Reconstruction note: this is a fingerprint list only. It does not
        // contain the original per-unit (check/rule) metadata or validated counts.
        // It is suitable for git-trackable ratchet comparison (graph) and for
        // re-import via --gate-compare style flows that only need identities.
        note: 'reconstructed from baseline entries; units and per-finding details are not preserved',
        signalCount: fingerprints.length,
        fingerprints,
      };
      const serialized = JSON.stringify(file, null, 2);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, serialized, 'utf8');
    },
  };
}
