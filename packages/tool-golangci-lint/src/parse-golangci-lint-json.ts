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
const SCANNER = 'golangci-lint';

function invalidReport(condition: string): never {
  throw new ToolError('golangci-lint produced an unusable JSON report.', ARTIFACT_INVALID.code, {
    definition: ARTIFACT_INVALID,
    metadata: { condition, scanner: SCANNER },
  });
}

function parsedReport(raw: ParsedScannerOutput): Record<string, unknown> {
  const doc =
    raw.json === undefined
      ? (() => {
          const parsed = safeParseJson(raw.raw);
          return parsed.ok ? parsed.value : invalidReport('malformed-json');
        })()
      : raw.json;
  return asObject(doc) ?? invalidReport('invalid-report-shape');
}

function issueList(report: Record<string, unknown>): readonly unknown[] {
  if (report.Issues === undefined || report.Issues === null) return [];
  return asArray(report.Issues) ?? invalidReport('invalid-issues-shape');
}

function reportSignals(document: Record<string, unknown>): readonly Signal[] {
  if (document.Report === undefined || document.Report === null) return [];
  const report = asObject(document.Report) ?? invalidReport('invalid-report-metadata');
  const signals: Signal[] = [];
  const error = getString(report, 'Error');
  if (error !== undefined && error.trim().length > 0) {
    signals.push(reportSignal('high', 'golangci-lint-report-error', error));
  }
  const warnings = report.Warnings === undefined ? [] : asArray(report.Warnings);
  if (warnings === undefined) invalidReport('invalid-report-warnings');
  for (const entry of warnings) {
    const warning = asObject(entry);
    const text = getString(warning, 'Text');
    if (warning === undefined || text === undefined) invalidReport('invalid-report-warning');
    signals.push(
      reportSignal('medium', 'golangci-lint-report-warning', text, getString(warning, 'Tag')),
    );
  }
  return signals;
}

function reportSignal(
  severity: 'high' | 'medium',
  ruleId: string,
  message: string,
  tag?: string,
): Signal {
  return createSignal({
    source: SCANNER,
    category: 'quality',
    severity,
    ruleId,
    message,
    code: { file: '' },
    metadata: { reportTag: tag ?? null },
  });
}

function normalize(entry: unknown): Signal | undefined {
  const issue = asObject(entry);
  if (issue === undefined) return undefined;
  const pos = asObject(issue.Pos);
  const linter = getString(issue, 'FromLinter') ?? SCANNER;
  const severityLabel = getString(issue, 'Severity');
  return createSignal({
    source: SCANNER,
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
  const document = parsedReport(raw);
  const signals: Signal[] = [...reportSignals(document)];
  const issues = issueList(document);
  const reportSignalCount = signals.length;
  for (const entry of issues) {
    const signal = normalize(entry);
    if (signal !== undefined) signals.push(signal);
  }
  const issueSignalCount = signals.length - reportSignalCount;
  const dropped = issues.length - issueSignalCount;
  if (dropped > 0 && issueSignalCount === 0) invalidReport('invalid-issue-record');
  if (dropped > 0) {
    ctx.logger.warn({
      evt: 'external.scanner.report.partial',
      module: '@opensip-cli/tool-golangci-lint',
      scanner: SCANNER,
      condition: 'invalid-issue-record',
      droppedIssueCount: dropped,
      findingCount: issueSignalCount,
    });
  }
  return signals;
}
