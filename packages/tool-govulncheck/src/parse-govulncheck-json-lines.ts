import { createSignal } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getNumber,
  getString,
  parseJsonLines,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal, SignalSeverity } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

interface FindingContext {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly module?: string;
  readonly packageName?: string;
  readonly symbol?: string;
}

function osvMap(values: readonly unknown[]): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    const osv = asObject(asObject(value)?.osv);
    const id = getString(osv, 'id');
    if (id !== undefined && osv !== undefined) byId.set(id, osv);
  }
  return byId;
}

function contextFromTrace(finding: Record<string, unknown>): FindingContext {
  for (const frame of asArray(finding.trace) ?? []) {
    const record = asObject(frame);
    const position = asObject(record?.position);
    const file = getString(position, 'filename');
    if (file !== undefined) {
      return {
        file,
        ...(getNumber(position, 'line') === undefined ? {} : { line: getNumber(position, 'line') }),
        ...(getNumber(position, 'column') === undefined
          ? {}
          : { column: getNumber(position, 'column') }),
        module: getString(record, 'module'),
        packageName: getString(record, 'package'),
        symbol: getString(record, 'function'),
      };
    }
  }
  return { file: '' };
}

/**
 * A finding is REACHABLE when its trace resolves to a concrete vulnerable symbol
 * (a `function` frame) — govulncheck's call-graph confirmed the vulnerable code is
 * actually invoked. Findings that only reach the module/package level are imported
 * but not called: real but lower priority.
 */
function isReachable(finding: Record<string, unknown>): boolean {
  return (asArray(finding.trace) ?? []).some(
    (frame) => getString(asObject(frame), 'function') !== undefined,
  );
}

function normalize(
  osv: string,
  finding: Record<string, unknown>,
  reachable: boolean,
  advisories: Map<string, Record<string, unknown>>,
): Signal {
  const advisory = advisories.get(osv);
  const context = contextFromTrace(finding);
  const summary = getString(advisory, 'summary');
  const fixedVersion = getString(finding, 'fixed_version');
  const aliases = (asArray(advisory?.aliases) ?? [])
    .filter((alias): alias is string => typeof alias === 'string')
    .join(', ');
  // Reachable (called) vulns are actionable now → high; import-only → medium.
  const severity: SignalSeverity = reachable ? 'high' : 'medium';
  const reachabilityNote = reachable ? '' : ' (imported, not called)';
  return createSignal({
    source: 'govulncheck',
    category: 'security',
    severity,
    ruleId: osv,
    message: `${summary ?? `Go vulnerability detected (${osv})`}${reachabilityNote}`,
    ...(fixedVersion === undefined ? {} : { suggestion: `Upgrade to ${fixedVersion} or later.` }),
    code: {
      file: context.file,
      ...(context.line === undefined ? {} : { line: context.line }),
      ...(context.column === undefined ? {} : { column: context.column }),
    },
    metadata: withNativeSeverity(
      {
        module: context.module ?? null,
        package: context.packageName ?? null,
        symbol: context.symbol ?? null,
        fixedVersion: fixedVersion ?? null,
        reachable,
        aliases: aliases.length === 0 ? null : aliases,
      },
      null,
    ),
  });
}

/**
 * govulncheck streams MULTIPLE `finding` messages per OSV id — one per distinct
 * call trace and one per aggregation level (module, package, symbol). Emitting a
 * signal for each over-counts a single vulnerability 2–4× and flattens govulncheck's
 * reachability signal. Instead we collapse to ONE signal per OSV id, keeping the
 * most-specific (reachable) trace so the location and severity reflect the strongest
 * evidence.
 */
export function parseGovulncheckJsonLines(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const values = parseJsonLines(raw.raw, { tolerateNonJson: true }).values.map(
    (line) => line.value,
  );
  const advisories = osvMap(values);
  // Per OSV id, keep the "best" finding: a reachable trace beats an import-only one,
  // and among equals the first-seen wins (stable).
  const best = new Map<string, { finding: Record<string, unknown>; reachable: boolean }>();
  for (const value of values) {
    const finding = asObject(asObject(value)?.finding);
    if (finding === undefined) continue;
    const osv = getString(finding, 'osv');
    if (osv === undefined) continue;
    const reachable = isReachable(finding);
    const current = best.get(osv);
    if (current === undefined || (reachable && !current.reachable)) {
      best.set(osv, { finding, reachable });
    }
  }
  return [...best.entries()].map(([osv, { finding, reachable }]) =>
    normalize(osv, finding, reachable, advisories),
  );
}
