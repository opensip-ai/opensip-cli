/**
 * Structural validation and stored-session aggregation for the checks catalog.
 *
 * Keeping untrusted inlined data handling separate from DOM construction makes
 * the rendering module a presentation boundary rather than a second parser.
 */

/** A check catalog entry (tool domain vocabulary, read structurally). */
export interface CheckEntry {
  slug: string;
  name: string;
  source: string;
  confidence: string;
  tags?: string[];
  longDescription?: string;
}

/** Aggregated run stats for one check, derived from the session payloads. */
export interface CheckStat {
  runs: number;
  passed: number;
  failed: number;
  lastRun: string | null;
}

export interface CheckStatsResult {
  stats: Record<string, CheckStat>;
  malformedSessions: number;
}

function isCheckRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeCheckEntry(value: unknown): CheckEntry | null {
  if (!isCheckRecord(value)) return null;
  const { slug, name, source, confidence } = value;
  if (
    typeof slug !== 'string' ||
    typeof name !== 'string' ||
    typeof source !== 'string' ||
    typeof confidence !== 'string'
  ) {
    return null;
  }
  return {
    slug,
    name,
    source,
    confidence,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    ...(typeof value.longDescription === 'string'
      ? { longDescription: value.longDescription }
      : {}),
  };
}

function accumulateCheckStat(
  value: unknown,
  startedAt: unknown,
  stats: Record<string, CheckStat>,
): boolean {
  if (!isCheckRecord(value) || typeof value.checkSlug !== 'string') return false;
  stats[value.checkSlug] ??= { runs: 0, passed: 0, failed: 0, lastRun: null };
  const stat = stats[value.checkSlug];
  stat.runs++;
  if (value.passed === true) stat.passed++;
  else stat.failed++;
  if (typeof startedAt === 'string' && (!stat.lastRun || startedAt > stat.lastRun)) {
    stat.lastRun = startedAt;
  }
  return true;
}

/** Add one fitness session's stats; return true when its check detail is malformed. */
function accumulateSessionStats(value: unknown, stats: Record<string, CheckStat>): boolean {
  if (!isCheckRecord(value) || value.tool !== 'fit') return false;
  const payload = value.payload;
  if (payload === undefined) return false;
  if (!isCheckRecord(payload)) return true;
  const payloadChecks = payload.checks;
  if (payloadChecks === undefined) return false;
  if (!Array.isArray(payloadChecks)) return true;

  let malformed = false;
  for (const check of payloadChecks) {
    if (!accumulateCheckStat(check, value.startedAt, stats)) malformed = true;
  }
  return malformed;
}

export function computeCheckStats(): CheckStatsResult {
  const stats: Record<string, CheckStat> = {};
  let malformedSessions = 0;
  const injectedSessions: unknown = typeof sessions === 'undefined' ? undefined : sessions;
  const sourceSessions: readonly unknown[] = Array.isArray(injectedSessions)
    ? injectedSessions
    : [];
  for (const session of sourceSessions) {
    if (accumulateSessionStats(session, stats)) malformedSessions++;
  }
  return { stats, malformedSessions };
}
