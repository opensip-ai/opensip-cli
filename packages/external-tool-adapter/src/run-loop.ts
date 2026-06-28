/**
 * @fileoverview The scan run loop (ADR-0090 §4 / ADR-0091).
 *
 * resolve binary → build run context → probe version → compute artifact path →
 * `execFile` (no shell, timeout + output cap) → interpret exit → read native
 * output → persist via `cli.writeArtifact` (the host seam — NEVER raw fs) →
 * parse (SARIF via shared `ingestSarif`; JSON via the descriptor `parse`) →
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
 * This module is the IO orchestration the unit suite excludes from coverage; its
 * pure decision helpers (binary-resolver, exit-model, ingest, severity, provenance)
 * are covered directly, and the whole loop is exercised by each adapter's worker
 * E2E (ADR-0090 D6 Tier 2).
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  isErrorSignal,
  resolveVerdictPolicy,
  TimeoutError,
  ToolError,
} from '@opensip-cli/core';

import { resolveBinary, defaultBinaryEnvVar } from './binary-resolver.js';
import { DEFAULT_EXIT_MODEL, interpretExit } from './exit-model.js';
import { asObject, getString, safeParseJson } from './ingest-json.js';
import { ingestSarif } from './ingest-sarif.js';
import { defaultBinaryDeps, probeBinaryVersion, runScannerProcess } from './process-exec.js';
import { stampProvenanceAll } from './provenance.js';
import { buildAdapterRunContext } from './run-context.js';

import type { BinaryResolveDeps } from './binary-resolver.js';
import type { SarifLog } from './ingest-sarif.js';
import type { ProbeVersionInput, ProcessResult, RunProcessInput } from './process-exec.js';
import type {
  AdapterProvenance,
  AdapterRunContext,
  BinarySpec,
  ExternalCommandSpec,
  ParsedScannerOutput,
} from './types.js';
import type { FingerprintStrategy, Signal, ToolCliContext } from '@opensip-cli/core';

/** Logger `module` field for every event this loop emits. */
const MODULE = 'external-tool-adapter';

/** Default scanner process budget. */
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const STDERR_TAIL = 2000;

/** Injectable IO seam (real impls default; tests pass stubs). */
export interface ScanLoopDeps {
  readonly binaryDeps: BinaryResolveDeps;
  readonly runProcess: (input: RunProcessInput) => Promise<ProcessResult>;
  readonly probeVersion: (input: ProbeVersionInput) => string | undefined;
  readonly readFile: (path: string) => string;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
}

const DEFAULT_DEPS: ScanLoopDeps = {
  binaryDeps: defaultBinaryDeps,
  runProcess: runScannerProcess,
  probeVersion: probeBinaryVersion,
  readFile: (path) => readFileSync(path, 'utf8'),
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
}

/** What the host persists + dispatches after a scan. */
export interface ScanCompletion {
  readonly envelope: ReturnType<typeof buildSignalEnvelope>;
  readonly session: {
    readonly tool: string;
    readonly cwd: string;
    readonly score: number;
    readonly passed: boolean;
    readonly payload: Record<string, unknown>;
  };
}

const ARTIFACT_EXT: Record<ExternalCommandSpec['output']['kind'], string> = {
  sarif: 'sarif',
  json: 'json',
  stdout: 'out',
};

function defaultArtifactName(tool: string, kind: ExternalCommandSpec['output']['kind']): string {
  return `${tool}.${ARTIFACT_EXT[kind]}`;
}

/** Read the namespaced operator pin `binaries.<tool>.path` from the resolved config. */
function configuredBinaryPath(
  config: Readonly<Record<string, unknown>>,
  tool: string,
): string | undefined {
  return getString(asObject(config.binaries)?.[tool], 'path');
}

/** Parse native output into signals (SARIF via shared ingest; JSON/stdout via the descriptor). */
function parseSignals(
  command: ExternalCommandSpec,
  raw: string,
  ctx: AdapterRunContext,
): readonly Signal[] {
  if (command.output.kind === 'sarif') {
    const parsed = safeParseJson(raw);
    if (!parsed.ok) return [];
    return ingestSarif(parsed.value as SarifLog, { source: ctx.tool });
  }
  if (command.parse === undefined) return [];
  const json = command.output.kind === 'json' ? safeParseJson(raw) : undefined;
  const payload: ParsedScannerOutput = {
    kind: command.output.kind,
    raw,
    ...(json?.ok === true ? { json: json.value } : {}),
  };
  return command.parse(payload, ctx);
}

function summaryLines(tool: string, signalCount: number, score: number, passed: boolean): string[] {
  return [
    `${tool}: ${String(signalCount)} finding(s)`,
    `verdict: ${passed ? 'PASS' : 'FAIL'} (score ${score.toFixed(2)})`,
  ];
}

/** Run one scanner command end-to-end. */
export async function runScanLoop(
  input: ScanLoopInput,
  overrides?: Partial<ScanLoopDeps>,
): Promise<ScanCompletion> {
  const deps: ScanLoopDeps = { ...DEFAULT_DEPS, ...overrides };
  const { cli, tool, command, binary } = input;

  const config = (cli.scope.toolConfig?.[tool] ?? {}) as Readonly<Record<string, unknown>>;
  const envVar = binary.envVar ?? defaultBinaryEnvVar(tool);
  const resolution = resolveBinary(
    {
      command: binary.command,
      configuredPath: configuredBinaryPath(config, tool),
      envPath: process.env[envVar],
    },
    deps.binaryDeps,
  );
  if (!resolution.found) {
    throw new ConfigurationError(
      `${tool}: ${resolution.reason}. Run 'opensip ${tool} doctor' for setup help.`,
      { code: 'ADAPTER.BINARY.NOT_FOUND' },
    );
  }

  const version = deps.probeVersion({
    path: resolution.path,
    versionArgs: binary.versionArgs,
    parse: binary.versionParse,
    timeoutMs: deps.timeoutMs,
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
  const args = [...command.args(ctx)];

  cli.logger.info({
    evt: 'adapter.binary.resolved',
    module: MODULE,
    tool,
    layer: resolution.layer,
    path: resolution.path,
    version: version ?? null,
  });

  const startedAt = new Date().toISOString();
  const begin = performance.now();
  const proc = await deps.runProcess({
    command: resolution.path,
    args,
    cwd: ctx.projectRoot,
    timeoutMs: deps.timeoutMs,
    maxBuffer: deps.maxBuffer,
  });
  const durationMs = Math.max(0, Math.round(performance.now() - begin));

  if (proc.timedOut) {
    cli.logger.warn({
      evt: 'adapter.scan.faulted',
      module: MODULE,
      tool,
      reason: 'timeout',
    });
    throw new TimeoutError(`${tool} scan timed out after ${String(deps.timeoutMs)}ms`, {
      code: 'ADAPTER.SCAN.TIMEOUT',
      stderrTail: proc.stderr.slice(-STDERR_TAIL),
    });
  }

  // Read the native output: from the artifact file for json/sarif, stdout otherwise.
  let raw: string;
  let artifactValid = true;
  if (command.output.kind === 'stdout') {
    raw = proc.stdout;
  } else {
    try {
      raw = deps.readFile(artifactFullPath);
    } catch {
      raw = '';
    }
    artifactValid = raw.length > 0 && safeParseJson(raw).ok;
  }

  const verdict = interpretExit(proc.code, command.exitCodes ?? DEFAULT_EXIT_MODEL, {
    artifactValid,
  });
  if (verdict === 'fault') {
    cli.logger.warn({
      evt: 'adapter.scan.faulted',
      module: MODULE,
      tool,
      code: proc.code,
    });
    throw new ToolError(`${tool} scan failed (exit ${String(proc.code)})`, 'ADAPTER.SCAN.FAULT', {
      stderrTail: proc.stderr.slice(-STDERR_TAIL),
    });
  }

  // Persist the raw artifact through the HOST seam (0600 + retention, ADR-0080/0091).
  await cli.writeArtifact(artifactFullPath, raw);
  cli.logger.info({
    evt: 'adapter.artifact.stored',
    module: MODULE,
    tool,
    path: artifactFullPath,
    bytes: raw.length,
  });

  const parsed = parseSignals(command, raw, ctx);
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
    units: [{ slug: command.name, passed: unitPassed, violationCount: signals.length, durationMs }],
    signals,
    policy: resolveVerdictPolicy(tool),
    runFaulted: false,
    fingerprintStrategy: input.fingerprintStrategy,
  });

  const jsonRequested = input.opts.json === true;
  if (jsonRequested) {
    cli.emitEnvelope(envelope);
  } else {
    await cli.render({
      type: 'text-lines',
      title: `${tool} scan`,
      lines: summaryLines(tool, signals.length, envelope.verdict.score, envelope.verdict.passed),
    });
  }

  const deliverCwd = typeof input.opts.cwd === 'string' ? input.opts.cwd : ctx.projectRoot;
  await cli.deliverSignals(envelope, {
    cwd: deliverCwd,
    ...(typeof input.opts.reportTo === 'string' ? { reportTo: input.opts.reportTo } : {}),
    ...(typeof input.opts.apiKey === 'string' ? { apiKey: input.opts.apiKey } : {}),
  });

  cli.logger.info({
    evt: 'adapter.scan.completed',
    module: MODULE,
    tool,
    findings: signals.length,
    passed: envelope.verdict.passed,
  });

  return {
    envelope,
    session: {
      tool,
      cwd: deliverCwd,
      score: envelope.verdict.score,
      passed: envelope.verdict.passed,
      payload: {
        binary: { path: resolution.path, layer: resolution.layer, version: version ?? null },
        artifact: artifactFullPath,
        findings: signals.length,
        durationMs,
      },
    },
  };
}
