/**
 * @fileoverview The single, substrate-LOCAL SARIF ingest (ADR-0091).
 *
 * This is the ONLY SARIF read/parse path in the workspace (enforced by the
 * `single-sarif-ingest` dependency-cruiser rule). The OpenSIP SARIF *writer*'s
 * shape types are file-private to `@opensip-cli/output` (a layer-3 peer the
 * substrate may not import) and deliberately minimal — so a foreign-scanner
 * ingest defines its OWN defensive INPUT types here: it must read
 * `result.fingerprints`/`partialFingerprints`/`guid`, `properties`, multiple
 * `runs`/`locations`, `ruleIndex`→`rules` joins, and
 * `properties["security-severity"]`.
 *
 * Severity recovery is the core job: the writer collapses BOTH `critical` and
 * `high` → SARIF `error`, so a level-only inverse is ambiguous. `ingestSarif`
 * reads the CVSS `security-severity` number (off the rule descriptor, falling
 * back to the result) and applies the FIRST/NVD v3 bands BEFORE falling back to
 * `level`. The native level/severity are preserved on `Signal.metadata`.
 *
 * Message stability is the second job: real scanners (Trivy) put a VERBOSE,
 * version-volatile block in `result.message.text` (e.g. a `Package:/Installed
 * Version:/Severity:/Fixed Version:/Link:` listing). Surfacing that as
 * `Signal.message` would also feed it into the `message-hash` fingerprint, so the
 * baseline would churn on every dependency bump — defeating the whole point of a
 * line-shift-tolerant hash. So `ingestSarif` prefers the STABLE rule title
 * (`driver.rules[ruleIndex].shortDescription.text`) for `Signal.message` when
 * present and stashes the verbose `result.message.text` on `metadata.detail`. It
 * falls back to `result.message.text` only when no rule/shortDescription exists.
 */

import { createSignal } from '@opensip-cli/core';

import { cvssToSeverity, parseCvss, sarifLevelToSeverity } from './severity-map.js';

import type { Signal, SignalSeverity } from '@opensip-cli/core';

// ── Defensive SARIF 2.1.0 INPUT types (all optional — foreign output) ────────

/** A SARIF 2.1.0 log: the top-level document a foreign scanner emits (one or more runs). */
export interface SarifLog {
  readonly version?: string;
  readonly $schema?: string;
  readonly runs?: readonly SarifRun[];
}

/** One analysis run within a {@link SarifLog} — a tool plus its results. */
export interface SarifRun {
  readonly tool?: SarifTool;
  readonly results?: readonly SarifResult[];
}

/** The tool component of a {@link SarifRun}; carries the `driver` (the scanner). */
export interface SarifTool {
  readonly driver?: SarifDriver;
}

/** The scanner driver: its identity and the rule catalog `result.ruleIndex` joins against. */
export interface SarifDriver {
  readonly name?: string;
  readonly version?: string;
  readonly informationUri?: string;
  readonly rules?: readonly SarifReportingDescriptor[];
}

/** A rule descriptor in `driver.rules[]` — `properties["security-severity"]` carries the CVSS. */
export interface SarifReportingDescriptor {
  readonly id?: string;
  readonly name?: string;
  readonly shortDescription?: SarifMessage;
  readonly fullDescription?: SarifMessage;
  readonly helpUri?: string;
  readonly defaultConfiguration?: { readonly level?: string };
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** A single finding: rule id/index, coarse `level`, message, locations, and native fingerprints. */
export interface SarifResult {
  readonly ruleId?: string;
  readonly ruleIndex?: number;
  readonly level?: string;
  readonly message?: SarifMessage;
  readonly locations?: readonly SarifLocation[];
  readonly fingerprints?: Readonly<Record<string, unknown>>;
  readonly partialFingerprints?: Readonly<Record<string, unknown>>;
  readonly guid?: string;
  readonly helpUri?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** A result location — wraps the {@link SarifPhysicalLocation} (file + region). */
export interface SarifLocation {
  readonly physicalLocation?: SarifPhysicalLocation;
}

/** The physical location of a finding: an artifact (file) URI and an optional source region. */
export interface SarifPhysicalLocation {
  readonly artifactLocation?: { readonly uri?: string; readonly uriBaseId?: string };
  readonly region?: {
    readonly startLine?: number;
    readonly startColumn?: number;
    readonly endLine?: number;
  };
}

/** A SARIF message object — the `text` is the human-readable finding description. */
export interface SarifMessage {
  readonly text?: string;
}

/** Options for {@link ingestSarif}. */
export interface IngestSarifOptions {
  /** `Signal.source` for every produced signal (defaults to the driver name, lowercased, or `'sarif'`). */
  readonly source?: string;
  /** `Signal.category` (defaults to `'security'` — these are security scanners). */
  readonly category?: string;
}

const SECURITY_SEVERITY_KEY = 'security-severity';

/** Find the rule descriptor for a result by `ruleIndex` first, then by id. */
function resolveRule(
  result: SarifResult,
  rules: readonly SarifReportingDescriptor[],
): SarifReportingDescriptor | undefined {
  if (
    typeof result.ruleIndex === 'number' &&
    result.ruleIndex >= 0 &&
    result.ruleIndex < rules.length
  ) {
    return rules[result.ruleIndex];
  }
  if (typeof result.ruleId === 'string') {
    return rules.find((rule) => rule.id === result.ruleId);
  }
  return undefined;
}

/** Read `properties["security-severity"]` off the rule, then the result. */
function readSecuritySeverity(
  result: SarifResult,
  rule: SarifReportingDescriptor | undefined,
): { readonly raw: unknown; readonly cvss: number } | undefined {
  for (const props of [rule?.properties, result.properties]) {
    const raw = props?.[SECURITY_SEVERITY_KEY];
    const cvss = parseCvss(raw);
    if (cvss !== undefined) return { raw, cvss };
  }
  return undefined;
}

/**
 * Recover the four-bucket OpenSIP severity for one SARIF result: prefer the CVSS
 * `security-severity` number (bands), else fall back to `level` (then the rule's
 * `defaultConfiguration.level`). The native `securitySeverity`/`level` are
 * returned so the caller can preserve them on metadata.
 */
function recoverSeverity(
  result: SarifResult,
  rule: SarifReportingDescriptor | undefined,
): {
  readonly severity: SignalSeverity;
  readonly securitySeverity?: unknown;
  readonly nativeLevel?: string;
} {
  const security = readSecuritySeverity(result, rule);
  if (security !== undefined) {
    return {
      severity: cvssToSeverity(security.cvss),
      securitySeverity: security.raw,
      nativeLevel: result.level,
    };
  }
  const level = result.level ?? rule?.defaultConfiguration?.level;
  return { severity: sarifLevelToSeverity(level), nativeLevel: level };
}

/** Collapse a result's locations to the primary site + a count of extras. */
function primaryLocation(result: SarifResult): {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly extra: number;
} {
  const locations = result.locations ?? [];
  const first = locations[0]?.physicalLocation;
  return {
    file: first?.artifactLocation?.uri,
    line: first?.region?.startLine,
    column: first?.region?.startColumn,
    extra: locations.length > 1 ? locations.length - 1 : 0,
  };
}

/**
 * Resolve `Signal.message` (the fingerprint basis) for one result, preferring the
 * STABLE rule title over the version-volatile `result.message.text`. When a title
 * is used and a distinct verbose result message exists, the verbose block is
 * returned as `detail` to stash on metadata (so nothing is lost).
 */
function resolveMessage(
  result: SarifResult,
  rule: SarifReportingDescriptor | undefined,
  ruleId: string,
): { readonly message: string; readonly detail?: string } {
  const title = rule?.shortDescription?.text;
  const verbose = result.message?.text;
  if (title !== undefined && title.length > 0) {
    return {
      message: title,
      ...(verbose !== undefined && verbose !== title ? { detail: verbose } : {}),
    };
  }
  return { message: verbose ?? rule?.fullDescription?.text ?? ruleId };
}

/** Build the opaque metadata bag for one result (native severity/level/fingerprint/help/detail). */
function buildMetadata(
  result: SarifResult,
  rule: SarifReportingDescriptor | undefined,
  severity: { readonly securitySeverity?: unknown; readonly nativeLevel?: string },
  extras: { readonly extraLocations: number; readonly detail?: string },
): Record<string, unknown> {
  const nativeFingerprint = result.guid ?? result.fingerprints ?? result.partialFingerprints;
  const helpUri = rule?.helpUri ?? result.helpUri;
  return {
    nativeLevel: severity.nativeLevel ?? null,
    nativeSeverity: severity.securitySeverity ?? severity.nativeLevel ?? null,
    ...(severity.securitySeverity === undefined
      ? {}
      : { securitySeverity: severity.securitySeverity }),
    ...(nativeFingerprint === undefined ? {} : { nativeFingerprint }),
    ...(extras.extraLocations > 0 ? { additionalLocations: extras.extraLocations } : {}),
    ...(extras.detail === undefined ? {} : { detail: extras.detail }),
    ...(helpUri === undefined ? {} : { helpUri }),
  };
}

/** Normalize one SARIF result to a Signal, joined against its run's rules. */
function resultToSignal(
  result: SarifResult,
  rules: readonly SarifReportingDescriptor[],
  source: string,
  category: string,
): Signal {
  const rule = resolveRule(result, rules);
  const ruleId = result.ruleId ?? rule?.id ?? 'unknown';
  const severity = recoverSeverity(result, rule);
  const { message, detail } = resolveMessage(result, rule, ruleId);
  const location = primaryLocation(result);
  return createSignal({
    source,
    severity: severity.severity,
    category,
    ruleId,
    message,
    code: {
      ...(location.file === undefined ? {} : { file: location.file }),
      ...(location.line === undefined ? {} : { line: location.line }),
      ...(location.column === undefined ? {} : { column: location.column }),
    },
    metadata: buildMetadata(result, rule, severity, { extraLocations: location.extra, detail }),
  });
}

/**
 * Ingest a SARIF 2.1.0 log into normalized {@link Signal}s. Defensive over
 * foreign output: tolerates multiple runs, missing rules/locations, and
 * `ruleIndex` joins. Severity is recovered from CVSS `security-severity` before
 * `level` (ADR-0091); native fingerprints/level/severity are preserved on
 * `metadata`. `Signal.fingerprint` is left unstamped — the host ratchet's
 * `message-hash` strategy stamps it worker-side at envelope construction.
 */
export function ingestSarif(sarif: SarifLog, options?: IngestSarifOptions): readonly Signal[] {
  const category = options?.category ?? 'security';
  const signals: Signal[] = [];
  for (const run of sarif.runs ?? []) {
    const driver = run.tool?.driver;
    const rules = driver?.rules ?? [];
    const source = options?.source ?? driver?.name?.toLowerCase() ?? 'sarif';
    for (const result of run.results ?? []) {
      signals.push(resultToSignal(result, rules, source, category));
    }
  }
  return signals;
}
