import { createSignal } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getNumber,
  getString,
  parseJsonLines,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal } from '@opensip-cli/core';
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

function normalize(
  finding: Record<string, unknown>,
  advisories: Map<string, Record<string, unknown>>,
): Signal {
  const ruleId = getString(finding, 'osv') ?? 'go-vulnerability';
  const advisory = advisories.get(ruleId);
  const context = contextFromTrace(finding);
  const summary = getString(advisory, 'summary');
  const fixedVersion = getString(finding, 'fixed_version');
  const aliases = (asArray(advisory?.aliases) ?? [])
    .filter((alias): alias is string => typeof alias === 'string')
    .join(', ');
  return createSignal({
    source: 'govulncheck',
    category: 'security',
    severity: 'high',
    ruleId,
    message: summary ?? `Go vulnerability detected (${ruleId})`,
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
        aliases: aliases.length === 0 ? null : aliases,
      },
      null,
    ),
  });
}

export function parseGovulncheckJsonLines(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const values = parseJsonLines(raw.raw, { tolerateNonJson: true }).values.map(
    (line) => line.value,
  );
  const advisories = osvMap(values);
  const signals: Signal[] = [];
  for (const value of values) {
    const finding = asObject(asObject(value)?.finding);
    if (finding !== undefined) signals.push(normalize(finding, advisories));
  }
  return signals;
}
