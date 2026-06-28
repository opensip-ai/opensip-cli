/**
 * Artifact-lifecycle behavior of the scan run loop (External Tool Adapter
 * A1 / A3 / A11). The run loop is the IO orchestration excluded from coverage;
 * these tests drive it directly with a stub `ToolCliContext` + stub IO deps and
 * assert the artifact-lifecycle guarantees the fake binaries' `mkdir -p` used to
 * mask:
 *
 *   - A1: the per-run artifact dir is ensured through the HOST seam BEFORE the
 *     scanner subprocess runs (a real scanner does a bare `open(--report-path)`).
 *   - A3: the substrate injects each adapter's declared exclusion (flag and/or a
 *     host-written config file) so the scanner never re-walks `.runtime/`.
 *   - A11: an invalid file-backed report (empty / garbage / oversize) FAULTS even
 *     under an `ok`/`findings` exit verdict, and is NEVER overwritten by the empty
 *     read buffer (the scanner's report on disk survives the fault).
 *
 * Each test FAILS without the fix: pre-fix the loop never calls `ensureArtifactDir`
 * (A1), ignores `excludeScan` (A3), and `writeArtifact(path, '')` overwrites the
 * report while emitting a clean 0-findings pass (A11).
 */

import { type ToolCliContext } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { messageHashFingerprintStrategy } from '../fingerprint.js';
import { runScanLoop, type ScanLoopDeps, type ScanLoopInput } from '../run-loop.js';

import type { BinarySpec, ExternalCommandSpec } from '../types.js';

/** A `ToolCliContext` stub that records the ORDER of seam calls. */
function makeCli(): {
  cli: ToolCliContext;
  order: string[];
  spies: {
    ensureArtifactDir: ReturnType<typeof vi.fn>;
    writeArtifact: ReturnType<typeof vi.fn>;
    deliverSignals: ReturnType<typeof vi.fn>;
    emitEnvelope: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
  };
} {
  const order: string[] = [];
  const spies = {
    ensureArtifactDir: vi.fn((path: string) => {
      order.push(`ensureArtifactDir:${path}`);
      return Promise.resolve();
    }),
    writeArtifact: vi.fn((path: string) => {
      order.push(`writeArtifact:${path}`);
      return Promise.resolve();
    }),
    deliverSignals: vi.fn(() => Promise.resolve({ cloudAccepted: 0 })),
    emitEnvelope: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
  };
  const cli = {
    ...spies,
    saveBaseline: vi.fn(() => Promise.resolve()),
    compareBaseline: vi.fn(() =>
      Promise.resolve({ added: [], resolved: [], unchanged: [], degraded: false }),
    ),
    reportFailure: vi.fn(() => Promise.resolve()),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    scope: {
      toolConfig: {},
      projectContext: { projectRoot: '/proj', configPath: '/proj/opensip-cli.config.yml' },
      runId: 'RUN_test',
    },
  } as unknown as ToolCliContext;
  return { cli, order, spies };
}

const BINARY: BinarySpec = { command: 'examplescan', versionArgs: ['version'] };

interface DepOpts {
  readonly code: number;
  readonly artifact: string;
  readonly fileSize?: number;
  readonly maxBuffer?: number;
  readonly order?: string[];
}

/** IO-deps stub: a found binary; `code`/`artifact`/sizes per case. */
function makeDeps(opts: DepOpts): Partial<ScanLoopDeps> {
  return {
    binaryDeps: { existsSync: () => true, which: () => '/usr/bin/examplescan' },
    runProcess: () => {
      opts.order?.push('runProcess');
      return Promise.resolve({ code: opts.code, stdout: '', stderr: 'boom', timedOut: false });
    },
    probeVersion: () => '1.2.3',
    readFile: () => opts.artifact,
    fileSize: () => opts.fileSize ?? opts.artifact.length,
    env: {},
    ...(opts.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }),
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

/** gitleaks-shaped JSON command (0 clean, 1 findings, >=2 fault). */
function jsonCommand(extra: Partial<ExternalCommandSpec> = {}): ExternalCommandSpec {
  return {
    name: 'scan',
    args: (ctx) => ['detect', '--report-path', ctx.artifactPath('scan.json')],
    output: { kind: 'json', path: 'scan.json' },
    exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
    parse: () => [],
    ...extra,
  };
}

/** trivy-shaped SARIF command: ONLY 0 is clean, no findings code, any nonzero faults. */
function sarifCommand(extra: Partial<ExternalCommandSpec> = {}): ExternalCommandSpec {
  return {
    name: 'scan',
    args: (ctx) => ['fs', '--output', ctx.artifactPath('scan.sarif'), ctx.projectRoot],
    output: { kind: 'sarif', path: 'scan.sarif' },
    exitCodes: { ok: [0], findings: [], errorFrom: 1 },
    ...extra,
  };
}

const VALID_SARIF = '{"version":"2.1.0","runs":[]}';
const ARTIFACT_JSON = '/proj/opensip-cli/.runtime/artifacts/examplescan/RUN_test/scan.json';

describe('runScanLoop — A1: per-run dir ensured via the host seam before the scan', () => {
  it('calls cli.ensureArtifactDir(artifactPath) BEFORE runProcess', async () => {
    const { cli, order, spies } = makeCli();
    await runScanLoop(input(cli, jsonCommand()), makeDeps({ code: 0, artifact: '[]', order }));

    expect(spies.ensureArtifactDir).toHaveBeenCalledWith(ARTIFACT_JSON);
    // Ordering: the dir is created (host seam) strictly before the scanner runs and
    // before the host re-writes the report at 0600.
    const ensureIdx = order.findIndex((e) => e.startsWith('ensureArtifactDir:'));
    const runIdx = order.indexOf('runProcess');
    const writeIdx = order.findIndex((e) => e.startsWith('writeArtifact:'));
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThan(ensureIdx);
    expect(writeIdx).toBeGreaterThan(runIdx);
  });
});

describe('runScanLoop — A3: the substrate injects each adapter exclusion', () => {
  it('appends excludeScan args to the scanner argv (run-context-supplied path)', async () => {
    const { cli } = makeCli();
    const runProcess = vi.fn((_input: { readonly args: readonly string[] }) =>
      Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }),
    );
    await runScanLoop(
      input(
        cli,
        sarifCommand({
          excludeScan: ({ excludePath }) => ({ args: ['--skip-dirs', excludePath] }),
        }),
      ),
      { ...makeDeps({ code: 0, artifact: VALID_SARIF }), runProcess },
    );
    const args = runProcess.mock.calls[0][0].args as string[];
    // The exclusion targets the project's `.runtime` store, not a user flag.
    expect(args).toContain('--skip-dirs');
    expect(args).toContain('/proj/opensip-cli/.runtime');
  });

  it('writes an excludeScan configFile through the host writeArtifact seam and references it', async () => {
    const { cli, order, spies } = makeCli();
    const runProcess = vi.fn((_input: { readonly args: readonly string[] }) => {
      order.push('runProcess');
      return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
    });
    await runScanLoop(
      input(
        cli,
        jsonCommand({
          excludeScan: ({ configPath }) => {
            const path = configPath('exclude.toml');
            return { args: ['--config', path], configFile: { path, contents: 'allowlist' } };
          },
        }),
      ),
      { ...makeDeps({ code: 0, artifact: '[]' }), runProcess },
    );
    // The config is written via the HOST seam (never a raw substrate fs write) and
    // BEFORE the scanner runs.
    expect(spies.writeArtifact).toHaveBeenCalledWith(
      '/proj/opensip-cli/.runtime/artifacts/examplescan/RUN_test/exclude.toml',
      'allowlist',
    );
    const args = runProcess.mock.calls[0][0].args as string[];
    expect(args).toContain('--config');
    const cfgWriteIdx = order.indexOf(
      'writeArtifact:/proj/opensip-cli/.runtime/artifacts/examplescan/RUN_test/exclude.toml',
    );
    expect(cfgWriteIdx).toBeGreaterThanOrEqual(0);
    expect(cfgWriteIdx).toBeLessThan(order.indexOf('runProcess'));
  });
});

describe('runScanLoop — A11: invalid file-backed report ⇒ fault, report not destroyed', () => {
  it('trivy-model exit 0 + EMPTY report faults (no silent clean pass) and never overwrites it', async () => {
    const { cli, spies } = makeCli();
    await expect(
      runScanLoop(input(cli, sarifCommand()), makeDeps({ code: 0, artifact: '' })),
    ).rejects.toMatchObject({ code: 'ADAPTER.ARTIFACT.INVALID' });

    // The empty read buffer is NEVER written back over the scanner's report (A11).
    expect(spies.writeArtifact).not.toHaveBeenCalled();
    expect(spies.deliverSignals).not.toHaveBeenCalled();
    expect(spies.emitEnvelope).not.toHaveBeenCalled();
  });

  it('exit 0 + GARBAGE (unparseable) report faults', async () => {
    const { cli, spies } = makeCli();
    await expect(
      runScanLoop(input(cli, sarifCommand()), makeDeps({ code: 0, artifact: 'not json <<<' })),
    ).rejects.toMatchObject({ code: 'ADAPTER.ARTIFACT.INVALID' });
    expect(spies.writeArtifact).not.toHaveBeenCalled();
  });

  it('OVERSIZE report (over the maxBuffer cap) faults with a size-distinguished message', async () => {
    const { cli, spies } = makeCli();
    await expect(
      runScanLoop(
        input(cli, sarifCommand()),
        makeDeps({
          code: 0,
          artifact: VALID_SARIF,
          fileSize: 100 * 1024 * 1024,
          maxBuffer: 1024 * 1024,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'ADAPTER.ARTIFACT.INVALID',
      message: expect.stringContaining('MiB cap'),
    });
    expect(spies.writeArtifact).not.toHaveBeenCalled();
  });

  it('a VALID report under the same trivy model still passes (no false fault)', async () => {
    const { cli, spies } = makeCli();
    const completion = await runScanLoop(
      input(cli, sarifCommand()),
      makeDeps({ code: 0, artifact: VALID_SARIF }),
    );
    expect(completion?.envelope.verdict.passed).toBe(true);
    expect(spies.writeArtifact).toHaveBeenCalledTimes(1);
  });
});
