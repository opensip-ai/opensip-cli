/**
 * Per-tool Zod input field schemas (ADR-0084 §Hardening, Phase 7).
 *
 * Every MCP tool declares a Zod **raw shape** as its `inputSchema`; the SDK
 * validates arguments against it BEFORE the wrapped handler runs, so a malformed
 * `symbolId`, an out-of-range `depth`, or a `..`-traversal `file` is rejected at
 * the trust boundary and never reaches a port. These are the shared field
 * builders each tool composes — validation lives here (the boundary), never in
 * the ports.
 *
 * DTOs carry symbol METADATA only; none of these inputs accept raw file bodies.
 */

import { z } from 'zod';

/** Hard depth cap on bounded adjacency walks (bounds memory). */
export const MAX_DEPTH = 5;
/** Default walk depth when the caller omits it. */
export const DEFAULT_DEPTH = 5;
/** Hard cap on a caller-supplied `limit` (search / dead-code / architecture rows). */
export const MAX_LIMIT = 500;
/** Hard cap on a free-text query length (bounds work; search is substring, not regex → no ReDoS). */
export const MAX_QUERY_LEN = 200;
/** Hard cap on a file-path argument length. */
export const MAX_PATH_LEN = 1024;

/**
 * A `symbolId` in the canonical `"${filePath}:${line}:${column}"` shape. The
 * trailing two colon-groups must be integers; the leading file segment is
 * unconstrained here (the port resolves it — an unknown id is a structured
 * not-found, not a validation error).
 */
export const symbolId = () =>
  z
    .string()
    .min(3)
    .max(MAX_PATH_LEN + 16)
    .regex(/^.+:\d+:\d+$/, 'symbolId must be "<filePath>:<line>:<column>"');

/**
 * A project-relative file path constrained to the project root: no absolute
 * paths, no `..` traversal segments. The graph catalog keys occurrences by
 * project-relative path, so a constrained relative path is also the only thing
 * that can match.
 */
export const filePath = () =>
  z
    .string()
    .min(1)
    .max(MAX_PATH_LEN)
    .refine(
      (p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p),
      'file must be a project-relative path (not absolute)',
    )
    .refine(
      (p) => !p.split(/[\\/]/).includes('..'),
      'file must not contain ".." traversal segments',
    );

/** A 1-based source line number. */
export const line = () => z.number().int().positive();

/** A length-bounded free-text search query (substring match — not a regex). */
export const query = () => z.string().min(1).max(MAX_QUERY_LEN);

/** A walk depth, clamped to `[1, MAX_DEPTH]`, defaulting to {@link DEFAULT_DEPTH}. */
export const depth = () => z.number().int().min(1).max(MAX_DEPTH).default(DEFAULT_DEPTH);

/** An optional result cap, clamped to `[1, MAX_LIMIT]`. */
export const limit = () => z.number().int().positive().max(MAX_LIMIT).optional();

/** A registered-tool id (validated against the live registry in the handler). */
export const toolId = () => z.string().min(1).max(64);

/** A stored suite run id. */
export const suiteRunId = () => z.string().min(1).max(128);

/** A configured suite name. */
export const suiteName = () => z.string().min(1).max(128);

/** A stored session reference or the `latest` sentinel. */
export const sessionRef = () => z.string().min(1).max(128);

/** Severity filter for `get_latest_findings`. */
export const severity = () => z.enum(['errors', 'warnings', 'all']).optional();
