import { SessionRepo } from './session-repo.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/**
 * A reference to one stored session: an explicit `ref` id, or the sentinel
 * `'latest'` (which requires a `tool` to disambiguate across tools).
 *
 * `cwdWithin` scopes the `'latest'` SELECTION to sessions whose stored `cwd` is
 * inside that root — the newest in-scope session wins over a newer foreign one.
 * It is IGNORED for an explicit id: explicit ids resolve globally, and enforcing
 * their scope is the caller's fail-closed responsibility.
 */
/**
 * Why a session reference could not be resolved to exactly one stored session.
 *
 * Named and exported rather than written inline, so consumers (MCP forwards it to agents) can
 * name the type they are switching over instead of restating the members.
 */
export type SessionResolveReason = 'not-found' | 'wrong-tool' | 'ambiguous-latest';

/**
 * How a caller names the session it wants: the literal `'latest'`, or a specific id, each
 * optionally narrowed by tool and by the project directory the run must sit within.
 */
export type SessionReference =
  | { readonly ref: 'latest'; readonly tool?: ToolShortId; readonly cwdWithin?: string }
  | { readonly ref: string; readonly tool?: ToolShortId; readonly cwdWithin?: string };

/**
 * The outcome of {@link resolveSession}: either the resolved `session`, or a
 * failure carrying a machine-readable `reason` and a human `detail`.
 */
export type SessionResolveResult =
  | { readonly ok: true; readonly session: StoredSession }
  | {
      readonly ok: false;
      readonly reason: SessionResolveReason;
      readonly detail: string;
    };

/**
 * Resolve a {@link SessionReference} against the datastore. `'latest'` returns
 * the most recent session for the given `tool` (and is ambiguous without one),
 * scoped to `cwdWithin` when provided; an explicit id is looked up directly and
 * optionally tool-checked, and IGNORES `cwdWithin` (its scoping is the caller's
 * fail-closed responsibility). Never throws — every failure is a
 * `{ ok: false, reason, detail }` result.
 */
export function resolveSession(
  datastore: DataStore,
  reference: SessionReference,
): SessionResolveResult {
  const repo = new SessionRepo(datastore);
  if (reference.ref === 'latest') {
    if (reference.tool === undefined) {
      return {
        ok: false,
        reason: 'ambiguous-latest',
        detail: 'latest requires --tool fit|graph|sim',
      };
    }
    const session = repo.latest({ tool: reference.tool, cwdWithin: reference.cwdWithin });
    if (session === null) {
      return {
        ok: false,
        reason: 'not-found',
        detail: `no ${reference.tool} session found; run opensip ${reference.tool} first`,
      };
    }
    return { ok: true, session };
  }

  const session = repo.get(reference.ref);
  if (session === null) {
    return {
      ok: false,
      reason: 'not-found',
      detail: `session ${reference.ref} was not found`,
    };
  }
  if (reference.tool !== undefined && session.tool !== reference.tool) {
    return {
      ok: false,
      reason: 'wrong-tool',
      detail: `session ${session.id} is a ${session.tool} session, not ${reference.tool}`,
    };
  }
  return { ok: true, session };
}
