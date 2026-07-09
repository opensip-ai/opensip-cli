/**
 * Narrow display projectors (ADR-0144).
 *
 * Accept already-computed raw scalars only. Callers that aggregate (suite sum,
 * average score, etc.) own that policy and pass the results in.
 */

import { formatDuration } from './duration.js';
import { formatScore } from './score.js';

export interface DurationDisplay {
  readonly durationMs: number;
  readonly durationLabel: string;
}

/**
 * Label a precomputed duration. Echoes the caller-supplied raw number;
 * sanitization for the label is owned by {@link formatDuration}.
 */
export function projectDurationDisplay(durationMs: number): DurationDisplay {
  return {
    durationMs,
    durationLabel: formatDuration(durationMs),
  };
}

export interface SessionDisplayInput {
  readonly durationMs: number;
  readonly score: number;
}

export interface SessionDisplay {
  readonly durationMs: number;
  readonly durationLabel: string;
  readonly score: number;
  readonly scoreLabel: string;
}

/**
 * Labels a precomputed score + duration pair.
 *
 * Use for a single session **or** an already-aggregated suite/run total.
 * Suite sum / average / status / counts are computed upstream.
 */
export function projectSessionDisplay(input: SessionDisplayInput): SessionDisplay {
  return {
    durationMs: input.durationMs,
    durationLabel: formatDuration(input.durationMs),
    score: input.score,
    scoreLabel: formatScore(input.score),
  };
}
