import { createSignal, ToolError } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getNumber,
  getString,
  nativeLabelToSeverity,
  safeParseJson,
  externalToolErrorCatalog,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const ARTIFACT_INVALID = externalToolErrorCatalog.require('EXTERNAL.SCANNER.ARTIFACT_INVALID');

function invalidReport(condition: string): never {
  throw new ToolError('golangci-lint produced an unusable JSON report.', ARTIFACT_INVALID.code, {
    definition: ARTIFACT_INVALID,
    metadata: { condition, scanner: 'golangci-lint' },
  });
}

function issueList(raw: ParsedScannerOutput): readonly unknown[] {
  const doc =
    raw.json === undefined
      ? (() => {
          const parsed = safeParseJson(raw.raw);
          return parsed.ok ? parsed.value : invalidReport('malformed-json');
        })()
      : raw.json;
  const report = asObject(doc);
  if (report === undefined) invalidReport('invalid-report-shape');
  if (report.Issues === undefined || report.Issues === null) return [];
  return asArray(report.Issues) ?? invalidReport('invalid-issues-shape');
}

function normalize(entry: unknown): Signal | undefined {
  const issue = asObject(entry);
  if (issue === undefined) return undefined;
  const pos = asObject(issue.Pos);
  const linter = getString(issue, 'FromLinter') ?? 'golangci-lint';
  const severityLabel = getString(issue, 'Severity');
  return createSignal({
    source: 'golangci-lint',
    category: 'quality',
    severity: nativeLabelToSeverity(severityLabel, 'medium'),
    ruleId: linter,
    message: getString(issue, 'Text') ?? linter,
    code: {
      file: getString(pos, 'Filename') ?? '',
      ...(getNumber(pos, 'Line') === undefined ? {} : { line: getNumber(pos, 'Line') }),
      ...(getNumber(pos, 'Column') === undefined ? {} : { column: getNumber(pos, 'Column') }),
    },
    metadata: withNativeSeverity(
      {
        linter,
      },
      severityLabel ?? null,
    ),
  });
}

/**
 * Parse golangci-lint's JSON report — the top-level `Issues[]` array — into
 * normalized findings. Each issue maps to a signal keyed on its `FromLinter`
 * rule, `Text` message, and `Pos` location, preserving the native `Severity`.
 */
export function parseGolangciLintJson(
  raw: ParsedScannerOutput,
  ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  const issues = issueList(raw);
  for (const entry of issues) {
    const signal = normalize(entry);
    if (signal !== undefined) signals.push(signal);
  }
  const dropped = issues.length - signals.length;
  if (dropped > 0 && signals.length === 0) invalidReport('invalid-issue-record');
  if (dropped > 0) {
    ctx.logger.warn({
      evt: 'external.scanner.report.partial',
      module: '@opensip-cli/tool-golangci-lint',
      scanner: 'golangci-lint',
      condition: 'invalid-issue-record',
      droppedIssueCount: dropped,
      findingCount: signals.length,
    });
  }
  return signals;
}
