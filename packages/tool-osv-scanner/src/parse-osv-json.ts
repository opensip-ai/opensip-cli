/**
 * @fileoverview OSV-Scanner JSON → normalized `Signal[]` (ADR-0090 §4, brief §4).
 *
 * OSV-Scanner emits a nested document: `results[]` (one per scanned source, e.g. a
 * lockfile) → `packages[]` (one per resolved dependency) → `vulnerabilities[]`
 * (one per advisory) plus a sibling `groups[]` (advisories collapsed by alias,
 * carrying `max_severity` — a CVSS base-score string). One normalized
 * `security` {@link Signal} is emitted per vulnerability.
 *
 * Severity resolution (richest first):
 *   1. `groups[].max_severity` — a CVSS base score string ("7.5") → {@link
 *      cvssToSeverity} (FIRST/NVD v3 bands).
 *   2. `database_specific.severity` — the GHSA LABEL (`CRITICAL|HIGH|MODERATE|LOW`;
 *      **MODERATE ⇒ medium**, the only non-obvious mapping).
 *   3. neither present ⇒ default `medium` (a known vulnerability with an unknown
 *      score is still worth surfacing; documented).
 * The raw label is preserved on `metadata.nativeSeverity`; the raw CVSS string on
 * `metadata.cvss`.
 *
 * OSV carries no per-line anchor (the finding is the lockfile-pinned dependency),
 * so `code.line`/`code.column` are omitted — only `code.file` (the source path) is
 * set. No credentials are present, so there is nothing to redact.
 *
 * Pure: defensive JSON navigation (never throws on malformed input → `[]`).
 */

import { createSignal } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  cvssToSeverity,
  getString,
  parseCvss,
  safeParseJson,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal, SignalSeverity } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

/** Read the parsed OSV document from the descriptor payload, defensively. */
function osvDocument(raw: ParsedScannerOutput): Record<string, unknown> | undefined {
  // The run loop pre-parses JSON for `kind: 'json'`; fall back to the raw bytes
  // (the acceptance-harness path) so the parser is total either way.
  if (raw.json !== undefined) return asObject(raw.json);
  const parsed = safeParseJson(raw.raw);
  return parsed.ok ? asObject(parsed.value) : undefined;
}

/**
 * Map a GHSA `database_specific.severity` LABEL to a four-bucket severity.
 * `MODERATE` (GHSA's term) and `MEDIUM` both collapse to `medium`; an unknown
 * label yields `undefined` so the caller can fall through to the default.
 */
function labelToSeverity(label: string | undefined): SignalSeverity | undefined {
  switch (label?.toUpperCase()) {
    case 'CRITICAL': {
      return 'critical';
    }
    case 'HIGH': {
      return 'high';
    }
    case 'MODERATE':
    case 'MEDIUM': {
      return 'medium';
    }
    case 'LOW': {
      return 'low';
    }
    default: {
      return undefined;
    }
  }
}

/**
 * The `max_severity` CVSS string for a vulnerability: the `groups[]` entry whose
 * `ids` include this vuln id carries it (OSV collapses aliased advisories into one
 * group). Empty/absent ⇒ `undefined`.
 */
function maxSeverityForVuln(groups: readonly unknown[], vulnId: string): string | undefined {
  for (const group of groups) {
    const ids = asArray(asObject(group)?.ids) ?? [];
    if (ids.includes(vulnId)) {
      const score = getString(group, 'max_severity');
      if (score !== undefined && score.length > 0) return score;
    }
  }
  return undefined;
}

/** Compose the human message: `<summary> (<pkg>@<version>)`, with defensive fallbacks. */
function buildMessage(
  summary: string | undefined,
  ruleId: string,
  pkg: string | undefined,
  installed: string | undefined,
): string {
  const base = summary ?? ruleId;
  if (pkg === undefined) return base;
  const ref = installed === undefined ? pkg : `${pkg}@${installed}`;
  return `${base} (${ref})`;
}

/**
 * Normalize one OSV vulnerability (within a package + source) to a {@link Signal}.
 * Returns `undefined` for a non-object entry so a malformed element is skipped
 * rather than throwing.
 */
function normalizeVulnerability(
  entry: unknown,
  groups: readonly unknown[],
  context: {
    readonly sourcePath: string;
    readonly pkg: string | undefined;
    readonly installed: string | undefined;
    readonly ecosystem: string | undefined;
  },
): Signal | undefined {
  const vuln = asObject(entry);
  if (vuln === undefined) return undefined;

  const ruleId = getString(vuln, 'id') ?? 'osv-vulnerability';
  const summary = getString(vuln, 'summary');
  const details = getString(vuln, 'details');
  const aliases = (asArray(vuln.aliases) ?? []).filter((a): a is string => typeof a === 'string');
  const label = getString(asObject(vuln.database_specific), 'severity');

  // Severity: CVSS max_severity (numeric) first, then the GHSA label, then default.
  const cvss = maxSeverityForVuln(groups, ruleId);
  const cvssScore = parseCvss(cvss);
  const severity: SignalSeverity =
    cvssScore === undefined ? (labelToSeverity(label) ?? 'medium') : cvssToSeverity(cvssScore);

  const metadata = withNativeSeverity(
    {
      aliases,
      ecosystem: context.ecosystem ?? null,
      pkg: context.pkg ?? null,
      installed: context.installed ?? null,
      cvss: cvss ?? null,
    },
    // Preserve the scanner's own severity label (null when it emits none).
    label ?? null,
  );

  return createSignal({
    source: 'osv-scanner',
    category: 'security',
    severity,
    ruleId,
    message: buildMessage(summary, ruleId, context.pkg, context.installed),
    ...(details === undefined ? {} : { suggestion: details }),
    // OSV anchors a finding at the lockfile (no line) — set only `code.file`.
    code: { file: context.sourcePath },
    metadata,
  });
}

/** Normalize every vulnerability inside one `packages[]` entry. */
function normalizePackage(entry: unknown, sourcePath: string): Signal[] {
  const packageEntry = asObject(entry);
  if (packageEntry === undefined) return [];

  const pkgInfo = asObject(packageEntry.package);
  const context = {
    sourcePath,
    pkg: getString(pkgInfo, 'name'),
    installed: getString(pkgInfo, 'version'),
    ecosystem: getString(pkgInfo, 'ecosystem'),
  };
  const groups = asArray(packageEntry.groups) ?? [];

  const signals: Signal[] = [];
  for (const vuln of asArray(packageEntry.vulnerabilities) ?? []) {
    const signal = normalizeVulnerability(vuln, groups, context);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}

/**
 * Parse OSV-Scanner JSON output into normalized signals. An empty/clean run
 * (`{"results":[]}`, or "nothing scanned") yields no findings; each vulnerability
 * maps to a `security` signal whose severity comes from the CVSS `max_severity`
 * (preferred) or the GHSA label (`MODERATE ⇒ medium`), defaulting to `medium`.
 */
export function parseOsvJson(raw: ParsedScannerOutput, _ctx: AdapterRunContext): readonly Signal[] {
  const doc = osvDocument(raw);
  const results = asArray(doc?.results) ?? [];

  const signals: Signal[] = [];
  for (const result of results) {
    const sourcePath = getString(asObject(result)?.source, 'path') ?? '';
    for (const packageEntry of asArray(asObject(result)?.packages) ?? []) {
      signals.push(...normalizePackage(packageEntry, sourcePath));
    }
  }
  return signals;
}
