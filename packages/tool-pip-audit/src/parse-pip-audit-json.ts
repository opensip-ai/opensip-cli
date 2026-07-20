import { createSignal } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getString,
  parsedObjectDocument,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

function stringList(value: unknown): readonly string[] {
  return (asArray(value) ?? []).filter((item): item is string => typeof item === 'string');
}

function normalize(vuln: Record<string, unknown>, dependency: Record<string, unknown>): Signal {
  const name = getString(dependency, 'name') ?? 'dependency';
  const version = getString(dependency, 'version');
  const ruleId = getString(vuln, 'id') ?? 'pip-vulnerability';
  const fixVersions = stringList(vuln.fix_versions);
  const aliases = stringList(vuln.aliases);
  const dependencyLabel = version === undefined ? name : `${name}@${version}`;
  return createSignal({
    source: 'pip-audit',
    category: 'security',
    severity: 'high',
    ruleId,
    message: `${getString(vuln, 'description') ?? ruleId} (${dependencyLabel})`,
    ...(fixVersions.length === 0 ? {} : { suggestion: `Upgrade to ${fixVersions.join(', ')}.` }),
    code: { file: '' },
    metadata: withNativeSeverity(
      {
        dependency: name,
        version: version ?? null,
        aliases: aliases.length === 0 ? null : aliases.join(', '),
        fixVersions: fixVersions.length === 0 ? null : fixVersions.join(', '),
      },
      null,
    ),
  });
}

function normalizeSkippedDependency(reason: string): Signal {
  return createSignal({
    source: 'pip-audit',
    category: 'quality',
    severity: 'medium',
    ruleId: 'pip-audit-skipped-dependency',
    message: reason,
    code: { file: '' },
    metadata: withNativeSeverity({ reason }, null),
  });
}

/**
 * Parse pip-audit's JSON report into findings by walking each dependency's
 * `vulns[]` and emitting one signal per vulnerability, labelled with the
 * affected `name@version` and any available fix versions. Dependencies that
 * pip-audit explicitly skipped are preserved as quality signals.
 */
export function parsePipAuditJson(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  for (const dep of asArray(parsedObjectDocument(raw)?.dependencies) ?? []) {
    const dependency = asObject(dep);
    if (dependency === undefined) continue;
    const skipReason = getString(dependency, 'skip_reason');
    if (skipReason !== undefined) {
      signals.push(normalizeSkippedDependency(skipReason));
    }
    for (const vuln of asArray(dependency.vulns) ?? []) {
      const record = asObject(vuln);
      if (record !== undefined) signals.push(normalize(record, dependency));
    }
  }
  return signals;
}
