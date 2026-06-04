/**
 * @fileoverview signal-json formatter (ADR-0011, Phase 2 Task 2.3).
 *
 * The envelope IS the JSON output contract — there is no transform. This
 * single pure formatter replaces the three divergent `CliOutput`-emitting
 * `--json` paths (fitness `buildCliOutput`, graph `json.ts`, sim's bespoke
 * `SimDoneResult`). Consumers keep `--json | jq '.verdict.passed'` /
 * `.verdict.score`; the wire severity is the 4-level `SignalSeverity`.
 *
 * Pure: no IO, no clock, no id generation — stringification only.
 */
import type { Formatter } from './types.js';

/** Serialise the signal envelope as pretty-printed JSON (the wire contract). */
export const formatSignalJson: Formatter = (envelope) => JSON.stringify(envelope, null, 2);
