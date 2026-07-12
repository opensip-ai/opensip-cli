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

import { hasControlCharacter, safeNormalizeProjectRelativePath } from './schema-validation.js';

/** Build a strict SDK input object so unknown MCP arguments are rejected, not stripped. */
export function strictInput<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.strictObject(shape);
}

/** Hard depth cap on bounded adjacency walks (bounds memory). */
export const MAX_DEPTH = 5;
/** Default walk depth when the caller omits it. */
export const DEFAULT_DEPTH = 5;
/** Hard cap on a caller-supplied `limit` (search / dead-code / architecture rows). */
export const MAX_LIMIT = 500;
/** Default page size when the caller omits `limit`. */
export const DEFAULT_LIMIT = 100;
/**
 * Default page size for identity-producing searches (`search_symbols`, and later
 * `search_declarations`). Re-exported from the graph-read port contract so
 * schemas and query collaborators share one constant. Caller range remains 1–500.
 */
export { DEFAULT_IDENTITY_SEARCH_LIMIT } from '../graph-read-port.js';
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
function controlFreeString(max: number, label: string) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacter(value), {
      message: `${label} must not contain control characters`,
    });
}

/** Generic bounded, non-empty, control-free protocol text. */
export const boundedText = (max: number, label = 'value') => controlFreeString(max, label);

interface SymbolIdParts {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
}

function parseSymbolIdParts(value: string): SymbolIdParts | undefined {
  const match = /^(.*):(\d+):(\d+)$/.exec(value);
  return match === null
    ? undefined
    : {
        filePath: match[1] ?? '',
        line: Number(match[2]),
        column: Number(match[3]),
      };
}

function isValidSymbolId(value: string): boolean {
  const parts = parseSymbolIdParts(value);
  return (
    parts !== undefined &&
    parts.filePath.length <= MAX_PATH_LEN &&
    Number.isSafeInteger(parts.line) &&
    parts.line >= 1 &&
    Number.isSafeInteger(parts.column) &&
    safeNormalizeProjectRelativePath(parts.filePath) !== undefined
  );
}

function isValidProjectRelativePath(raw: string): boolean {
  return safeNormalizeProjectRelativePath(raw) !== undefined;
}

/**
 * A `symbolId` in the canonical `"${filePath}:${line}:${column}"` shape. The
 * trailing two colon-groups must be integers and the leading file segment uses
 * the same project-relative trust boundary as file filters.
 */
export const symbolId = () =>
  z
    .string()
    .min(3)
    .max(MAX_PATH_LEN + 40)
    .regex(/^.+:\d+:\d+$/, 'symbolId must be "<filePath>:<line>:<column>"')
    .refine((value) => !hasControlCharacter(value), {
      message: 'symbolId must not contain control characters',
    })
    .refine(
      isValidSymbolId,
      'symbolId file must be a normalized project-relative path without traversal',
    )
    .overwrite((value) => {
      const match = /^(.*):(\d+):(\d+)$/.exec(value);
      if (match === null) return value;
      return `${(match[1] ?? '').replaceAll('\\', '/')}:${match[2] ?? ''}:${match[3] ?? ''}`;
    });

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
    .refine((p) => !hasControlCharacter(p), {
      message: 'file must not contain control characters',
    })
    .refine(
      isValidProjectRelativePath,
      'file must be a normalized project-relative path without traversal',
    )
    .overwrite((raw) => raw.replaceAll('\\', '/'));

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
export const boundedName = (label = 'name') => controlFreeString(MAX_PACKAGE_LEN, label);

/** Package-name specialization for package evidence queries. */
export const packageName = () => boundedName('package');

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

/**
 * Exclusive compact representation for high-volume graph tools (P2 Phase 2.6+).
 * Exactly one of summary / groups / nodes is projected per request.
 */
export const compactDetail = (defaultDetail: 'summary' | 'groups' | 'nodes' = 'nodes') =>
  z.enum(['summary', 'groups', 'nodes']).default(defaultDetail);

/** Traversal identity mode (default occurrence). */
export const traversalIdentity = () =>
  z.enum(['occurrence', 'body-twin-union']).default('occurrence');

/** Symbol search match mode. */
export const searchMatch = () => z.enum(['substring', 'exact', 'qualified']).default('substring');

/** Package edge kind. */
export const packageEdgeKind = () => z.enum(['call', 'import', 'combined']).default('call');

/** Architecture section family selector (unique, non-empty). Default metrics-only. */
export const architectureSections = () =>
  z
    .array(z.enum(['metrics', 'packageEdges', 'hotspots']))
    .min(1)
    .max(3)
    .refine((items) => new Set(items).size === items.length, {
      message: 'sections must be unique',
    })
    .default(['metrics']);

/** Deterministic top-N for architecture ranked families. Default 20, max 100. */
export const architectureTopN = () => z.number().int().min(1).max(100).default(20);

/**
 * Nested sample size per package dependency row (P2 Phase 2.4). Default 0 =
 * count/distribution only; max 5 full evidence samples. Independent of page
 * `limit`. Set `sampleLimit` > 0 to request bounded concrete sites.
 */
export const packageSampleLimit = () => z.number().int().min(0).max(5).default(0);

/**
 * Max concrete evidence sites for why_depends (P2 Phase 2.4). Default 0 =
 * aggregate counts only; max 100. Independent of page `limit`.
 */
export const packageEvidenceLimit = () => z.number().int().min(0).max(100).default(0);

/**
 * Max proof edges per package SCC component (P2 Phase 2.4). Default 0 = members
 * and counts only; max 50. Independent of page `limit`.
 */
export const packageProofLimit = () => z.number().int().min(0).max(50).default(0);

/** Shared source-filter field bag for composing tool schemas. */
export const sourceFilterFields = (defaults: 'discover' | 'production' = 'discover') => ({
  packages: packageArray(),
  filePath: exactFilePath().optional(),
  filePrefix: filePrefix().optional(),
  kinds: kinds(),
  visibilities: visibilities(),
  sourceScope: defaults === 'production' ? productionSourceScope() : sourceScope(),
  generated: defaults === 'production' ? productionGeneratedPolicy() : generatedPolicy(),
});

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
