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

import {
  BASELINE_FORMAT_VERSION,
  ConfigurationError,
  currentScope,
  formatBaselineIdentityMismatch,
  isBaselineIdentityCompatible,
  toBaselineIdentityMetadata,
  type GateCompareResult,
  type Logger,
  SeverityPolicy,
  type Signal,
} from '@opensip-cli/core';
import { BaselineRepo, type DataStore } from '@opensip-cli/datastore';
import { diffBaseline } from '@opensip-cli/output';

import { writeArtifactAtomically } from './atomic-artifact-write.js';
import { writeEnvelopeSarif } from './deliver-envelope.js';
import { resolveStateLockPolicy } from './state-lock-policy.js';

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

function requireEnvelopeBaselineIdentity(tool: string, envelope: SignalEnvelope) {
  const id = envelope.baselineIdentity?.fingerprintStrategyId;
  const version = envelope.baselineIdentity?.fingerprintStrategyVersion;
  if (!id || !Number.isInteger(version) || version < 1) {
    throw new ConfigurationError(
      `saveBaseline(${tool}): envelope is missing baseline identity metadata. ` +
        `Build the envelope with buildSignalEnvelope so strategy id/version are stamped.`,
      { code: 'CONFIGURATION.GATE.BASELINE_IDENTITY_MISSING' },
    );
  }
  return envelope.baselineIdentity;
}

function emitIdentityMismatchDiagnostic(
  tool: string,
  envelope: SignalEnvelope,
  stored: ReturnType<BaselineRepo['loadMeta']>,
): void {
  currentScope()?.diagnostics?.event(
    'load',
    'warn',
    'baseline identity incompatible with stored metadata',
    {
      tool,
      storedStrategyId: stored?.fingerprintStrategyId,
      storedStrategyVersion: stored?.fingerprintStrategyVersion,
      currentStrategyId: envelope.baselineIdentity.fingerprintStrategyId,
      currentStrategyVersion: envelope.baselineIdentity.fingerprintStrategyVersion,
    },
  );
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

  const artifactCtx = () => ({
    policy: resolveStateLockPolicy(),
    logger,
  });

  return {
    // Sync-bodied (SQLite is synchronous) but typed Promise to match the seam
    // contract; a sync throw still rejects for an `await`ing caller.
    saveBaseline: (tool, envelope) => {
      const env = envelope as SignalEnvelope;
      const identity = requireEnvelopeBaselineIdentity(tool, env);
      const entries = requireStampedEntries(tool, env.signals);
      const metadata = toBaselineIdentityMetadata(identity);
      repoFor().save(tool, entries, metadata);
      logger.info({
        evt: 'state.baseline.identity.recorded',
        module: 'cli:baseline-seams',
        tool,
        fingerprintStrategyId: metadata.fingerprintStrategyId,
        fingerprintStrategyVersion: metadata.fingerprintStrategyVersion,
      });
      currentScope()?.diagnostics?.event('persist', 'info', 'baseline identity recorded', {
        tool,
        fingerprintStrategyId: metadata.fingerprintStrategyId,
        fingerprintStrategyVersion: metadata.fingerprintStrategyVersion,
      });
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
      const stored = repo.loadMeta(tool);
      if (!isBaselineIdentityCompatible(env.baselineIdentity, stored)) {
        logger.warn({
          evt: 'state.baseline.identity.mismatch',
          module: 'cli:baseline-seams',
          tool,
          storedStrategyId: stored?.fingerprintStrategyId,
          storedStrategyVersion: stored?.fingerprintStrategyVersion,
          currentStrategyId: env.baselineIdentity.fingerprintStrategyId,
          currentStrategyVersion: env.baselineIdentity.fingerprintStrategyVersion,
        });
        emitIdentityMismatchDiagnostic(tool, env, stored);
        return Promise.reject(
          new ConfigurationError(
            formatBaselineIdentityMismatch(tool, env.baselineIdentity, stored),
            {
              code: 'CONFIGURATION.GATE.BASELINE_IDENTITY_MISMATCH',
            },
          ),
        );
      }
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
      const storedMeta = repo.loadMeta(tool);
      const signals = repo
        .load(tool)
        .map((r) => r.payload)
        .filter((s): s is Signal => s !== null);

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
        baselineIdentity: storedMeta
          ? {
              fingerprintStrategyId: storedMeta.fingerprintStrategyId,
              fingerprintStrategyVersion: storedMeta.fingerprintStrategyVersion,
            }
          : {
              fingerprintStrategyId: 'unknown',
              fingerprintStrategyVersion: 0,
            },
      };
      await writeEnvelopeSarif(synthetic, path, artifactCtx());
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
      const storedMeta = repo.loadMeta(tool);
      const rows = repo.load(tool);
      const fingerprints = rows.map((r) => r.fingerprint).sort((a, b) => a.localeCompare(b));
      const file = {
        version: String(BASELINE_FORMAT_VERSION),
        tool,
        capturedAt: new Date(capturedAt).toISOString(),
        baselineFormatVersion: storedMeta?.baselineFormatVersion ?? null,
        fingerprintStrategyId: storedMeta?.fingerprintStrategyId ?? null,
        fingerprintStrategyVersion: storedMeta?.fingerprintStrategyVersion ?? null,
        note: 'reconstructed from baseline entries; units and per-finding details are not preserved',
        signalCount: fingerprints.length,
        fingerprints,
      };
      const serialized = JSON.stringify(file, null, 2);
      writeArtifactAtomically(path, serialized, artifactCtx());
      await Promise.resolve();
    },
  };
}
