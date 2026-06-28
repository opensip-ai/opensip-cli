/**
 * Gate-ratchet branch of the scan run loop (ADR-0036). The run loop itself is the
 * IO orchestration excluded from coverage; these tests drive its `--gate-save` /
 * `--gate-compare` decision branch directly with a stub `ToolCliContext` + stub IO
 * deps, asserting the host baseline seams + the runFailed exit override are wired
 * the same way fit's `runGateMode` wires them. The full ratchet over a REAL forked
 * worker lives in tool-gitleaks's worker E2E (§4.12).
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  createSignal,
  type GateCompareResult,
  type Signal,
  type ToolCliContext,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { messageHashFingerprintStrategy } from '../fingerprint.js';
import { runScanLoop, type ScanLoopDeps, type ScanLoopInput } from '../run-loop.js';

import type { BinarySpec, ExternalCommandSpec } from '../types.js';

const TWO_FINDINGS: readonly Signal[] = [
  createSignal({
    source: 'examplescan',
    severity: 'high',
    ruleId: 'aws-key',
    message: 'AWS Access Key',
    code: { file: 'config/prod.env', line: 12 },
  }),
  createSignal({
    source: 'examplescan',
    severity: 'high',
    ruleId: 'gitlab-pat',
    message: 'GitLab PAT',
    code: { file: 'src/client.ts', line: 4 },
  }),
];

function makeCli(compareResult?: GateCompareResult): {
  cli: ToolCliContext;
  spies: {
    saveBaseline: ReturnType<typeof vi.fn>;
    compareBaseline: ReturnType<typeof vi.fn>;
    deliverSignals: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    emitEnvelope: ReturnType<typeof vi.fn>;
    reportFailure: ReturnType<typeof vi.fn>;
    writeArtifact: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    saveBaseline: vi.fn(() => Promise.resolve()),
    compareBaseline: vi.fn(() =>
      Promise.resolve(compareResult ?? { added: [], resolved: [], unchanged: [], degraded: false }),
    ),
    deliverSignals: vi.fn(() => Promise.resolve({ cloudAccepted: 0 })),
    render: vi.fn(() => Promise.resolve()),
    emitEnvelope: vi.fn(),
    reportFailure: vi.fn(() => Promise.resolve()),
    writeArtifact: vi.fn(() => Promise.resolve()),
  };
  const cli = {
    ...spies,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    scope: {
      toolConfig: {},
      projectContext: { projectRoot: '/proj', configPath: '/proj/opensip-cli.config.yml' },
      runId: 'RUN_test',
    },
  } as unknown as ToolCliContext;
  return { cli, spies };
}

const COMMAND: ExternalCommandSpec = {
  name: 'scan',
  args: (ctx) => ['scan', ctx.projectRoot],
  output: { kind: 'json', path: 'scan.json' },
  exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
  parse: () => TWO_FINDINGS,
};

const BINARY: BinarySpec = { command: 'examplescan', versionArgs: ['version'] };

/** IO-deps stub: a found binary, a findings exit, a valid (non-empty) artifact. */
function makeDeps(): Partial<ScanLoopDeps> {
  return {
    binaryDeps: { existsSync: () => true, which: () => '/usr/bin/examplescan' },
    runProcess: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: false }),
    probeVersion: () => '1.2.3',
    readFile: () => '[{"RuleID":"aws-key"},{"RuleID":"gitlab-pat"}]',
    fileSize: () => 42,
    env: {},
  };
}

function input(cli: ToolCliContext, opts: Record<string, unknown>): ScanLoopInput {
  return {
    cli,
    tool: 'examplescan',
    adapterPackage: '@opensip-cli/tool-example',
    command: COMMAND,
    binary: BINARY,
    fingerprintStrategy: messageHashFingerprintStrategy,
    opts,
  };
}

describe('runScanLoop — gate-ratchet branch (ADR-0036)', () => {
  it('rejects --gate-save + --gate-compare together (mutual exclusion → reportFailure, no scan)', async () => {
    const { cli, spies } = makeCli();
    const runProcess = vi.fn(() =>
      Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }),
    );
    const completion = await runScanLoop(input(cli, { gateSave: true, gateCompare: true }), {
      ...makeDeps(),
      runProcess,
    });
    expect(completion).toBeUndefined();
    expect(spies.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: EXIT_CODES.CONFIGURATION_ERROR }),
    );
    // Fail-fast: the scanner subprocess never ran, and no baseline seam was touched.
    expect(runProcess).not.toHaveBeenCalled();
    expect(spies.saveBaseline).not.toHaveBeenCalled();
    expect(spies.compareBaseline).not.toHaveBeenCalled();
  });

  it('--gate-save saves the baseline, renders gate-done, and delivers without a runFailed override', async () => {
    const { cli, spies } = makeCli();
    const completion = await runScanLoop(input(cli, { gateSave: true }), makeDeps());

    expect(spies.saveBaseline).toHaveBeenCalledWith(
      'examplescan',
      expect.objectContaining({ tool: 'examplescan' }),
    );
    expect(spies.render).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gate-done',
        lines: expect.arrayContaining([expect.stringContaining('baseline saved')]),
      }),
    );
    // gate-save omits runFailed → the host derives the findings exit from the verdict.
    expect(spies.deliverSignals).toHaveBeenCalledTimes(1);
    expect(
      (spies.deliverSignals.mock.calls[0][1] as { runFailed?: boolean }).runFailed,
    ).toBeUndefined();
    // A gate run still persists a session.
    expect(completion?.session.tool).toBe('examplescan');
    expect(completion?.session.payload.findings).toBe(2);
  });

  it('--gate-compare clean (not degraded) renders the diff and delivers runFailed=false', async () => {
    const { cli, spies } = makeCli({
      added: [],
      resolved: [],
      unchanged: [...TWO_FINDINGS],
      degraded: false,
    });
    await runScanLoop(input(cli, { gateCompare: true }), makeDeps());

    expect(spies.compareBaseline).toHaveBeenCalledWith(
      'examplescan',
      expect.objectContaining({ tool: 'examplescan' }),
    );
    expect(spies.render).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gate-done', lines: expect.any(Array) }),
    );
    expect((spies.deliverSignals.mock.calls[0][1] as { runFailed?: boolean }).runFailed).toBe(
      false,
    );
    expect(spies.saveBaseline).not.toHaveBeenCalled();
  });

  it('--gate-compare degraded (net-new finding) delivers runFailed=true', async () => {
    const newFinding = createSignal({
      source: 'examplescan',
      severity: 'high',
      ruleId: 'stripe-key',
      message: 'Stripe key',
      code: { file: 'src/pay.ts', line: 1 },
    });
    const { cli, spies } = makeCli({
      added: [newFinding],
      resolved: [],
      unchanged: [...TWO_FINDINGS],
      degraded: true,
    });
    await runScanLoop(input(cli, { gateCompare: true }), makeDeps());
    expect((spies.deliverSignals.mock.calls[0][1] as { runFailed?: boolean }).runFailed).toBe(true);
  });

  it('the no-gate path is unaffected: emits the envelope (--json) and delivers without runFailed', async () => {
    const { cli, spies } = makeCli();
    const completion = await runScanLoop(input(cli, { json: true }), makeDeps());
    expect(spies.emitEnvelope).toHaveBeenCalledTimes(1);
    expect(spies.saveBaseline).not.toHaveBeenCalled();
    expect(spies.compareBaseline).not.toHaveBeenCalled();
    expect(
      (spies.deliverSignals.mock.calls[0][1] as { runFailed?: boolean }).runFailed,
    ).toBeUndefined();
    expect(completion?.envelope.tool).toBe('examplescan');
  });

  it('the no-gate, no-json path renders the human summary and delivers without runFailed', async () => {
    const { cli, spies } = makeCli();
    await runScanLoop(input(cli, {}), makeDeps());
    expect(spies.emitEnvelope).not.toHaveBeenCalled();
    expect(spies.render).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text-lines', title: 'examplescan scan' }),
    );
    expect(
      (spies.deliverSignals.mock.calls[0][1] as { runFailed?: boolean }).runFailed,
    ).toBeUndefined();
  });
});
