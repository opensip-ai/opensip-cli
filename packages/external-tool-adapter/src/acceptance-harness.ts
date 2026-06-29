/**
 * @fileoverview A reusable, framework-agnostic acceptance harness (ADR-0090
 * §4.12). Given a frozen golden (the scanner's native output) it runs the
 * substrate's parse → normalize → envelope path and returns the produced signals
 * + the built `SignalEnvelope`, so an adapter's test asserts on *data* instead of
 * re-scaffolding the pipeline. The real worker E2E lives in each adapter's tests
 * (D6 Tier 2); this covers the in-process normalization tier (D6 Tier 1).
 *
 * Pure: no test framework, no IO, deterministic `runId`/`createdAt`.
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';

import { resolveFingerprintStrategy } from './fingerprint.js';
import { safeParseJson } from './ingest-json.js';
import { ingestSarif } from './ingest-sarif.js';

import type { SarifLog } from './ingest-sarif.js';
import type {
  AdapterRunContext,
  FingerprintStrategyChoice,
  ParsedScannerOutput,
  ScannerOutputKind,
} from './types.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

/** A golden case to drive through the normalization pipeline. */
export interface AcceptanceFixture {
  readonly tool: string;
  readonly kind: ScannerOutputKind;
  /** The scanner's native output bytes (a frozen golden). */
  readonly raw: string;
  /** Required for JSON/stdout fixtures; SARIF fixtures use the shared `ingestSarif`. */
  readonly parse?: (raw: ParsedScannerOutput, ctx: AdapterRunContext) => readonly Signal[];
  readonly fingerprintStrategy?: FingerprintStrategyChoice;
  /** Optional partial context for a JSON/stdout `parse` (defaults are filled in). */
  readonly ctx?: Partial<AdapterRunContext>;
}

/** The normalized output of an acceptance case. */
export interface AcceptanceResult {
  readonly signals: readonly Signal[];
  readonly envelope: SignalEnvelope;
}

/** The stable, comparable shape of a signal for golden assertions. */
export interface SignalShape {
  readonly ruleId: string;
  readonly severity: string;
  readonly message: string;
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/** Project a signal to its stable comparison shape (drops ids/timestamps/metadata). */
export function normalizedSignalShape(signal: Signal): SignalShape {
  return {
    ruleId: signal.ruleId,
    severity: signal.severity,
    message: signal.message,
    file: signal.filePath,
    ...(signal.line === undefined ? {} : { line: signal.line }),
    ...(signal.column === undefined ? {} : { column: signal.column }),
  };
}

/** A single shared no-op used for every level of the harness's stub logger. */
const noop = (): void => undefined;

function defaultCtx(fixture: AcceptanceFixture): AdapterRunContext {
  return {
    tool: fixture.tool,
    projectRoot: '/acceptance',
    runId: 'acceptance-run',
    logger: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    },
    config: {},
    binary: { path: `/usr/bin/${fixture.tool}`, layer: 'path' },
    artifactPath: (name) => `/acceptance/acceptance-run/${name}`,
    ...fixture.ctx,
  };
}

/**
 * Run a golden fixture through the substrate pipeline. Returns the normalized
 * signals and a deterministic envelope (host fallback policy, message-hash
 * fingerprints by default).
 */
export function runAcceptanceCase(fixture: AcceptanceFixture): AcceptanceResult {
  const ctx = defaultCtx(fixture);
  let signals: readonly Signal[];
  if (fixture.kind === 'sarif') {
    const parsed = safeParseJson(fixture.raw);
    signals = parsed.ok ? ingestSarif(parsed.value as SarifLog, { source: fixture.tool }) : [];
  } else if (fixture.parse === undefined) {
    signals = [];
  } else {
    const json = fixture.kind === 'json' ? safeParseJson(fixture.raw) : undefined;
    signals = fixture.parse(
      { kind: fixture.kind, raw: fixture.raw, ...(json?.ok === true ? { json: json.value } : {}) },
      ctx,
    );
  }

  const envelope = buildSignalEnvelope({
    tool: fixture.tool,
    runId: ctx.runId,
    createdAt: '2026-01-01T00:00:00.000Z',
    units: [
      { slug: 'scan', passed: signals.length === 0, violationCount: signals.length, durationMs: 0 },
    ],
    signals,
    policy: { failOnErrors: 1, failOnWarnings: 0 },
    runFaulted: false,
    fingerprintStrategy: resolveFingerprintStrategy(fixture.fingerprintStrategy),
  });

  return { signals, envelope };
}
