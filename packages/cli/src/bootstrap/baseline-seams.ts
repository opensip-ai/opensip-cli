/**
 * baseline-seams — the host implementations behind the four `ToolCliContext`
 * baseline/ratchet seams (ADR-0036): `saveBaseline`, `compareBaseline`,
 * `exportBaselineSarif`, `exportBaselineFingerprints`.
 *
 * The host owns persistence (`BaselineRepo`), the pure diff (`diffBaseline` from
 * `@opensip-tools/output`), SARIF re-render, and the git-trackable JSON export.
 * The seams are **read-only** of `signal.fingerprint`: the tool stamps its
 * envelope's signals (`stampFingerprints`) at envelope-construction time and the
 * plane NEVER re-fingerprints. Factored out of `cli-context.ts` to keep that
 * file within its size budget.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ConfigurationError, type GateCompareResult, type Logger, type Signal } from '@opensip-tools/core';
import { BaselineRepo, type DataStore } from '@opensip-tools/datastore';
import { diffBaseline } from '@opensip-tools/output';

import { writeEnvelopeSarif } from './deliver-envelope.js';

import type { SignalEnvelope } from '@opensip-tools/contracts';

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
    `No baseline found for '${tool}' in the project SQLite store. ` +
      `Run \`opensip-tools ${tool} --gate-save\` first to capture one.`,
    { code: 'CONFIGURATION.GATE.BASELINE_MISSING' },
  );
}

/** Assert each signal carries a fingerprint — the plane never stamps (ADR-0036). */
function requireStampedEntries(
  tool: string,
  signals: readonly Signal[],
): { fingerprint: string; payload: Signal }[] {
  return signals.map((s) => {
    if (!s.fingerprint) {
      throw new Error(
        `saveBaseline(${tool}): signal ${s.ruleId} is not fingerprint-stamped. The tool must ` +
          `stamp its signals (stampFingerprints) before the seam — the plane never fingerprints.`,
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
    saveBaseline: async (tool, envelope) => {
      const env = envelope as SignalEnvelope;
      const entries = requireStampedEntries(tool, env.signals);
      repoFor().save(tool, entries);
      logger.info({
        evt: 'cli.baseline.save.complete',
        module: 'cli:baseline-seams',
        tool,
        count: entries.length,
      });
    },

    compareBaseline: async (tool, envelope) => {
      const repo = repoFor();
      if (!repo.exists(tool)) throw missingBaseline(tool);
      const env = envelope as SignalEnvelope;
      return diffBaseline(env.signals, repo.load(tool));
    },

    exportBaselineSarif: async (tool, path) => {
      const repo = repoFor();
      if (!repo.exists(tool)) throw missingBaseline(tool);
      const signals = repo
        .load(tool)
        .map((r) => r.payload)
        .filter((s): s is Signal => s !== null);
      // SARIF export RECONSTRUCTS (no stored envelope): formatSignalSarif derives
      // results from `signals` + the driver name from `tool` only, so the other
      // envelope fields are inert filler.
      const synthetic: SignalEnvelope = {
        schemaVersion: 2,
        tool: tool as SignalEnvelope['tool'],
        runId: 'baseline',
        createdAt: new Date(repo.capturedAt(tool) ?? 0).toISOString(),
        verdict: {
          score: 0,
          passed: true,
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
        },
        units: [],
        signals,
      };
      await writeEnvelopeSarif(synthetic, path);
    },

    exportBaselineFingerprints: async (tool, path) => {
      const repo = repoFor();
      if (!repo.exists(tool)) throw missingBaseline(tool);
      const capturedAt = repo.capturedAt(tool);
      /* v8 ignore next 3 -- defensive: exists() returned true above */
      if (capturedAt === undefined) {
        throw new Error(`Baseline meta row for '${tool}' missing after exists() reported present.`);
      }
      const fingerprints = repo
        .load(tool)
        .map((r) => r.fingerprint)
        .sort((a, b) => a.localeCompare(b));
      const file = {
        version: '1',
        tool,
        capturedAt: new Date(capturedAt).toISOString(),
        fingerprints,
      };
      const serialized = JSON.stringify(file, null, 2);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, serialized, 'utf8');
    },
  };
}
