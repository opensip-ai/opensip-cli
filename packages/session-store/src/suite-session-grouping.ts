/**
 * Pure helpers for ordering and grouping stored sessions by suite run id.
 * Used by `sessions list`, the HTML report composition root, and the dashboard.
 */

export interface SuiteSessionGroup<
  T extends {
    readonly suiteRunId?: string;
    readonly suiteName?: string;
    readonly startedAt: string;
  },
> {
  readonly suiteRunId: string;
  readonly suiteName?: string;
  readonly sessions: readonly T[];
}

/** Build suite-run groups when at least one session carries a `suiteRunId`. */
export function buildSuiteSessionGroups<
  T extends {
    readonly suiteRunId?: string;
    readonly suiteName?: string;
    readonly startedAt: string;
  },
>(sessions: readonly T[]): readonly SuiteSessionGroup<T>[] | undefined {
  const byRunId = new Map<string, T[]>();
  for (const session of sessions) {
    const id = session.suiteRunId;
    if (id === undefined) continue;
    const bucket = byRunId.get(id);
    if (bucket === undefined) byRunId.set(id, [session]);
    else bucket.push(session);
  }
  if (byRunId.size === 0) return undefined;

  return [...byRunId.entries()]
    .map(([suiteRunId, groupSessions]) => ({
      suiteRunId,
      suiteName: groupSessions.find((s) => s.suiteName !== undefined)?.suiteName,
      sessions: [...groupSessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    }))
    .sort((a, b) => {
      const aLatest = a.sessions[0]?.startedAt ?? '';
      const bLatest = b.sessions[0]?.startedAt ?? '';
      return bLatest.localeCompare(aLatest);
    });
}

/**
 * Order sessions so suite members are contiguous, with each suite block sorted
 * by `startedAt` desc and blocks ordered by their latest step.
 */
export function orderSessionsForSuiteGrouping<
  T extends { readonly suiteRunId?: string; readonly startedAt: string },
>(sessions: readonly T[]): T[] {
  const standalone: T[] = [];
  const grouped = new Map<string, T[]>();
  for (const session of sessions) {
    const id = session.suiteRunId;
    if (id === undefined) {
      standalone.push(session);
      continue;
    }
    const bucket = grouped.get(id);
    if (bucket === undefined) grouped.set(id, [session]);
    else bucket.push(session);
  }

  type Entry =
    | { readonly kind: 'standalone'; readonly session: T }
    | { readonly kind: 'group'; readonly sessions: readonly T[] };

  const entries: Entry[] = [
    ...standalone.map((session) => ({ kind: 'standalone' as const, session })),
    ...[...grouped.values()].map((groupSessions) => ({
      kind: 'group' as const,
      sessions: [...groupSessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    })),
  ];

  entries.sort((a, b) => {
    const aTime = a.kind === 'standalone' ? a.session.startedAt : (a.sessions[0]?.startedAt ?? '');
    const bTime = b.kind === 'standalone' ? b.session.startedAt : (b.sessions[0]?.startedAt ?? '');
    return bTime.localeCompare(aTime);
  });

  const ordered: T[] = [];
  for (const entry of entries) {
    if (entry.kind === 'standalone') ordered.push(entry.session);
    else ordered.push(...entry.sessions);
  }
  return ordered;
}
