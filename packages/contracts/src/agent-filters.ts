/**
 * Shared agent-filter engine (ADR-0085).
 *
 * Pure transform over SignalEnvelope signals. Used by live runs (fit/graph/sim)
 * and session replay — one implementation, no drift.
 */
import { ConfigurationError, isErrorSeverity } from '@opensip-cli/core';

import type { SignalEnvelope } from './signal-envelope.js';
import type { OptionSpec, Signal, SignalSeverity } from '@opensip-cli/core';

/** Closed vocabulary of agent filter tokens (spec §5.2). */
const KNOWN_FILTER_TOKENS = new Set(['errors-only', 'warnings-only', 'high-impact']);

const HIGH_IMPACT_BLAST_THRESHOLD = 10;

/**
 * Thrown when an agent filter token or `--top` value is malformed. Extends
 * {@link ConfigurationError} so the host error boundary maps a bad live-run
 * filter to `CONFIGURATION_ERROR` (exit 2) — the same clean usage-error exit
 * `graph impact --top` already produces, rather than a generic system error.
 */
export class AgentFilterParseError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentFilterParseError';
  }
}

/**
 * The compact view emitted by a filtered live run (`--filter`/`--top`): the
 * filtered envelope plus the applied tokens and before/after signal counts. The
 * UNFILTERED envelope is still what persists and egresses (filtering is
 * presentation-only).
 */
export interface AgentFilteredResult {
  readonly type: 'agent-filtered';
  readonly envelope: SignalEnvelope;
  readonly filtersApplied: readonly string[];
  readonly originalSignalCount: number;
  readonly returnedSignalCount: number;
}

interface ParsedAgentFilters {
  readonly tokens: readonly string[];
  readonly predicates: readonly ((signal: Signal) => boolean)[];
  readonly topN?: number;
}

function severityRank(severity: SignalSeverity): number {
  if (severity === 'critical' || severity === 'high') return 0;
  if (severity === 'medium') return 1;
  return 2;
}

function parseTopN(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new AgentFilterParseError(`Invalid top value "${value}": must be a non-negative integer`);
  }
  return n;
}

function parseFilterToken(token: string): {
  readonly predicate?: (signal: Signal) => boolean;
  readonly topN?: number;
} {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new AgentFilterParseError('Empty filter token');
  }

  if (trimmed === 'errors-only') {
    return { predicate: (s) => isErrorSeverity(s.severity) };
  }
  if (trimmed === 'warnings-only') {
    return { predicate: (s) => s.severity === 'medium' || s.severity === 'low' };
  }
  if (trimmed === 'high-impact') {
    return {
      predicate: (s) => {
        if (s.metadata.highImpact === true) return true;
        const blast = s.metadata.blast;
        if (typeof blast === 'object' && blast !== null && 'score' in blast) {
          const score = (blast as { score?: unknown }).score;
          return typeof score === 'number' && score >= HIGH_IMPACT_BLAST_THRESHOLD;
        }
        return false;
      },
    };
  }
  if (trimmed.startsWith('category:')) {
    const category = trimmed.slice('category:'.length);
    if (!category) throw new AgentFilterParseError('category: filter requires a name');
    return { predicate: (s) => s.category === category };
  }
  if (trimmed.startsWith('source:')) {
    const source = trimmed.slice('source:'.length);
    if (!source) throw new AgentFilterParseError('source: filter requires a slug');
    return { predicate: (s) => s.source === source };
  }
  if (trimmed.startsWith('file:')) {
    const prefix = trimmed.slice('file:'.length);
    if (!prefix) throw new AgentFilterParseError('file: filter requires a path prefix');
    return { predicate: (s) => s.filePath.startsWith(prefix) };
  }
  if (trimmed.startsWith('top:')) {
    return { topN: parseTopN(trimmed.slice('top:'.length)) };
  }

  if (KNOWN_FILTER_TOKENS.has(trimmed)) {
    return {};
  }

  throw new AgentFilterParseError(
    `Unknown filter token "${trimmed}". Allowed: errors-only, warnings-only, category:<name>, source:<slug>, file:<path>, high-impact, top:<n>`,
  );
}

function parseAgentFilters(filters: readonly string[]): ParsedAgentFilters {
  const predicates: ((signal: Signal) => boolean)[] = [];
  let topN: number | undefined;

  for (const token of filters) {
    const parsed = parseFilterToken(token);
    if (parsed.predicate) predicates.push(parsed.predicate);
    if (parsed.topN !== undefined) topN = parsed.topN;
  }

  return { tokens: filters, predicates, topN };
}

/**
 * Fold `--filter` tokens and optional `--top` into a normalized token list.
 * Appends `top:<n>` when `--top` is present.
 */
export function normalizeAgentRunFilters(
  filter?: readonly string[],
  top?: string,
): readonly string[] {
  const tokens = [...(filter ?? [])];
  if (top !== undefined && top !== '') {
    parseTopN(top);
    tokens.push(`top:${top}`);
  }
  return tokens;
}

/** Apply agent filters to an envelope. Pure — no I/O. */
export function applyAgentFilters(
  envelope: SignalEnvelope,
  filters: readonly string[],
): {
  readonly envelope: SignalEnvelope;
  readonly filtersApplied: readonly string[];
  readonly originalSignalCount: number;
  readonly returnedSignalCount: number;
} {
  const originalSignalCount = envelope.signals.length;
  if (filters.length === 0) {
    return {
      envelope,
      filtersApplied: [],
      originalSignalCount,
      returnedSignalCount: originalSignalCount,
    };
  }

  const parsed = parseAgentFilters(filters);
  let signals = [...envelope.signals];

  for (const predicate of parsed.predicates) {
    signals = signals.filter(predicate);
  }

  if (parsed.topN !== undefined) {
    signals = signals
      .map((s, i) => ({ s, i }))
      .sort((a, b) => {
        const so = severityRank(a.s.severity) - severityRank(b.s.severity);
        return so === 0 ? a.i - b.i : so;
      })
      .slice(0, parsed.topN)
      .map((x) => x.s);
  }

  return {
    envelope: { ...envelope, signals },
    filtersApplied: parsed.tokens,
    originalSignalCount,
    returnedSignalCount: signals.length,
  };
}

/** Build an AgentFilteredResult wrapper for machine output. */
export function buildAgentFilteredResult(
  envelope: SignalEnvelope,
  filters: readonly string[],
): AgentFilteredResult {
  const result = applyAgentFilters(envelope, filters);
  return {
    type: 'agent-filtered',
    envelope: result.envelope,
    filtersApplied: result.filtersApplied,
    originalSignalCount: result.originalSignalCount,
    returnedSignalCount: result.returnedSignalCount,
  };
}

/** Shared run-flag specs for fit/graph/sim agent ergonomics. */
export const agentRunFlagSpecs: readonly OptionSpec[] = [
  {
    flag: '--filter',
    value: '<filter>',
    description:
      'Agent filter (repeatable): errors-only, warnings-only, category:<name>, source:<slug>, file:<path>, high-impact, top:<n>',
    arrayDefault: [],
    parse: (val, prev) => [...(prev as string[]), val],
  },
  {
    flag: '--top',
    value: '<n>',
    description: 'Limit returned signals (sugar for --filter top:<n>)',
  },
  {
    flag: '--raw',
    description: 'Emit unwrapped payload (no CommandOutcome wrapper)',
    default: false,
  },
];
