/**
 * Exit-model REACTION branch of the scan run loop (ADR-0091 Phase-0 decision 4).
 *
 * `interpretExit`'s classification is unit-tested directly (exit-model.test.ts) and
 * per-adapter (each tool.test.ts). What those do NOT cover is how `runScanLoop`
 * REACTS: the §4.12 acceptance row "verdict/exit correct for clean / findings /
 * scanner-error exit codes". The findings row is proven end-to-end by every
 * adapter's worker E2E; this fills the other two at the substrate level (the run
 * loop is substrate-owned — adapters only declare the exit-model data):
 *   - a scanner-ERROR exit FAULTS (throws ADAPTER.SCAN.FAULT) — it must NOT silently
 *     emit a clean 0-findings envelope (the highest-risk misclassification, §4.6);
 *   - the gitleaks disambiguation (exit 1 + missing/garbage artifact) also faults;
 *   - a CLEAN exit (0 findings) emits a passing envelope through the host seams,
 *     never a fault.
 *
 * Drives `runScanLoop` directly with a stub `ToolCliContext` + stub IO deps — the
 * same substrate-unit pattern as run-loop-gate.test.ts (run-loop.ts is excluded
 * from coverage as IO orchestration; this asserts behavior, not coverage).
 */

import { createSignal, type Signal, type ToolCliContext } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { messageHashFingerprintStrategy } from '../fingerprint.js';
import { runScanLoop, type ScanLoopDeps, type ScanLoopInput } from '../run-loop.js';

import type { BinarySpec, ExternalCommandSpec } from '../types.js';

function makeCli(): {
  cli: ToolCliContext;
  spies: {
    deliverSignals: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    emitEnvelope: ReturnType<typeof vi.fn>;
    reportFailure: ReturnType<typeof vi.fn>;
    writeArtifact: ReturnType<typeof vi.fn>;
    saveBaseline: ReturnType<typeof vi.fn>;
    compareBaseline: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    deliverSignals: vi.fn(() => Promise.resolve({ cloudAccepted: 0 })),
    render: vi.fn(() => Promise.resolve()),
    emitEnvelope: vi.fn(),
    reportFailure: vi.fn(() => Promise.resolve()),
    writeArtifact: vi.fn(() => Promise.resolve()),
    saveBaseline: vi.fn(() => Promise.resolve()),
    compareBaseline: vi.fn(() =>
      Promise.resolve({ added: [], resolved: [], unchanged: [], degraded: false }),
    ),
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

/** gitleaks-shaped model: 0 clean, 1 findings, >=2 fault. */
const GITLEAKS_MODEL = { ok: [0], findings: [1], errorFrom: 2 } as const;

function command(parse: ExternalCommandSpec['parse']): ExternalCommandSpec {
  return {
    name: 'scan',
    args: (ctx) => ['scan', ctx.projectRoot],
    output: { kind: 'json', path: 'scan.json' },
    exitCodes: GITLEAKS_MODEL,
    parse,
  };
}

const BINARY: BinarySpec = { command: 'examplescan', versionArgs: ['version'] };

/** IO-deps stub: a found binary; `code`/`artifact` per case. */
function makeDeps(code: number, artifact: string): Partial<ScanLoopDeps> {
  return {
    binaryDeps: { existsSync: () => true, which: () => '/usr/bin/examplescan' },
    runProcess: () => Promise.resolve({ code, stdout: '', stderr: 'boom', timedOut: false }),
    probeVersion: () => '1.2.3',
    readFile: () => artifact,
    fileSize: () => artifact.length,
    env: {},
  };
}

function input(
  cli: ToolCliContext,
  cmd: ExternalCommandSpec,
  opts: Record<string, unknown> = {},
): ScanLoopInput {
  return {
    cli,
    tool: 'examplescan',
    adapterPackage: '@opensip-cli/tool-example',
    command: cmd,
    binary: BINARY,
    fingerprintStrategy: messageHashFingerprintStrategy,
    opts,
  };
}

const ONE_FINDING: readonly Signal[] = [
  createSignal({
    source: 'examplescan',
    severity: 'high',
    ruleId: 'aws-key',
    message: 'AWS Access Key',
    code: { file: 'config/prod.env', line: 12 },
  }),
];

describe('runScanLoop — scanner-error exit ⇒ fault (never a silent clean scan)', () => {
  it('a fault exit code (>= errorFrom) throws ADAPTER.SCAN.FAULT and emits nothing', async () => {
    const { cli, spies } = makeCli();
    // A parse that WOULD return zero findings — proving the fault path is taken on
    // the exit code, not silently turned into a clean 0-findings emit.
    await expect(
      runScanLoop(
        input(
          cli,
          command(() => []),
        ),
        makeDeps(2, '[]'),
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER.SCAN.FAULT' });

    expect(spies.writeArtifact).not.toHaveBeenCalled();
    expect(spies.deliverSignals).not.toHaveBeenCalled();
    expect(spies.emitEnvelope).not.toHaveBeenCalled();
    expect(spies.render).not.toHaveBeenCalled();
  });

  it('the gitleaks disambiguation: exit 1 + missing/garbage artifact ⇒ fault', async () => {
    const { cli, spies } = makeCli();
    // Exit 1 is the `findings` code, but an empty/unparseable artifact downgrades
    // it to a fault — it must NOT be reported as findings.
    await expect(
      runScanLoop(
        input(
          cli,
          command(() => ONE_FINDING),
        ),
        makeDeps(1, ''),
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER.SCAN.FAULT' });

    expect(spies.writeArtifact).not.toHaveBeenCalled();
    expect(spies.deliverSignals).not.toHaveBeenCalled();
  });
});

describe('runScanLoop — clean exit ⇒ passing envelope through the host seams', () => {
  it('exit 0 with zero findings persists the artifact and delivers a passing verdict (no fault)', async () => {
    const { cli, spies } = makeCli();
    const completion = await runScanLoop(
      input(
        cli,
        command(() => []),
      ),
      makeDeps(0, '[]'),
    );

    expect(spies.reportFailure).not.toHaveBeenCalled();
    expect(spies.writeArtifact).toHaveBeenCalledTimes(1);
    expect(completion?.envelope.tool).toBe('examplescan');
    expect(completion?.envelope.verdict.passed).toBe(true);
    expect(completion?.session.payload.findings).toBe(0);
    // No-gate, no-json path: human summary, delivered without a runFailed override.
    expect(spies.emitEnvelope).not.toHaveBeenCalled();
    expect(
      (spies.deliverSignals.mock.calls[0]?.[1] as { runFailed?: boolean }).runFailed,
    ).toBeUndefined();
  });
});
