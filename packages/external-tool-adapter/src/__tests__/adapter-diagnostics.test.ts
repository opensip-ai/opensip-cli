/**
 * OBS-ADAPTER — adapter lifecycle decisions reach the diagnostics bus (not
 * logger-only). On main, run-loop / scan-emit only called `cli.logger`, so a
 * `--json` consumer saw no resolve/fault/artifact/completion events under
 * non-debug. Fails on main without bus emission from the substrate.
 */

import { DiagnosticsBus, type ToolCliContext } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import {
  ADAPTER_DIAG_EVT,
  ADAPTER_DIAG_SOURCE,
  boundDecisionData,
  emitAdapterDecision,
} from '../adapter-diagnostics.js';
import { messageHashFingerprintStrategy } from '../fingerprint.js';
import { runScanLoop, type ScanLoopDeps, type ScanLoopInput } from '../run-loop.js';

import type { BinarySpec, ExternalCommandSpec } from '../types.js';

function makeCliWithBus(): {
  cli: ToolCliContext;
  bus: DiagnosticsBus;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
} {
  const bus = new DiagnosticsBus('run_adapter');
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const cli = {
    logger,
    scope: {
      toolConfig: {},
      projectContext: { projectRoot: '/proj', configPath: '/proj/opensip-cli.config.yml' },
      runId: 'run_adapter',
      diagnostics: bus,
    },
    ensureArtifactDir: vi.fn(() => Promise.resolve()),
    writeArtifact: vi.fn(() => Promise.resolve()),
    deliverSignals: vi.fn(() => Promise.resolve({ cloudAccepted: 0 })),
    emitEnvelope: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    saveBaseline: vi.fn(() => Promise.resolve()),
    compareBaseline: vi.fn(() =>
      Promise.resolve({ added: [], resolved: [], unchanged: [], degraded: false }),
    ),
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
  return { cli, bus, logger };
}

const BINARY: BinarySpec = { command: 'gitleaks', versionArgs: ['version'] };

function gitleaksCommand(parse: ExternalCommandSpec['parse']): ExternalCommandSpec {
  return {
    name: 'scan',
    args: (ctx) => ['detect', ctx.projectRoot],
    output: { kind: 'json', path: 'gitleaks.json' },
    exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
    parse,
  };
}

function cleanDeps(): Partial<ScanLoopDeps> {
  return {
    binaryDeps: { existsSync: () => true, which: () => '/usr/local/bin/gitleaks' },
    runProcess: () => Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }),
    probeVersion: () => '8.18.0',
    readFile: () => '[]',
    fileSize: () => 2,
  };
}

describe('boundDecisionData', () => {
  it('reduces path-like keys to basenames and drops unbounded nests', () => {
    expect(
      boundDecisionData({
        path: '/Users/me/.local/bin/gitleaks',
        artifactPath: '/proj/opensip-cli/.runtime/artifacts/run/gitleaks.sarif',
        findings: 3,
        nested: { ok: true, deep: { skip: true } },
        arr: [1, 2, 3],
      }),
    ).toEqual({
      path: 'gitleaks',
      artifactPath: 'gitleaks.sarif',
      findings: 3,
      nested: { ok: true },
    });
  });
});

describe('emitAdapterDecision', () => {
  it('stamps the bus and the logger with the same decision evt', () => {
    const { cli, bus, logger } = makeCliWithBus();
    emitAdapterDecision({
      cli,
      tool: 'gitleaks',
      evt: ADAPTER_DIAG_EVT.BINARY_RESOLVED,
      phase: 'load',
      level: 'info',
      message: 'gitleaks: binary resolved (path)',
      data: { layer: 'path', path: '/usr/bin/gitleaks', version: '8.0.0' },
    });
    const snap = bus.snapshot();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0]).toMatchObject({
      phase: 'load',
      level: 'info',
      message: 'gitleaks: binary resolved (path)',
      data: {
        source: ADAPTER_DIAG_SOURCE,
        evt: ADAPTER_DIAG_EVT.BINARY_RESOLVED,
        tool: 'gitleaks',
        layer: 'path',
        path: 'gitleaks',
        version: '8.0.0',
      },
    });
    expect(snap.metrics?.[`adapter.${ADAPTER_DIAG_EVT.BINARY_RESOLVED}`]).toBe(1);
    expect(logger.info).toHaveBeenCalledOnce();
    expect(() => JSON.stringify(snap)).not.toThrow();
  });
});

describe('runScanLoop — diagnostics bus lifecycle (OBS-ADAPTER / gitleaks-shaped)', () => {
  it('emits resolve + artifact + completed events on a clean scan (no --debug)', async () => {
    const { cli, bus } = makeCliWithBus();
    const input: ScanLoopInput = {
      cli,
      tool: 'gitleaks',
      command: gitleaksCommand(() => []),
      binary: BINARY,
      fingerprintStrategy: messageHashFingerprintStrategy,
      opts: {},
    };

    const completion = await runScanLoop(input, cleanDeps());
    expect(completion).toBeDefined();
    expect(completion?.envelope.verdict.passed).toBe(true);

    const snap = bus.snapshot();
    const evts = snap.events.map((e) => e.data?.evt);
    expect(evts).toContain(ADAPTER_DIAG_EVT.BINARY_RESOLVED);
    expect(evts).toContain(ADAPTER_DIAG_EVT.ARTIFACT_STORED);
    expect(evts).toContain(ADAPTER_DIAG_EVT.SCAN_COMPLETED);
    // No raw home-dir paths in the bus (basename only).
    expect(JSON.stringify(snap)).not.toContain('/usr/local/bin');
    expect(JSON.stringify(snap)).not.toContain('/Users/');
    // Counters land for machine consumers without grepping events.
    expect(snap.metrics?.[`adapter.${ADAPTER_DIAG_EVT.SCAN_COMPLETED}`]).toBe(1);
  });

  it('emits a fault decision when the scanner exit is an error', async () => {
    const { cli, bus } = makeCliWithBus();
    const input: ScanLoopInput = {
      cli,
      tool: 'gitleaks',
      command: gitleaksCommand(() => []),
      binary: BINARY,
      fingerprintStrategy: messageHashFingerprintStrategy,
      opts: {},
    };
    await expect(
      runScanLoop(input, {
        ...cleanDeps(),
        runProcess: () =>
          Promise.resolve({ code: 2, stdout: '', stderr: 'scanner boom', timedOut: false }),
      }),
    ).rejects.toThrow(/scan failed/);

    const fault = bus.snapshot().events.find((e) => e.data?.evt === ADAPTER_DIAG_EVT.SCAN_FAULTED);
    expect(fault).toMatchObject({
      phase: 'execute',
      level: 'warn',
      data: {
        source: ADAPTER_DIAG_SOURCE,
        reason: 'exit-fault',
        code: 2,
      },
    });
    // Never leaks raw stderr into the diagnostics bus.
    expect(JSON.stringify(bus.snapshot())).not.toContain('scanner boom');
  });
});
