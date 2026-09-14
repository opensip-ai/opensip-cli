/**
 * ADR-0020 + ADR-0035: `fit --gate-save` (the `fit:ci` dogfood gate) must
 * HARD-FAIL the step on a fail-threshold breach, not exit 0 and lean on the
 * downstream Code Scanning ratchet. Post-ADR-0035 the hard-fail is the single
 * host verdict: gate-save delivers the run envelope WITHOUT a `runFailed`
 * override, and the host derives the findings exit from `envelope.verdict.passed`
 * (the RUNTIME_ERROR mapping itself is pinned in envelope-routing.test.ts). These
 * tests assert gate-save reaches delivery with the correct envelope verdict.
 *
 * `executeFit` is mocked so the test drives the gate verdict directly via the
 * run envelope's `verdict.passed`.
 */

import { type FitOptions, type SignalEnvelope } from '@opensip-cli/contracts';
import {
  createRunTimer,
  LanguageRegistry,
  RunScope,
  runWithScope,
  ToolRegistry,
  type ToolCliContext,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../fit.js', () => ({ executeFit: vi.fn() }));

import { fitnessConfigDeclaration } from '../../config/fitness-config-schema.js';
import { FITNESS_IDENTITY, FITNESS_LAYOUT_KEY } from '../../identity.js';
import { runGateMode } from '../fit-modes.js';
import { executeFit } from '../fit.js';

let datastore: DataStore;

/** A run envelope whose single verdict is `passed` (the host's exit driver). */
const envelopeWith = (passed: boolean): SignalEnvelope =>
  ({
    tool: 'fitness',
    schemaVersion: 2,
    units: [],
    signals: [],
    verdict: { passed, score: passed ? 100 : 0, summary: {} },
  }) as unknown as SignalEnvelope;

/** A successful executeFit result carrying the given verdict envelope. */
const fitResult = (passed: boolean): Awaited<ReturnType<typeof executeFit>> => {
  const envelope = envelopeWith(passed);
  return {
    result: { type: 'run-presentation', tool: 'fitness', envelope },
    envelope,
  } as unknown as Awaited<ReturnType<typeof executeFit>>;
};

function mockCli(opts: { readonly degraded?: boolean } = {}): {
  cli: ToolCliContext;
  setExitCode: ReturnType<typeof vi.fn>;
  deliverSignals: ReturnType<typeof vi.fn>;
  saveBaseline: ReturnType<typeof vi.fn>;
  compareBaseline: ReturnType<typeof vi.fn>;
} {
  const setExitCode = vi.fn();
  const deliverSignals = vi.fn(() => Promise.resolve());
  const saveBaseline = vi.fn(() => Promise.resolve());
  const compareBaseline = vi.fn(() =>
    Promise.resolve({
      added: [],
      resolved: [],
      unchanged: [],
      degraded: opts.degraded ?? false,
    }),
  );
  const cli = {
    setExitCode,
    deliverSignals,
    render: vi.fn(() => Promise.resolve()),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    emitJson: vi.fn(),
    logger: console,
    // ADR-0036 host baseline seams — gate-save/compare route persistence + diff
    // through these (the host owns them); no-op stubs suffice for the exit/deliver
    // contract these tests assert.
    saveBaseline,
    compareBaseline,
    exportBaselineSarif: vi.fn(() => Promise.resolve()),
    exportBaselineFingerprints: vi.fn(() => Promise.resolve()),
    scope: { datastore: () => datastore },
    runSession: {
      timing: createRunTimer(),
      record: () => undefined,
    },
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
  return { cli, setExitCode, deliverSignals, saveBaseline, compareBaseline };
}

function gateSaveArgs(): FitOptions {
  return {
    json: false,
    list: false,
    recipes: false,
    verbose: false,
    debug: false,
    quiet: true,
    open: false,
    cwd: '/x',
    exclude: [],
    gateSave: true,
    gateCompare: false,
  };
}

function gateCompareArgs(): FitOptions {
  return {
    ...gateSaveArgs(),
    gateSave: false,
    gateCompare: true,
  };
}

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  vi.clearAllMocks();
});

afterEach(() => {
  datastore.close();
  vi.restoreAllMocks();
});

describe('runGateMode --gate-save (ADR-0020 hard-fail via the host verdict)', () => {
  it('delivers a failing-verdict envelope WITHOUT a runFailed override (the host hard-fails on verdict.passed=false)', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(false));
    const { cli, deliverSignals } = mockCli();

    await runGateMode(gateSaveArgs(), cli);

    // The baseline is still delivered even when the gate fails (SARIF export runs
    // in a separate `if: always()` CI step). gate-save's findings gate IS the host
    // verdict, so it passes no override — the host sets RUNTIME_ERROR from
    // envelope.verdict.passed=false (mapping pinned in envelope-routing.test.ts).
    expect(deliverSignals).toHaveBeenCalledTimes(1);
    const [deliveredEnvelope, opts] = deliverSignals.mock.calls[0] ?? [];
    expect((deliveredEnvelope as SignalEnvelope).verdict.passed).toBe(false);
    expect(opts).not.toHaveProperty('runFailed');
  });

  it('delivers a passing-verdict envelope when the run is clean', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(true));
    const { cli, deliverSignals } = mockCli();

    await runGateMode(gateSaveArgs(), cli);

    expect(deliverSignals).toHaveBeenCalledTimes(1);
    const [deliveredEnvelope, opts] = deliverSignals.mock.calls[0] ?? [];
    expect((deliveredEnvelope as SignalEnvelope).verdict.passed).toBe(true);
    expect(opts).not.toHaveProperty('runFailed');
  });
});

describe('runGateMode --gate-compare (ADR-0036 failOnDegraded)', () => {
  it('passes the host runFailed override as false when a degraded compare is configured as report-only', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(true));
    const { cli, deliverSignals } = mockCli({ degraded: true });
    const scope = new RunScope({
      languages: new LanguageRegistry(),
      tools: new ToolRegistry(),
    });
    Object.assign(scope, {
      toolConfig: { fitness: { failOnDegraded: false } },
    });

    await runWithScope(scope, () => runGateMode(gateCompareArgs(), cli));

    expect(deliverSignals).toHaveBeenCalledTimes(1);
    const [, opts] = deliverSignals.mock.calls[0] ?? [];
    expect(opts).toMatchObject({ cwd: '/x', runFailed: false });
  });
});

/**
 * Regression: the gate wrote the baseline under the CANONICAL tool name
 * ('fitness'), but every reader resolves a tool by its SHORT id
 * (`identity.layoutKey ?? identity.name` → 'fit'). MCP's `compare_to_baseline`
 * therefore rejected `tool: 'fitness'` as unknown AND found nothing for
 * `tool: 'fit'` — no argument could ever reach the fitness baseline, so a user
 * who had just run `fit --gate-save` was told "No stored baseline exists for
 * fit. Run opensip fit --gate-save to capture one."
 */
describe('runGateMode baseline namespace (short-id regression)', () => {
  it('saves the baseline under fitness SHORT id, which is what tool resolvers expose', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(true));
    const { cli, saveBaseline } = mockCli();

    await runGateMode(gateSaveArgs(), cli);

    const [namespace] = saveBaseline.mock.calls[0] ?? [];
    expect(namespace).toBe('fit');
    // The short id is exactly what a tool resolver (e.g. MCP's validToolIds)
    // derives from the tool identity — pinned so the two cannot drift apart.
    expect(FITNESS_IDENTITY.layoutKey ?? FITNESS_IDENTITY.name).toBe(namespace);
    expect(FITNESS_LAYOUT_KEY).toBe('fit');
  });

  it('compares against the same short-id namespace it saved under', async () => {
    vi.mocked(executeFit).mockResolvedValue(fitResult(true));
    const { cli, compareBaseline } = mockCli();

    await runGateMode(gateCompareArgs(), cli);

    expect(compareBaseline.mock.calls[0]?.[0]).toBe(FITNESS_LAYOUT_KEY);
  });

  it('still honours the `fitness:` config block for failOnDegraded after the namespace split', async () => {
    // The baseline namespace ('fit') and the CONFIG namespace ('fitness') are
    // deliberately different keys; the compare policy must keep reading the
    // config one, otherwise `fitness.failOnDegraded: false` silently stops working.
    vi.mocked(executeFit).mockResolvedValue(fitResult(true));
    const { cli, deliverSignals } = mockCli({ degraded: true });
    const scope = new RunScope({
      languages: new LanguageRegistry(),
      tools: new ToolRegistry(),
    });
    Object.assign(scope, { toolConfig: { fitness: { failOnDegraded: false } } });

    await runWithScope(scope, () => runGateMode(gateCompareArgs(), cli));

    expect(fitnessConfigDeclaration.namespace).toBe(FITNESS_IDENTITY.name);
    expect(fitnessConfigDeclaration.namespace).not.toBe(FITNESS_LAYOUT_KEY);
    const [, opts] = deliverSignals.mock.calls[0] ?? [];
    expect(opts).toMatchObject({ runFailed: false });
  });
});
