/**
 * @opensip-cli/format — pure presentation labels (ADR-0144).
 *
 * Labels only — no suite/count/status aggregation. Upstream computes raw facts.
 */

export { formatDuration } from './duration.js';
export { formatScore } from './score.js';
export {
  projectDurationDisplay,
  projectSessionDisplay,
  type DurationDisplay,
  type SessionDisplay,
  type SessionDisplayInput,
} from './project-session.js';
