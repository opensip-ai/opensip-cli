function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Per-tool Zod input field schemas (ADR-0084 §Hardening, Phase 7 + MCP Graph Audit).
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
/** Default page size when the caller omits `limit`. */
export const DEFAULT_LIMIT = 100;
/** Hard cap on a free-text query length (bounds work; search is substring, not regex → no ReDoS). */
export const MAX_QUERY_LEN = 200;
/** Hard cap on a file-path argument length. */
export const MAX_PATH_LEN = 1024;
/** Hard cap on a cursor (base64url). */
export const MAX_CURSOR_LEN = 4096;
/** Hard cap on package/tool/command value length. */
export const MAX_PACKAGE_LEN = 256;
/** Max unique packages in a filter array. */
export const MAX_PACKAGE_ARRAY = 50;
/** Max unique kind/visibility enum entries. */
export const MAX_ENUM_ARRAY = 16;
/** Hard visited-node ceiling for graph walks. */
const MAX_WALK_NODES = 2000;
void MAX_WALK_NODES;

function controlFreeString(max: number, label: string) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasControlChar(value), {
      message: `${label} must not contain control characters`,
    });
}

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
    .regex(/^.+:\d+:\d+$/, 'symbolId must be "<filePath>:<line>:<column>"')
    .refine((value) => !hasControlChar(value), {
      message: 'symbolId must not contain control characters',
    });

/**
 * Normalize client slash styles to POSIX project-relative form and reject
 * absolute paths, empty segments, and traversal.
 */
export function normalizeProjectRelativePath(raw: string): string {
  const posix = raw.replaceAll('\\', '/');
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix) || posix.startsWith('//')) {
    throw new Error('file must be a project-relative path (not absolute)');
  }
  const segments = posix.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('file must not contain empty, ".", or ".." path segments');
  }
  return posix;
}

/**
 * A project-relative file path constrained to the project root: no absolute
 * paths, no `..` traversal segments. Accepts either slash style and normalizes
 * to POSIX. Shared by exact `filePath` and segment `filePrefix` fields.
 */
export const filePath = () =>
  z
    .string()
    .min(1)
    .max(MAX_PATH_LEN)
    .refine((p) => !hasControlChar(p), {
      message: 'file must not contain control characters',
    })
    .transform((raw, ctx) => {
      try {
        return normalizeProjectRelativePath(raw);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'invalid file path',
        });
        return z.NEVER;
      }
    });

/** Exact project-relative path filter (alias of {@link filePath}). */
export const exactFilePath = () => filePath();

/** Segment-aware path prefix filter (same trust boundary as {@link filePath}). */
export const filePrefix = () => filePath();

/** A 1-based source line number. */
export const line = () => z.number().int().positive();

/** A length-bounded free-text search query (substring match — not a regex). */
export const query = () => controlFreeString(MAX_QUERY_LEN, 'query');

/** A walk depth, clamped to `[1, MAX_DEPTH]`, defaulting to {@link DEFAULT_DEPTH}. */
export const depth = () => z.number().int().min(1).max(MAX_DEPTH).default(DEFAULT_DEPTH);

/** An optional result cap, clamped to `[1, MAX_LIMIT]`. */
export const limit = () => z.number().int().positive().max(MAX_LIMIT).optional();

/**
 * Page limit with default 100 and max 500. Use when a tool always pages.
 */
export const pageLimit = () => z.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT);

/** Opaque base64url cursor (decoded/bound in the page helper). */
export const cursor = () =>
  z
    .string()
    .min(1)
    .max(MAX_CURSOR_LEN)
    .regex(/^[A-Za-z0-9_-]+$/, 'cursor must be base64url')
    .optional();

/** Package / tool / command name value. */
export const packageName = () => controlFreeString(MAX_PACKAGE_LEN, 'package');

/** Bounded unique package list (max 50). */
export const packageArray = () =>
  z
    .array(packageName())
    .max(MAX_PACKAGE_ARRAY)
    .refine((items) => new Set(items).size === items.length, {
      message: 'packages must be unique',
    })
    .optional();

const FUNCTION_KINDS = [
  'function-declaration',
  'function-expression',
  'arrow',
  'method',
  'constructor',
  'getter',
  'setter',
  'module-init',
] as const;

const VISIBILITIES = ['exported', 'module-local', 'private'] as const;

/** Optional kind filter (max 16 unique declared enums). */
export const kinds = () =>
  z
    .array(z.enum(FUNCTION_KINDS))
    .max(MAX_ENUM_ARRAY)
    .refine((items) => new Set(items).size === items.length, {
      message: 'kinds must be unique',
    })
    .optional();

/** Optional visibility filter. */
export const visibilities = () =>
  z
    .array(z.enum(VISIBILITIES))
    .max(MAX_ENUM_ARRAY)
    .refine((items) => new Set(items).size === items.length, {
      message: 'visibilities must be unique',
    })
    .optional();

/** Source scope: production / test / all. */
export const sourceScope = () => z.enum(['production', 'test', 'all']).default('all');

/** Generated-file policy. */
export const generatedPolicy = () => z.enum(['exclude', 'include', 'only']).default('include');

/** Production-default source scope (architecture/package tools). */
export const productionSourceScope = () =>
  z.enum(['production', 'test', 'all']).default('production');

/** Production-default generated policy. */
export const productionGeneratedPolicy = () =>
  z.enum(['exclude', 'include', 'only']).default('exclude');

/** Grouping mode for paged results. */
export const groupBy = () => z.enum(['none', 'package', 'file']).default('none');

/** Traversal identity mode (default occurrence). */
export const traversalIdentity = () =>
  z.enum(['occurrence', 'body-twin-union']).default('occurrence');

/** Symbol search match mode. */
// Reserved for Phase 4 search match mode wiring on handlers.
const _searchMatch = () => z.enum(['substring', 'exact', 'qualified']).default('substring');
void _searchMatch;

/** Package edge kind. */
export const packageEdgeKind = () => z.enum(['call', 'import', 'combined']).default('call');

/** Shared source-filter field bag for composing tool schemas. */
const sourceFilterFields = (defaults: 'discover' | 'production' = 'discover') => ({
  packages: packageArray(),
  filePath: exactFilePath().optional(),
  filePrefix: filePrefix().optional(),
  kinds: kinds(),
  visibilities: visibilities(),
  sourceScope: defaults === 'production' ? productionSourceScope() : sourceScope(),
  generated: defaults === 'production' ? productionGeneratedPolicy() : generatedPolicy(),
});
void sourceFilterFields;

/** Shared page/group field bag. */
export const pageFields = () => ({
  limit: pageLimit(),
  cursor: cursor(),
  groupBy: groupBy(),
});

/** A registered-tool id (validated against the live registry in the handler). */
export const toolId = () => controlFreeString(64, 'tool');

/** A stored suite run id. */
export const suiteRunId = () => controlFreeString(128, 'suiteRunId');

/** A configured suite name. */
export const suiteName = () => controlFreeString(128, 'suiteName');

/** A stored session reference or the `latest` sentinel. */
export const sessionRef = () => controlFreeString(128, 'sessionRef');

/** Severity filter for `get_latest_findings`. */
export const severity = () => z.enum(['errors', 'warnings', 'all']).optional();
