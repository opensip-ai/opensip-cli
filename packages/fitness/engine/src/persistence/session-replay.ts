import type {
  FitDoneResult,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

interface StoredFitnessFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
}

interface StoredFitnessCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount?: number;
  readonly findings: readonly StoredFitnessFinding[];
  readonly durationMs: number;
}

interface StoredFitnessPayload {
  readonly summary: SignalEnvelope['verdict']['summary'];
  readonly checks: readonly StoredFitnessCheck[];
}

export function fitReplayFromSession(
  stored: StoredSession,
): ToolSessionReplay<FitDoneResult> {
  const payload = parseFitnessPayload(stored.payload);
  const units: UnitResult[] = payload.checks.map((check) => ({
    slug: check.checkSlug,
    passed: check.passed,
    ...(check.violationCount === undefined ? {} : { violationCount: check.violationCount }),
    durationMs: check.durationMs,
  }));
  const signals = payload.checks.flatMap((check, checkIndex) =>
    check.findings.map((finding, findingIndex) =>
      replaySignal(stored, check.checkSlug, finding, checkIndex, findingIndex),
    ),
  );
  const envelope: SignalEnvelope = {
    schemaVersion: 2,
    tool: 'fit',
    runId: stored.id,
    createdAt: stored.timestamp,
    ...(stored.recipe === undefined ? {} : { recipe: stored.recipe }),
    verdict: {
      score: stored.score,
      passed: stored.passed,
      summary: payload.summary,
    },
    units,
    signals,
  };
  return {
    fidelity: 'projection',
    envelope,
    result: {
      type: 'fit-done',
      label: stored.recipe ? `recipe ${stored.recipe}` : `session ${stored.id}`,
      cwd: stored.cwd,
      envelope,
      configFound: true,
    },
  };
}

function parseFitnessPayload(payload: unknown): StoredFitnessPayload {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('fit session has no replay payload');
  }
  const candidate = payload as { summary?: unknown; checks?: unknown };
  const summary = parseSummary(candidate.summary, 'fit session summary');
  if (!Array.isArray(candidate.checks)) {
    throw new Error('fit session payload is missing checks[]');
  }
  return {
    summary,
    checks: candidate.checks.map(parseCheck),
  };
}

function parseSummary(value: unknown, label: string): SignalEnvelope['verdict']['summary'] {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${label} is missing`);
  }
  const summary = value as Record<string, unknown>;
  const total = numberField(summary, 'total', label);
  const passed = numberField(summary, 'passed', label);
  const failed = numberField(summary, 'failed', label);
  const errors = numberField(summary, 'errors', label);
  const warnings = numberField(summary, 'warnings', label);
  return { total, passed, failed, errors, warnings };
}

function parseCheck(value: unknown): StoredFitnessCheck {
  if (value === null || typeof value !== 'object') {
    throw new Error('fit session check row is invalid');
  }
  const check = value as Record<string, unknown>;
  const checkSlug = stringField(check, 'checkSlug', 'fit session check');
  const passed = booleanField(check, 'passed', 'fit session check');
  const durationMs = numberField(check, 'durationMs', 'fit session check');
  const violationCount =
    typeof check.violationCount === 'number' ? check.violationCount : undefined;
  if (!Array.isArray(check.findings)) {
    throw new Error(`fit session check ${checkSlug} is missing findings[]`);
  }
  return {
    checkSlug,
    passed,
    violationCount,
    durationMs,
    findings: check.findings.map(parseFinding),
  };
}

function parseFinding(value: unknown): StoredFitnessFinding {
  if (value === null || typeof value !== 'object') {
    throw new Error('fit session finding is invalid');
  }
  const finding = value as Record<string, unknown>;
  const severity = finding.severity;
  if (severity !== 'error' && severity !== 'warning') {
    throw new Error('fit session finding has invalid severity');
  }
  const filePath = optionalString(finding.filePath);
  const line = optionalNumber(finding.line);
  const column = optionalNumber(finding.column);
  const suggestion = optionalString(finding.suggestion);
  return {
    ruleId: stringField(finding, 'ruleId', 'fit session finding'),
    message: stringField(finding, 'message', 'fit session finding'),
    severity,
    ...(filePath === undefined ? {} : { filePath }),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

function replaySignal(
  stored: StoredSession,
  source: string,
  finding: StoredFitnessFinding,
  checkIndex: number,
  findingIndex: number,
): Signal {
  return {
    id: `${stored.id}:fit:${checkIndex}:${findingIndex}`,
    source,
    provider: 'opensip-tools',
    severity: finding.severity === 'error' ? 'high' : 'medium',
    category: 'quality',
    ruleId: finding.ruleId,
    message: finding.message,
    filePath: finding.filePath ?? '',
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.column === undefined ? {} : { column: finding.column }),
    ...(finding.filePath === undefined ? {} : {
      code: {
        file: finding.filePath,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        ...(finding.column === undefined ? {} : { column: finding.column }),
      },
    }),
    metadata: {},
    createdAt: stored.timestamp,
  };
}

function numberField(source: Record<string, unknown>, field: string, label: string): number {
  const value = source[field];
  if (typeof value !== 'number') throw new Error(`${label}.${field} must be a number`);
  return value;
}

function stringField(source: Record<string, unknown>, field: string, label: string): string {
  const value = source[field];
  if (typeof value !== 'string') throw new Error(`${label}.${field} must be a string`);
  return value;
}

function booleanField(source: Record<string, unknown>, field: string, label: string): boolean {
  const value = source[field];
  if (typeof value !== 'boolean') throw new Error(`${label}.${field} must be a boolean`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
