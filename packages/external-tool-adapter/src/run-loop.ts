/**
 * @fileoverview The scan run loop (ADR-0090 §4 / ADR-0091).
 *
 * resolve binary → build run context → probe version → compute artifact path →
 * `execFile` (no shell, timeout + output cap) → interpret exit → read native
 * output → parse (SARIF via shared `ingestSarif`; JSON via the descriptor `parse`) →
 * persist via `cli.writeArtifact` (the host seam — NEVER raw fs) →
 * stamp provenance → `buildSignalEnvelope` + worker-side fingerprint stamping →
 * emit via `cli.emitEnvelope` (`--json`) / `cli.render` (human) → `cli.deliverSignals`
 * (host derives the findings exit from the verdict) → return a `ToolRunCompletion`.
 *
 * For an INSTALLED adapter this body runs WORKER-SIDE; every `cli.*` call here is
 * captured by the worker's recording context and replayed through the host seams
 * (`writeArtifact` via host RPC; `emitEnvelope`/`render`/`deliverSignals`/
 * `setExitCode` via the forwarded-result record). So the substrate never imports
 * `cli` and the host stays the only privileged-effect process.
 *
 * This IO orchestration is excluded from unit coverage; pure helpers are covered
 * directly and adapter worker E2Es exercise the whole loop.
 */

import { readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { buildSignalEnvelope, EXIT_CODES } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  isErrorSignal,
  resolveVerdictPolicy,
  TimeoutError,
  ToolError,
} from '@opensip-cli/core';

import { ADAPTER_DIAG_EVT, emitAdapterDecision } from './adapter-diagnostics.js';
import { resolveBinary, defaultBinaryEnvVar } from './binary-resolver.js';
import { externalToolErrorCatalog } from './errors/external-tool-error-catalog.js';
import { DEFAULT_EXIT_MODEL, interpretExit } from './exit-model.js';
import { defaultBinaryDeps, probeBinaryVersion, runScannerProcess } from './process-exec.js';
import { stampProvenanceAll } from './provenance.js';
import { redactCredentials } from './redact.js';
import { buildAdapterRunContext } from './run-context.js';
import {
  applyScanExclusion,
  configuredBinaryPath,
  defaultArtifactName,
  isEmptyReclaimedStdoutFindings,
  progressStep,
} from './run-loop-helpers.js';
import {
  STDERR_TAIL,
  invalidArtifactFault,
  parseSignals,
  readReportArtifact,
  type ReportRead,
} from './run-loop-ingest.js';
import { buildScanCompletion, deliverOptions, emitScanCompletion } from './scan-emit.js';

import type { BinaryResolveDeps } from './binary-resolver.js';
import type { ProbeVersionInput, ProcessResult, RunProcessInput } from './process-exec.js';
import type { ExternalAdapterProgressBridge } from './progress.js';
import type { ScanCompletion } from './scan-emit.js';
import type { AdapterProvenance, BinarySpec, ExternalCommandSpec } from './types.js';
import type { FingerprintStrategy, ToolCliContext } from '@opensip-cli/core';


// Plan 01: registered replacements for `ADAPTER.*` literals that nothing registered.
const BINARY_MISSING = externalToolErrorCatalog.require('EXTERNAL.SCANNER.BINARY_MISSING');
const SCAN_UNAVAILABLE = externalToolErrorCatalog.require('EXTERNAL.SCANNER.SCAN_UNAVAILABLE');

/** Default scanner process budget. */
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** Injectable IO seam (real impls default; tests pass stubs). */
export interface ScanLoopDeps {
  readonly binaryDeps: BinaryResolveDeps;
  readonly runProcess: (input: RunProcessInput) => Promise<ProcessResult>;
  readonly probeVersion: (input: ProbeVersionInput) => string | undefined;
  readonly readFile: (path: string) => string;
  /** The artifact file's byte size — used to cap the read (OOM guard) before {@link readFile}. */
  readonly fileSize: (path: string) => number;
  /**
   * The environment the operator binary-pin (`OPENSIP_<TOOL>_BIN`) is read from
   * — injected (mirrors the doctor/version probe's `DoctorProbeDeps.env`) so the
   * read flows through a seam, not a raw `process.env` reach, and stays
   * unit-testable. The pin name is per-tool/dynamic, so it cannot be a static
   * EnvRegistry `EnvVarSpec`.
   */
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
}

const DEFAULT_DEPS: ScanLoopDeps = {
  binaryDeps: defaultBinaryDeps,
  runProcess: runScannerProcess,
  probeVersion: probeBinaryVersion,
  readFile: (path) => readFileSync(path, 'utf8'),
  fileSize: (path) => statSync(path).size,
  env: process.env,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxBuffer: DEFAULT_MAX_BUFFER,
};

export interface ScanLoopInput {
  readonly cli: ToolCliContext;
  readonly tool: string;
  readonly adapterPackage?: string;
  readonly command: ExternalCommandSpec;
  readonly binary: BinarySpec;
  readonly fingerprintStrategy: FingerprintStrategy;
  /** The parsed command flags (`json` / `cwd` / `reportTo` / `apiKey`). */
  readonly opts: Record<string, unknown>;
  readonly progress?: ExternalAdapterProgressBridge;
}

/**
 * Run one scanner command end-to-end.
 *
 * Returns the {@link ScanCompletion} the host persists/dispatches, or `undefined`
 * when the invocation is a config error (`--gate-save` + `--gate-compare` together)
 * — the loop has already recorded the failure + exit via `cli.reportFailure`, so
 * there is no envelope/session to return.
 *
 * @throws {ToolError} On an unrecoverable scan fault — an unresolved binary, a
 *   nonzero scanner exit under the strict exit model, or an unusable report
 *   ({@link invalidArtifactFault}: missing / empty / unparseable / oversize).
 */
export async function runScanLoop(
  input: ScanLoopInput,
  overrides?: Partial<ScanLoopDeps>,
): Promise<ScanCompletion | undefined> {
  const deps: ScanLoopDeps = { ...DEFAULT_DEPS, ...overrides };
  const { cli, tool, command, binary } = input;
  const progress = input.progress;

  // ADR-0036 gate-ratchet: --gate-save and --gate-compare are mutually exclusive
  // (mirrors fit's runGateMode). Validate BEFORE any IO so a misconfiguration
  // fails fast — no wasted scanner subprocess — and return early (the host replays
  // the recorded reportFailure → exit 2).
  if (input.opts.gateSave === true && input.opts.gateCompare === true) {
    emitAdapterDecision({
      cli,
      tool,
      evt: ADAPTER_DIAG_EVT.GATE_CONFIG_ERROR,
      phase: 'validate',
      level: 'warn',
      message: `${tool}: --gate-save and --gate-compare are mutually exclusive`,
      data: { reason: 'mutually-exclusive flags' },
    });
    await cli.reportFailure({
      message: 'Error: --gate-save and --gate-compare are mutually exclusive.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      jsonRequested: input.opts.json === true,
    });
    return undefined;
  }

  const config = (cli.scope.toolConfig?.[tool] ?? {}) as Readonly<Record<string, unknown>>;
  const envVar = binary.envVar ?? defaultBinaryEnvVar(tool);
  const resolution = await progressStep(progress, 'resolve-binary', () =>
    resolveBinary(
      {
        command: binary.command,
        configuredPath: configuredBinaryPath(config, tool),
        envPath: deps.env[envVar],
      },
      deps.binaryDeps,
    ),
  );
  if (!resolution.found) {
    throw new ConfigurationError(
      `${tool}: ${resolution.reason}. Run 'opensip ${tool} doctor' for setup help.`,
      { code: BINARY_MISSING.code, definition: BINARY_MISSING },
    );
  }

  // Version probe must not consume the full scan budget (default 5 min).
  const VERSION_PROBE_TIMEOUT_MS = 15_000;
  const version = deps.probeVersion({
    path: resolution.path,
    versionArgs: binary.versionArgs,
    parse: binary.versionParse,
    timeoutMs: Math.min(deps.timeoutMs, VERSION_PROBE_TIMEOUT_MS),
  });

  const ctx = buildAdapterRunContext({
    cli,
    tool,
    adapterPackage: input.adapterPackage,
    binary: { path: resolution.path, layer: resolution.layer, version },
    config,
  });

  const artifactName = command.output.path ?? defaultArtifactName(tool, command.output.kind);
  const artifactFullPath = ctx.artifactPath(artifactName);

  // A1/A7: create the per-run artifact dir through the host seam before the
  // scanner opens its report path. The substrate never mkdirs `.runtime` itself;
  // host RPC owns the privileged FS effect.
  await progressStep(progress, 'prepare-artifacts', async () => {
    await cli.ensureArtifactDir(artifactFullPath);
  });

  // A3: keep the scanner off opensip's own persisted reports under `.runtime/`
  // (see applyScanExclusion) — inherited by every adapter, no user flag.
  const args = [...command.args(ctx)];
  await applyScanExclusion(cli, command, ctx, args);

  emitAdapterDecision({
    cli,
    tool,
    evt: ADAPTER_DIAG_EVT.BINARY_RESOLVED,
    phase: 'load',
    level: 'info',
    message: `${tool}: binary resolved (${resolution.layer})`,
    data: {
      layer: resolution.layer,
      path: resolution.path,
      version: version ?? null,
    },
  });

  const startedAt = new Date().toISOString();
  const begin = performance.now();
  const proc = await progressStep(progress, 'run-scanner', async () =>
    deps.runProcess({
      command: resolution.path,
      args,
      cwd: ctx.projectRoot,
      timeoutMs: deps.timeoutMs,
      maxBuffer: deps.maxBuffer,
    }),
  );
  const durationMs = Math.max(0, Math.round(performance.now() - begin));

  if (proc.timedOut) {
    emitAdapterDecision({
      cli,
      tool,
      evt: ADAPTER_DIAG_EVT.SCAN_FAULTED,
      phase: 'execute',
      level: 'warn',
      message: `${tool}: scan timed out`,
      data: { reason: 'timeout', timeoutMs: deps.timeoutMs },
    });
    throw new TimeoutError(`${tool} scan timed out after ${String(deps.timeoutMs)}ms`, {
      code: SCAN_UNAVAILABLE.code,
      definition: SCAN_UNAVAILABLE,
      metadata: { field: 'timeout' },
      stderrTail: redactCredentials(proc.stderr.slice(-STDERR_TAIL)),
    });
  }

  // Read the native output: stdout commands use the captured stdout; when stdout is
  // empty we fall back to stderr, because some scanners emit their machine output on
  // stderr via a logger (e.g. cargo-deny's `--format json` diagnostics). The fallback
  // only fires on empty stdout, so a scanner that legitimately prints nothing on a
  // clean run reads its (noise) stderr through the tolerant JSON-lines/SARIF parser →
  // zero signals, not a false clean pass on a stream mismatch. File-backed commands
  // read + classify the report (A11) via readReportArtifact.
  const read: ReportRead =
    command.output.kind === 'stdout'
      ? { raw: proc.stdout.trim().length > 0 ? proc.stdout : proc.stderr, artifactValid: true }
      : readReportArtifact(artifactFullPath, deps);

  const verdict = interpretExit(proc.code, command.exitCodes ?? DEFAULT_EXIT_MODEL, {
    artifactValid: read.artifactValid,
  });
  if (verdict === 'fault') {
    emitAdapterDecision({
      cli,
      tool,
      evt: ADAPTER_DIAG_EVT.SCAN_FAULTED,
      phase: 'execute',
      level: 'warn',
      message: `${tool}: scan faulted (exit ${String(proc.code)})`,
      data: { reason: 'exit-fault', code: proc.code },
    });
    throw new ToolError(`${tool} scan failed (exit ${String(proc.code)})`, 'ADAPTER.SCAN.FAULT', {
      stderrTail: redactCredentials(proc.stderr.slice(-STDERR_TAIL)),
    });
  }

  // Some scanners never write the report on a legitimately empty scan (osv-scanner
  // exits 128 for "no packages found" BEFORE its --output write). A declared
  // okWithoutArtifact code with a MISSING report is a clean no-op, not a fault;
  // any other invalid shape (garbage/oversize/empty file) still faults below.
  const cleanWithoutArtifact =
    command.output.kind !== 'stdout' &&
    !read.artifactValid &&
    read.invalidReason === 'missing' &&
    (command.exitCodes?.okWithoutArtifact ?? []).includes(proc.code);
  if (cleanWithoutArtifact) {
    emitAdapterDecision({
      cli,
      tool,
      evt: ADAPTER_DIAG_EVT.SCAN_EMPTY_NOOP,
      phase: 'execute',
      level: 'info',
      message: `${tool}: clean no-op (exit ${String(proc.code)}, scanner writes no report for an empty scan)`,
      data: { reason: 'ok-without-artifact', code: proc.code },
    });
  }

  // A11: a FILE-backed scanner MUST produce a readable, parseable report. An invalid
  // artifact is a FAULT even under an `ok`/`findings` verdict — otherwise trivy's
  // `ok:[0]` model would read a broken report as a clean PASS and the `writeArtifact`
  // below would overwrite the real report with the empty buffer. We throw BEFORE
  // writeArtifact, so the scanner's report on disk is never destroyed.
  if (!read.artifactValid && !cleanWithoutArtifact) {
    emitAdapterDecision({
      cli,
      tool,
      evt: ADAPTER_DIAG_EVT.SCAN_FAULTED,
      phase: 'execute',
      level: 'warn',
      message: `${tool}: invalid scan artifact`,
      data: { reason: `artifact-${read.invalidReason ?? 'invalid'}` },
    });
    throw invalidArtifactFault(tool, command, read, deps.maxBuffer, proc.stderr);
  }

  const raw = read.raw;
  const parsed = await progressStep(
    progress,
    'ingest-report',
    // A clean no-artifact no-op has nothing to parse — zero signals by contract.
    () => (cleanWithoutArtifact ? [] : parseSignals(command, raw, ctx)),
    (signals) => ({ signals: signals.length, findings: signals.length }),
  );
  if (isEmptyReclaimedStdoutFindings(command, proc.code, verdict, parsed.length)) {
    emitAdapterDecision({
      cli,
      tool,
      evt: ADAPTER_DIAG_EVT.SCAN_FAULTED,
      phase: 'execute',
      level: 'warn',
      message: `${tool}: empty stdout with findings exit`,
      data: { reason: 'empty-stdout-findings', code: proc.code },
    });
    throw new ToolError(`${tool} scan failed (exit ${String(proc.code)})`, 'ADAPTER.SCAN.FAULT', {
      stderrTail: redactCredentials(proc.stderr.slice(-STDERR_TAIL)),
    });
  }

  // Persist the raw artifact through the HOST seam (0600 + retention, ADR-0080/0091).
  // A clean no-artifact no-op has no report to persist — writing the empty read
  // buffer would fabricate a zero-byte artifact for a scan that produced none.
  if (!cleanWithoutArtifact) {
    await cli.writeArtifact(artifactFullPath, raw);
    emitAdapterDecision({
      cli,
      tool,
      evt: ADAPTER_DIAG_EVT.ARTIFACT_STORED,
      phase: 'persist',
      level: 'info',
      message: `${tool}: artifact stored`,
      data: { path: artifactFullPath, bytes: raw.length },
    });
  }

  const provenance: AdapterProvenance = {
    tool,
    adapterPackage: input.adapterPackage,
    binaryPath: resolution.path,
    binaryVersion: version,
    args,
    configPath: ctx.configPath,
  };
  const signals = stampProvenanceAll(parsed, provenance);

  const unitPassed = !signals.some(isErrorSignal);
  const envelope = buildSignalEnvelope({
    tool,
    runId: ctx.runId,
    createdAt: startedAt,
    units: [{ slug: tool, passed: unitPassed, violationCount: signals.length, durationMs }],
    signals,
    policy: resolveVerdictPolicy(tool),
    runFaulted: false,
    fingerprintStrategy: input.fingerprintStrategy,
  });

  const deliver = deliverOptions(input.opts, ctx.projectRoot);
  // The session contribution (incl. the dashboard-shaped grouped payload) is shaped
  // in a sibling helper so this orchestration body stays flat (file-length budget).
  const completion = await progressStep(progress, 'store-evidence', () =>
    buildScanCompletion({
      tool,
      cwd: deliver.cwd,
      envelope,
      signals,
      binary: { path: resolution.path, layer: resolution.layer, version: version ?? null },
      artifact: artifactFullPath,
      durationMs,
    }),
  );

  // Emit + deliver + return. The gate-ratchet branch (ADR-0036) and the normal
  // emit live in a sibling helper so this orchestration body stays flat.
  return progressStep(progress, 'deliver-signals', async () =>
    emitScanCompletion({
      cli,
      tool,
      opts: input.opts,
      envelope,
      signalCount: signals.length,
      deliver,
      completion,
    }),
  );
}
