import type {
  DecodedSessionCheck,
  DecodedSessionFinding,
  SessionPayloadScalar,
} from './session-payload-decode.js';
import type { StoredSession } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

export interface BuildReplaySignalInput {
  readonly stored: StoredSession;
  readonly source: string;
  readonly finding: DecodedSessionFinding;
  readonly checkIndex: number;
  readonly findingIndex: number;
  readonly toolPrefix: string;
  readonly category: Signal['category'];
  readonly metadata?: Readonly<Record<string, SessionPayloadScalar>>;
  readonly alwaysIncludeCode?: boolean;
}

export interface BuildReplaySignalsInput {
  readonly stored: StoredSession;
  readonly checks: readonly DecodedSessionCheck[];
  readonly toolPrefix: string;
  readonly category: Signal['category'];
  readonly metadata?: (
    finding: DecodedSessionFinding,
  ) => Readonly<Record<string, SessionPayloadScalar>> | undefined;
  readonly alwaysIncludeCode?: boolean;
}

export function buildReplaySignal(input: BuildReplaySignalInput): Signal {
  const filePath = input.finding.filePath ?? '';
  return {
    id: `${input.stored.id}:${input.toolPrefix}:${input.checkIndex}:${input.findingIndex}`,
    source: input.source,
    provider: 'opensip-cli',
    severity: input.finding.severity === 'error' ? 'high' : 'medium',
    category: input.category,
    ruleId: input.finding.ruleId,
    message: input.finding.message,
    filePath,
    ...(input.finding.suggestion === undefined ? {} : { suggestion: input.finding.suggestion }),
    ...(input.finding.line === undefined ? {} : { line: input.finding.line }),
    ...(input.finding.column === undefined ? {} : { column: input.finding.column }),
    ...codeLocation(input.finding, filePath, input.alwaysIncludeCode === true),
    metadata: input.metadata ?? {},
    ...(input.finding.repair === undefined ? {} : { repair: input.finding.repair }),
    createdAt: input.stored.startedAt,
  };
}

export function buildReplaySignals(input: BuildReplaySignalsInput): Signal[] {
  return input.checks.flatMap((check, checkIndex) =>
    check.findings.map((finding, findingIndex) =>
      buildReplaySignal({
        stored: input.stored,
        source: check.checkSlug,
        finding,
        checkIndex,
        findingIndex,
        toolPrefix: input.toolPrefix,
        category: input.category,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata(finding) }),
        ...(input.alwaysIncludeCode === undefined
          ? {}
          : { alwaysIncludeCode: input.alwaysIncludeCode }),
      }),
    ),
  );
}

function codeLocation(
  finding: DecodedSessionFinding,
  fallbackFilePath: string,
  alwaysIncludeCode: boolean,
): Pick<Signal, 'code'> | Record<string, never> {
  if (!alwaysIncludeCode && finding.filePath === undefined) {
    return {};
  }
  const file = finding.filePath ?? fallbackFilePath;
  return {
    code: {
      file,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      ...(finding.column === undefined ? {} : { column: finding.column }),
    },
  };
}
