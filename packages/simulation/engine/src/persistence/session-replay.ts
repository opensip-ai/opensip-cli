import type {
  SignalEnvelope,
  SimDoneResult,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

interface StoredSimulationFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
}

interface StoredSimulationCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount: number;
  readonly findings: readonly StoredSimulationFinding[];
  readonly durationMs: number;
}

interface StoredSimulationPayload {
  readonly summary: SignalEnvelope['verdict']['summary'];
  readonly checks: readonly StoredSimulationCheck[];
}

export function simReplayFromSession(
  stored: StoredSession,
): ToolSessionReplay<SimDoneResult> {
  const payload = parseSimulationPayload(stored.payload);
  const units: UnitResult[] = payload.checks.map((check) => ({
    slug: check.checkSlug,
    passed: check.passed,
    violationCount: check.violationCount,
    durationMs: check.durationMs,
  }));
  const signals = payload.checks.flatMap((check, checkIndex) =>
    check.findings.map((finding, findingIndex) =>
      replaySignal(stored, check.checkSlug, finding, checkIndex, findingIndex),
    ),
  );
  const envelope: SignalEnvelope = {
    schemaVersion: 2,
    tool: 'sim',
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
      type: 'sim-done',
      recipeName: stored.recipe ?? 'default',
      cwd: stored.cwd,
      durationMs: stored.durationMs,
      envelope,
    },
  };
}

function parseSimulationPayload(payload: unknown): StoredSimulationPayload {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('sim session has no replay payload');
  }
  const candidate = payload as { summary?: unknown; checks?: unknown };
  const summary = parseSummary(candidate.summary, 'sim session summary');
  if (!Array.isArray(candidate.checks)) {
    throw new Error('sim session payload is missing checks[]');
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
  return {
    total: numberField(summary, 'total', label),
    passed: numberField(summary, 'passed', label),
    failed: numberField(summary, 'failed', label),
    errors: numberField(summary, 'errors', label),
    warnings: numberField(summary, 'warnings', label),
  };
}

function parseCheck(value: unknown): StoredSimulationCheck {
  if (value === null || typeof value !== 'object') {
    throw new Error('sim session check row is invalid');
  }
  const check = value as Record<string, unknown>;
  const checkSlug = stringField(check, 'checkSlug', 'sim session check');
  if (!Array.isArray(check.findings)) {
    throw new Error(`sim session check ${checkSlug} is missing findings[]`);
  }
  return {
    checkSlug,
    passed: booleanField(check, 'passed', 'sim session check'),
    violationCount: numberField(check, 'violationCount', 'sim session check'),
    durationMs: numberField(check, 'durationMs', 'sim session check'),
    findings: check.findings.map(parseFinding),
  };
}

function parseFinding(value: unknown): StoredSimulationFinding {
  if (value === null || typeof value !== 'object') {
    throw new Error('sim session finding is invalid');
  }
  const finding = value as Record<string, unknown>;
  const severity = finding.severity;
  if (severity !== 'error' && severity !== 'warning') {
    throw new Error('sim session finding has invalid severity');
  }
  const filePath = optionalString(finding.filePath);
  const line = optionalNumber(finding.line);
  const column = optionalNumber(finding.column);
  const suggestion = optionalString(finding.suggestion);
  return {
    ruleId: stringField(finding, 'ruleId', 'sim session finding'),
    message: stringField(finding, 'message', 'sim session finding'),
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
  finding: StoredSimulationFinding,
  checkIndex: number,
  findingIndex: number,
): Signal {
  return {
    id: `${stored.id}:sim:${checkIndex}:${findingIndex}`,
    source,
    provider: 'opensip-tools',
    severity: finding.severity === 'error' ? 'high' : 'medium',
    category: 'testing',
    ruleId: finding.ruleId,
    message: finding.message,
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    filePath: finding.filePath ?? '',
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
