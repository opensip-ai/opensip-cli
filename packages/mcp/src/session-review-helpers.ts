import type { ReviewChangeOptions } from './result-dto.js';
import type { HistorySession, HistorySuiteGroup } from '@opensip-cli/contracts';

export function selectSuiteGroup(
  groups: readonly HistorySuiteGroup[],
  opts: ReviewChangeOptions,
): HistorySuiteGroup | undefined {
  if (opts.suiteRunId !== undefined) {
    return groups.find((group) => group.suiteRunId === opts.suiteRunId);
  }
  const candidates =
    opts.suite === undefined ? groups : groups.filter((group) => group.suiteName === opts.suite);
  return candidates[0];
}

export function missingSuiteGroupMessage(opts: ReviewChangeOptions): string {
  if (opts.suiteRunId !== undefined) {
    return `suite run ${opts.suiteRunId} was not found`;
  }
  if (opts.suite === undefined) {
    return 'no stored suite run found';
  }
  return `no stored suite run found for suite ${opts.suite}`;
}

export function latestCompleted(sessions: readonly HistorySession[]): string | undefined {
  return sessions.map((session) => session.completedAt).sort(compareCodePointDescending)[0];
}

export function reviewRecommendedNext(
  sessions: readonly HistorySession[],
  graphStale: boolean,
): Record<string, string> {
  const commands: Record<string, string> = {};
  const first = sessions[0];
  if (first !== undefined) {
    commands.showSourceSessionCommand = `opensip sessions show ${first.id} --json`;
  }
  if (sessions.length > 1) {
    commands.listSuiteSessionsCommand = 'opensip sessions list --json --summary-only';
  }
  if (graphStale) {
    commands.refreshGraphCommand = 'opensip graph --json';
  }
  return commands;
}

function compareCodePointDescending(left: string, right: string): number {
  if (left < right) return 1;
  if (left > right) return -1;
  return 0;
}
