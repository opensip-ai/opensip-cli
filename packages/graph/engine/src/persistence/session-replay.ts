import type {
  GraphDoneResult,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-tools/contracts';
import type { JsonScalar } from './session-payload.js';
import type { Signal } from '@opensip-tools/core';

interface StoredGraphFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  readonly metadata?: Readonly<Record<string, JsonScalar>>;
}

interface StoredGraphCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount: number;
  readonly findings: readonly StoredGraphFinding[];
  readonly durationMs: number;
}

interface StoredGraphPayload {
  readonly summary: SignalEnvelope['verdict']['summary'];
  readonly checks: readonly StoredGraphCheck[];
}

export function graphReplayFromSession(
  stored: StoredSession,
): ToolSessionReplay<GraphDoneResult> {
  const payload = parseGraphPayload(stored.payload);
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
    tool: 'graph',
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
      type: 'graph-done',
      summary: {
        passed: payload.summary.passed,
        failed: payload.summary.failed,
        errors: payload.summary.errors,
        warnings: payload.summary.warnings,
      },
      durationMs: stored.durationMs,
    },
  };
}

function parseGraphPayload(payload: unknown): StoredGraphPayload {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('graph session has no replay payload');
  }
  const candidate = payload as { summary?: unknown; checks?: unknown };
  const summary = parseSummary(candidate.summary, 'graph session summary');
  if (!Array.isArray(candidate.checks)) {
    throw new Error('graph session payload is missing checks[]');
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

function parseCheck(value: unknown): StoredGraphCheck {
  if (value === null || typeof value !== 'object') {
    throw new Error('graph session check row is invalid');
  }
  const check = value as Record<string, unknown>;
  const checkSlug = stringField(check, 'checkSlug', 'graph session check');
  if (!Array.isArray(check.findings)) {
    throw new Error(`graph session check ${checkSlug} is missing findings[]`);
  }
  return {
    checkSlug,
    passed: booleanField(check, 'passed', 'graph session check'),
    violationCount: numberField(check, 'violationCount', 'graph session check'),
    durationMs: numberField(check, 'durationMs', 'graph session check'),
    findings: check.findings.map(parseFinding),
  };
}

function parseFinding(value: unknown): StoredGraphFinding {
  if (value === null || typeof value !== 'object') {
    throw new Error('graph session finding is invalid');
  }
  const finding = value as Record<string, unknown>;
  const severity = finding.severity;
  if (severity !== 'error' && severity !== 'warning') {
    throw new Error('graph session finding has invalid severity');
  }
  const line = optionalNumber(finding.line);
  const column = optionalNumber(finding.column);
  const suggestion = optionalString(finding.suggestion);
  const metadata = parseMetadata(finding.metadata);
  return {
    ruleId: stringField(finding, 'ruleId', 'graph session finding'),
    message: stringField(finding, 'message', 'graph session finding'),
    severity,
    filePath: stringField(finding, 'filePath', 'graph session finding'),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function replaySignal(
  stored: StoredSession,
  source: string,
  finding: StoredGraphFinding,
  checkIndex: number,
  findingIndex: number,
): Signal {
  return {
    id: `${stored.id}:graph:${checkIndex}:${findingIndex}`,
    source,
    provider: 'opensip-tools',
    severity: finding.severity === 'error' ? 'high' : 'medium',
    category: 'architecture',
    ruleId: finding.ruleId,
    message: finding.message,
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    filePath: finding.filePath,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.column === undefined ? {} : { column: finding.column }),
    code: {
      file: finding.filePath,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      ...(finding.column === undefined ? {} : { column: finding.column }),
    },
    metadata: finding.metadata ?? {},
    createdAt: stored.timestamp,
  };
}

function parseMetadata(value: unknown): Readonly<Record<string, JsonScalar>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return undefined;
  const out: Record<string, JsonScalar> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      out[key] = entry;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
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
