// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/**
 * Unit tests for the architecture-gate primitive (v2 — SQLite-backed).
 *
 * Covers:
 *   - saveBaseline: persists the run signal envelope to fit_baseline; idempotent overwrite
 *   - compareToBaseline: classifies added/resolved/unchanged correctly
 *   - Hash matching ignores line-number changes (D3 in plan.md)
 *   - Missing/invalid baseline → typed errors
 *   - renderGateCompareOutput: formats sections correctly per state
 */

import { buildSignalEnvelope, type SignalEnvelope } from '@opensip-tools/contracts';
import { createSignal, HOST_VERDICT_POLICY_FALLBACK, type Signal } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GateBaselineMissingError,
  GateBaselineInvalidError,
  DEFAULT_VIOLATION_IDENTITY,
  type GateCompareResult,
  type ViolationIdentity,
} from '../gate.js';
import { FitBaselineRepo } from '../persistence/baseline-repo.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A check violation, as the fitness check framework hands it to the signaler. */
interface FindingInput {
  ruleId?: string;
  message?: string;
  severity?: 'error' | 'warning';
  filePath?: string;
  line?: number;
}

/**
 * Build a core {@link Signal} mirroring fitness's violation→signal mapping
 * (`error → high`, `warning → medium`; `source === ruleId === checkSlug`). The
 * gate diffs on `(filePath, ruleId, message)`, which round-trip unchanged.
 */
function makeFinding(overrides: FindingInput = {}): Signal {
  const ruleId = overrides.ruleId ?? 'no-console-log';
  return createSignal({
    source: ruleId,
    ruleId,
    message: overrides.message ?? 'console.log found',
    severity: (overrides.severity ?? 'error') === 'error' ? 'high' : 'medium',
    code: { file: overrides.filePath ?? 'src/index.ts', line: overrides.line ?? 42 },
  });
}

/** Build a fit {@link SignalEnvelope} carrying the given signals (one unit). */
function makeOutput(findings: Signal[] = [makeFinding()]): SignalEnvelope {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'run_test',
    createdAt: '2026-05-03T00:00:00.000Z',
    units: [{ slug: 'no-console-log', passed: false, durationMs: 50 }],
    signals: findings,
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

let datastore: DataStore;
let repo: FitBaselineRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new FitBaselineRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

// ---------------------------------------------------------------------------
// saveBaseline
// ---------------------------------------------------------------------------

/** An empty fit envelope (no checks ran, no signals). */
function emptyOutput(): SignalEnvelope {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'run_test',
    createdAt: '2026-05-03T00:00:00.000Z',
    units: [],
    signals: [],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

describe('saveBaseline', () => {
  it('writes the run signal envelope to the SQLite baseline table', () => {
    saveBaseline(makeOutput(), repo);
    const doc = repo.load() as { schemaVersion: number; signals: unknown[] };
    expect(doc.schemaVersion).toBe(2);
    expect(Array.isArray(doc.signals)).toBe(true);
    expect(doc.signals.length).toBe(1);
  });

  it('overwrites an existing baseline row', () => {
    saveBaseline(makeOutput([makeFinding({ message: 'first' })]), repo);
    saveBaseline(makeOutput([makeFinding({ message: 'second' })]), repo);
    const doc = repo.load() as { signals: { message: string }[] };
    expect(doc.signals[0]?.message).toBe('second');
  });

  it('writes an empty signals array when there are no findings', () => {
    saveBaseline(emptyOutput(), repo);
    const doc = repo.load() as { signals: unknown[] };
    expect(doc.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — happy paths
// ---------------------------------------------------------------------------

describe('compareToBaseline — classification', () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- closes over `repo` from beforeEach
  const setupBaseline = (findings: Signal[]): void => {
    saveBaseline(makeOutput(findings), repo);
  };

  it('reports STABLE when current matches baseline exactly', () => {
    const findings = [makeFinding()];
    setupBaseline(findings);
    const result = compareToBaseline(makeOutput(findings), repo);

    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it('reports DEGRADED when current has new violations', () => {
    setupBaseline([makeFinding({ filePath: 'a.ts', message: 'old' })]);
    const result = compareToBaseline(
      makeOutput([
        makeFinding({ filePath: 'a.ts', message: 'old' }),
        makeFinding({ filePath: 'b.ts', message: 'new' }),
      ]),
      repo,
    );

    expect(result.added.length).toBe(1);
    expect(result.added[0]?.filePath).toBe('b.ts');
    expect(result.added[0]?.message).toBe('new');
    expect(result.unchanged.length).toBe(1);
    expect(result.resolved).toEqual([]);
    expect(result.degraded).toBe(true);
  });

  it('reports IMPROVED when violations are resolved with no new ones', () => {
    setupBaseline([
      makeFinding({ filePath: 'a.ts', message: 'old1' }),
      makeFinding({ filePath: 'b.ts', message: 'old2' }),
    ]);
    const result = compareToBaseline(
      makeOutput([makeFinding({ filePath: 'a.ts', message: 'old1' })]),
      repo,
    );

    expect(result.added).toEqual([]);
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]?.filePath).toBe('b.ts');
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it('reports both added and resolved in a mixed change set', () => {
    setupBaseline([
      makeFinding({ filePath: 'kept.ts', message: 'kept' }),
      makeFinding({ filePath: 'gone.ts', message: 'gone' }),
    ]);
    const result = compareToBaseline(
      makeOutput([
        makeFinding({ filePath: 'kept.ts', message: 'kept' }),
        makeFinding({ filePath: 'new.ts', message: 'new' }),
      ]),
      repo,
    );

    expect(result.added.length).toBe(1);
    expect(result.added[0]?.filePath).toBe('new.ts');
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]?.filePath).toBe('gone.ts');
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(true);
  });

  it('handles fully empty baseline and current', () => {
    saveBaseline(emptyOutput(), repo);
    const result = compareToBaseline(emptyOutput(), repo);

    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — D3 invariant: line shifts don't matter
// ---------------------------------------------------------------------------

describe('compareToBaseline — line-number invariance (D3)', () => {
  it('treats same (file, ruleId, message) at different lines as UNCHANGED', () => {
    saveBaseline(makeOutput([makeFinding({ line: 42 })]), repo);
    const result = compareToBaseline(makeOutput([makeFinding({ line: 50 })]), repo);

    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it('treats different message on same (file, ruleId) as added+resolved', () => {
    saveBaseline(
      makeOutput([makeFinding({ ruleId: 'complex-function', filePath: 'x.ts', message: 'cc=22' })]),
      repo,
    );
    const result = compareToBaseline(
      makeOutput([makeFinding({ ruleId: 'complex-function', filePath: 'x.ts', message: 'cc=28' })]),
      repo,
    );

    expect(result.added.length).toBe(1);
    expect(result.added[0]?.message).toBe('cc=28');
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0]?.message).toBe('cc=22');
    expect(result.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — error paths
// ---------------------------------------------------------------------------

describe('compareToBaseline — errors', () => {
  it('throws GateBaselineMissingError when no baseline row exists', () => {
    expect(() => compareToBaseline(makeOutput(), repo)).toThrow(GateBaselineMissingError);
  });

  it('throws GateBaselineInvalidError when payload top-level is not an object', () => {
    // Force-write a malformed payload to exercise the error branch.
    repo.save('"a string"', 0);
    expect(() => compareToBaseline(makeOutput(), repo)).toThrow(GateBaselineInvalidError);
  });

  it('throws GateBaselineInvalidError when signals is missing', () => {
    repo.save({ schemaVersion: 2 }, 0);
    expect(() => compareToBaseline(makeOutput(), repo)).toThrow(GateBaselineInvalidError);
  });

  it('throws GateBaselineInvalidError when signals is not an array', () => {
    repo.save({ schemaVersion: 2, signals: 'oops' }, 0);
    expect(() => compareToBaseline(makeOutput(), repo)).toThrow(GateBaselineInvalidError);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — round-trips the stored envelope baseline
// ---------------------------------------------------------------------------

describe('compareToBaseline — stored-envelope round-trip', () => {
  it('matches a baseline persisted by saveBaseline on (filePath, ruleId, message)', () => {
    saveBaseline(
      makeOutput([makeFinding({ filePath: 'a.ts', ruleId: 'kept', message: 'kept message' })]),
      repo,
    );
    const result = compareToBaseline(
      makeOutput([makeFinding({ filePath: 'a.ts', ruleId: 'kept', message: 'kept message' })]),
      repo,
    );
    expect(result.unchanged.length).toBe(1);
    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it('handles findings with no location (empty filePath)', () => {
    const globalSig = makeFinding({
      ruleId: 'global-rule',
      message: 'global issue',
      severity: 'warning',
    });
    // A check-wide finding with no file site: strip the location off the signal.
    const noLoc: Signal = { ...globalSig, filePath: '', line: undefined, code: undefined };
    saveBaseline(makeOutput([noLoc]), repo);
    const result = compareToBaseline(makeOutput([noLoc]), repo);
    expect(result.unchanged.length).toBe(1);
    expect(result.added).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderGateCompareOutput
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<GateCompareResult> = {}): GateCompareResult {
  return {
    added: [],
    resolved: [],
    unchanged: [],
    degraded: false,
    ...overrides,
  };
}

describe('renderGateCompareOutput', () => {
  it('shows STABLE when nothing changed', () => {
    const text = renderGateCompareOutput(makeResult());
    expect(text).toContain('STABLE');
    expect(text).not.toContain('Added');
    expect(text).not.toContain('Resolved');
  });

  it('shows DEGRADED with added section when violations were introduced', () => {
    const text = renderGateCompareOutput(
      makeResult({
        added: [
          {
            hash: 'h1',
            ruleId: 'circular-import',
            message: 'a.ts → b.ts → a.ts',
            filePath: 'a.ts',
            severity: 'error',
          },
        ],
        degraded: true,
      }),
    );

    expect(text).toContain('DEGRADED');
    expect(text).toContain('Added (1)');
    expect(text).toContain('circular-import');
    expect(text).toContain('a.ts');
    expect(text).toContain('1 new violation');
  });

  it('shows IMPROVED when violations resolved and none added', () => {
    const text = renderGateCompareOutput(
      makeResult({
        resolved: [
          {
            hash: 'h1',
            ruleId: 'dead-code',
            message: 'unused export `foo`',
            filePath: 'x.ts',
            line: 10,
            severity: 'warning',
          },
        ],
      }),
    );

    expect(text).toContain('IMPROVED');
    expect(text).toContain('Resolved (1)');
    expect(text).toContain('dead-code');
  });

  it('truncates the unchanged section to a sample', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      hash: `h${i}`,
      ruleId: 'rule',
      message: `m${i}`,
      filePath: `f${i}.ts`,
      severity: 'warning' as const,
    }));
    const text = renderGateCompareOutput(makeResult({ unchanged: many }));
    expect(text).toContain('Unchanged (25)');
    // Only 5 sampled lines, then "... and 20 more"
    expect(text).toContain('... and 20 more');
  });

  it('truncates very long violation messages with an ellipsis', () => {
    const longMessage = 'x'.repeat(150);
    const text = renderGateCompareOutput(
      makeResult({
        added: [
          {
            hash: 'h1',
            ruleId: 'long-rule',
            message: longMessage,
            filePath: 'f.ts',
            severity: 'error',
          },
        ],
        degraded: true,
      }),
    );
    // truncate(message, 120) keeps 119 chars + ellipsis. The full
    // 150-char string MUST NOT appear.
    expect(text).not.toContain(longMessage);
    expect(text).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// Custom ViolationIdentity strategy
// ---------------------------------------------------------------------------

// Custom identity used by the test below. Keyed by (filePath, ruleId) only —
// drops `message` from the comparison so wording edits don't register as
// new/resolved violations. Defined at module scope to satisfy
// unicorn/consistent-function-scoping.
const identityIgnoringMessage: ViolationIdentity = ({ filePath, ruleId }) =>
  `${filePath}::${ruleId}`;

describe('compareToBaseline — custom violation-identity strategy', () => {
  it('treats two same-rule same-file findings as identical when identity ignores message', () => {
    saveBaseline(makeOutput([makeFinding({ filePath: 'a.ts', message: 'old phrasing' })]), repo);

    // The default identity would mark this as `added` (different message).
    // The custom (filePath, ruleId) identity treats them as identical.
    const result = compareToBaseline(
      makeOutput([makeFinding({ filePath: 'a.ts', message: 'new phrasing' })]),
      repo,
      identityIgnoringMessage,
    );
    expect(result.added.length).toBe(0);
    expect(result.resolved.length).toBe(0);
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it('default identity preserves the (filePath, ruleId, message) semantics', () => {
    saveBaseline(makeOutput([makeFinding({ filePath: 'a.ts', message: 'old' })]), repo);

    // Default identity sees a different message → that violation is
    // resolved (the baseline message no longer present), and the new
    // message counts as added.
    const result = compareToBaseline(
      makeOutput([makeFinding({ filePath: 'a.ts', message: 'new' })]),
      repo,
      DEFAULT_VIOLATION_IDENTITY,
    );
    expect(result.added.length).toBe(1);
    expect(result.resolved.length).toBe(1);
    expect(result.unchanged.length).toBe(0);
    expect(result.degraded).toBe(true);
  });
});
